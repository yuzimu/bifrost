package guardrails

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/google/cel-go/cel"
	"github.com/maximhq/bifrost/framework/configstore"
	"github.com/maximhq/bifrost/framework/configstore/tables"
	"github.com/tidwall/gjson"
	gitleaksconfig "github.com/zricethezav/gitleaks/v8/config"
)

type compiledPattern struct {
	pattern Pattern
	re      *regexp.Regexp
}

type compiledProfile struct {
	profile       Profile
	patterns      []compiledPattern
	ignored       []string
	prompt        *PromptConfig
	adapter       Adapter
	caps          Capabilities
	secrets       *gitleaksconfig.Config
	secretOptions Pattern
}

type compiledRule struct {
	rule    Rule
	program cel.Program
}

type snapshot struct {
	config   Config
	profiles map[uint]*compiledProfile
	rules    []compiledRule
}

type Plugin struct {
	current    atomic.Pointer[snapshot]
	mu         sync.Mutex
	deps       Dependencies
	requests   sync.Map
	redactions sync.Map
}

// decodeStrict 拒绝未知字段和尾随 JSON，错误不回显配置内容。
func decodeStrict(data []byte, dst any) error {
	if err := validateJSON(data); err != nil {
		return err
	}
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if err := d.Decode(dst); err != nil {
		return errors.New("配置格式错误或包含未知字段")
	}
	var tail any
	if err := d.Decode(&tail); err != io.EOF {
		return errors.New("配置包含多余 JSON 数据")
	}
	return nil
}

// DecodeJSON 提供管理 handler 共享的严格 JSON 边界，不泄露原始配置内容。
func DecodeJSON(data []byte, dst any) error {
	return decodeStrict(data, dst)
}

// validateJSON 拒绝重复字段及过深嵌套，避免跨 parser 的 last-key 歧义。
func validateJSON(data []byte) error {
	if !gjson.ValidBytes(data) {
		return errors.New("JSON 格式无效")
	}
	var walk func(gjson.Result, int) error
	walk = func(node gjson.Result, depth int) error {
		if depth > 64 {
			return errors.New("JSON 嵌套超过上限")
		}
		if !node.IsObject() && !node.IsArray() {
			return nil
		}
		seen := make(map[string]bool)
		var err error
		node.ForEach(func(key, value gjson.Result) bool {
			if node.IsObject() {
				if seen[key.String()] {
					err = errors.New("JSON 包含重复字段")
					return false
				}
				seen[key.String()] = true
			}
			err = walk(value, depth+1)
			return err == nil
		})
		return err
	}
	return walk(gjson.ParseBytes(data), 0)
}

// DecodeConfig 将插件配置转换为严格的公开配置类型。
func DecodeConfig(value any) (*Config, error) {
	if value == nil {
		return &Config{}, nil
	}
	data, err := json.Marshal(value)
	if err != nil {
		return nil, errors.New("无法解析配置")
	}
	var cfg Config
	if err := decodeStrict(data, &cfg); err != nil {
		return nil, err
	}
	return &cfg, nil
}

// PluginInit 编译完整配置后才发布不可变快照，不访问数据库或外部评判服务。
func PluginInit(cfg *Config, deps Dependencies) (*Plugin, error) {
	p := &Plugin{deps: deps}
	p.deps.Adapters = NewExternalAdapters()
	for name, adapter := range deps.Adapters {
		if adapter != nil {
			p.deps.Adapters[name] = adapter
		}
	}
	if p.deps.StreamRewriter == nil {
		p.deps.StreamRewriter = NewStreamTextRewriter()
	}
	if cfg == nil {
		cfg = &Config{}
	}
	s, err := p.compile(*cfg)
	if err != nil {
		return nil, err
	}
	p.current.Store(s)
	return p, nil
}

// Config 返回独立副本，调用者不能修改正在使用的规则。
func (p *Plugin) Config() Config {
	data, _ := json.Marshal(p.current.Load().config)
	var cfg Config
	_ = json.Unmarshal(data, &cfg)
	return cfg
}

// ReplaceConfig 先验证再保存，保存失败或配置错误均保留最后有效快照。
func (p *Plugin) ReplaceConfig(ctx context.Context, cfg Config) error {
	return p.ChangeConfig(ctx, func(current *Config) error {
		*current = cfg
		return nil
	})
}

// ChangeConfig 串行执行管理变更，避免同一进程并发 CRUD 丢失更新。
func (p *Plugin) ChangeConfig(ctx context.Context, change func(*Config) error) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	cfg := p.Config()
	if err := change(&cfg); err != nil {
		return err
	}
	s, err := p.compile(cfg)
	if err != nil {
		return err
	}
	if p.deps.ConfigStore == nil {
		return errors.New("未配置持久化存储")
	}
	row, err := p.deps.ConfigStore.GetPlugin(ctx, PluginName)
	if err != nil && !errors.Is(err, configstore.ErrNotFound) {
		return errors.New("读取护栏配置失败")
	}
	if errors.Is(err, configstore.ErrNotFound) {
		row = &tables.TablePlugin{Name: PluginName}
	}
	row.Config = s.config
	row.Enabled = s.config.Enabled
	if err := p.deps.ConfigStore.UpsertPlugin(ctx, row); err != nil {
		return errors.New("保存护栏配置失败")
	}
	p.current.Store(s)
	return nil
}

// compile 深拷贝并验证所有配置，包括禁用项，拒绝不支持的 provider。
func (p *Plugin) compile(cfg Config) (*snapshot, error) {
	data, err := json.Marshal(cfg)
	if err != nil {
		return nil, errors.New("配置不可序列化")
	}
	if err := decodeStrict(data, &cfg); err != nil {
		return nil, err
	}
	if len(cfg.Rules) > 256 || len(cfg.Providers) > 256 {
		return nil, errors.New("规则或配置数量超过 256")
	}
	s := &snapshot{config: cfg, profiles: make(map[uint]*compiledProfile)}
	for i := range s.config.Providers {
		profile := s.config.Providers[i]
		if err := rejectRawCredentials(profile.Config); err != nil {
			return nil, err
		}
		if profile.ID == 0 || strings.TrimSpace(profile.PolicyName) == "" || profile.Timeout < 0 || profile.Timeout > 3600 {
			return nil, errors.New("配置 ID、名称或超时无效")
		}
		if _, exists := s.profiles[profile.ID]; exists {
			return nil, errors.New("配置 ID 重复")
		}
		cp, err := p.compileProfile(profile)
		if err != nil {
			return nil, fmt.Errorf("配置 %d: %w", profile.ID, err)
		}
		s.profiles[profile.ID] = cp
	}
	seen := make(map[uint]bool)
	for i := range s.config.Rules {
		r := &s.config.Rules[i]
		if r.Target == "" {
			r.Target = "llm"
		}
		if r.EvaluationMode == "" {
			r.EvaluationMode = "bundled"
		}
		if r.Timeout == 0 {
			r.Timeout = 60
		}
		if r.SamplingRate == nil {
			value := 100
			r.SamplingRate = &value
		}
		if r.ID == 0 || seen[r.ID] || strings.TrimSpace(r.Name) == "" {
			return nil, errors.New("规则 ID 或名称无效")
		}
		seen[r.ID] = true
		if r.Target != "llm" && r.Target != "mcp" || r.ApplyTo != "input" && r.ApplyTo != "output" && r.ApplyTo != "both" {
			return nil, errors.New("规则 target 或 apply_to 无效")
		}
		if *r.SamplingRate < 0 || *r.SamplingRate > 100 || r.Timeout < 1 || r.Timeout > 3600 || r.MaxTurnsToSend < 0 || r.StreamReplayEventIntervalMS < 0 || r.StreamReplayEventIntervalMS > 1000 {
			return nil, errors.New("规则采样、超时、会话或回放配置无效")
		}
		if r.EvaluationMode != "bundled" && r.EvaluationMode != "per_turn" {
			return nil, errors.New("未知 evaluation_mode")
		}
		if len(r.ProviderConfigIDs) == 0 {
			return nil, errors.New("规则必须关联配置")
		}
		linked := make(map[uint]bool)
		for _, id := range r.ProviderConfigIDs {
			if s.profiles[id] == nil || linked[id] {
				return nil, errors.New("关联配置不存在或重复")
			}
			linked[id] = true
		}
		program, err := compileCEL(*r)
		if err != nil {
			return nil, fmt.Errorf("规则 %d: %w", r.ID, err)
		}
		s.rules = append(s.rules, compiledRule{rule: *r, program: program})
	}
	return s, nil
}

// compileCEL 将目标变量隔离并限制执行成本，不接受非布尔表达式。
func compileCEL(r Rule) (cel.Program, error) {
	opts := []cel.EnvOption{
		cel.CrossTypeNumericComparisons(true),
		cel.Variable("headers", cel.MapType(cel.StringType, cel.StringType)),
		cel.Variable("virtual_key", cel.StringType), cel.Variable("customer", cel.StringType),
		cel.Variable("team", cel.StringType), cel.Variable("user", cel.StringType),
	}
	if r.Target == "llm" {
		opts = append(opts, cel.Variable("model", cel.StringType), cel.Variable("provider", cel.StringType), cel.Variable("params", cel.MapType(cel.StringType, cel.DynType)))
	} else {
		opts = append(opts, cel.Variable("mcp_client", cel.StringType), cel.Variable("mcp_tool", cel.StringType), cel.Variable("mcp_arguments", cel.MapType(cel.StringType, cel.DynType)))
	}
	env, err := cel.NewEnv(opts...)
	if err != nil {
		return nil, errors.New("无法初始化 CEL")
	}
	if len(r.CELExpression) > 8192 {
		return nil, errors.New("CEL 表达式过长")
	}
	ast, issues := env.Compile(r.CELExpression)
	if issues.Err() != nil || ast.OutputType() != cel.BoolType {
		return nil, errors.New("CEL 表达式无效、变量越界或结果非布尔")
	}
	return env.Program(ast, cel.CostLimit(10000), cel.InterruptCheckFrequency(100))
}
