// Package resilience owns process-local adaptive routing and circuit state.
package resilience

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"time"

	providerUtils "github.com/maximhq/bifrost/core/providers/utils"
)

const PluginName = "resilience"

type AdaptiveConfig struct {
	DirectionSelectionEnabled bool `json:"direction_selection_enabled"`
	RouteSelectionEnabled     bool `json:"route_selection_enabled"`
	AppendFallbacksToPinned   bool `json:"append_fallbacks_to_pinned"`
	RerouteFailedDirections   bool `json:"reroute_failed_directions"`
	PruneFailedFallbacks      bool `json:"prune_failed_fallbacks"`
}

type Signal struct {
	Source         string  `json:"source"`
	HeaderName     string  `json:"header_name"`
	HeaderValue    *string `json:"header_value,omitempty"`
	HeaderContains *string `json:"header_contains,omitempty"`
}

type Condition struct {
	Operator string   `json:"operator,omitempty"`
	Signals  []Signal `json:"signals,omitempty"`
}

type Policy struct {
	Name             string    `json:"name"`
	Enabled          *bool     `json:"enabled,omitempty"`
	PrimaryProvider  string    `json:"primary_provider"`
	PrimaryModel     string    `json:"primary_model"`
	PrimaryKeyIDs    []string  `json:"primary_key_ids,omitempty"`
	FallbackProvider string    `json:"fallback_provider,omitempty"`
	FallbackModel    string    `json:"fallback_model,omitempty"`
	Condition        Condition `json:"condition"`
	DefaultCooldown  string    `json:"default_cooldown,omitempty"`
	CooldownHeader   string    `json:"cooldown_header,omitempty"`
}

// UnmarshalJSON 严格保留字段边界，将整数纳秒规范化为运行时使用的 duration 字符串。
func (p *Policy) UnmarshalJSON(data []byte) error {
	type policyAlias Policy
	next := policyAlias(*p)
	wire := struct {
		*policyAlias
		DefaultCooldown json.RawMessage `json:"default_cooldown"`
	}{policyAlias: &next}
	if err := DecodeStrict(data, &wire); err != nil {
		return err
	}
	raw := bytes.TrimSpace(wire.DefaultCooldown)
	if len(raw) > 0 {
		if raw[0] == '"' {
			if err := json.Unmarshal(raw, &next.DefaultCooldown); err != nil {
				return fmt.Errorf("default_cooldown: expected a duration string")
			}
		} else {
			var nanoseconds int64
			if err := json.Unmarshal(raw, &nanoseconds); err != nil || nanoseconds < 0 {
				return fmt.Errorf("default_cooldown: expected a duration string or non-negative integer nanoseconds")
			}
			next.DefaultCooldown = time.Duration(nanoseconds).String()
		}
	}
	*p = Policy(next)
	return nil
}

type CircuitBreakerConfig struct {
	Policies []Policy `json:"policies"`
}

type Config struct {
	LoadBalancer   AdaptiveConfig       `json:"load_balancer_config"`
	CircuitBreaker CircuitBreakerConfig `json:"circuit_breaker_config"`
}

type compiledPolicy struct {
	Policy
	cooldown time.Duration
}

type compiledConfig struct {
	config   Config
	policies []compiledPolicy
}

func DefaultConfig() Config {
	return Config{LoadBalancer: AdaptiveConfig{DirectionSelectionEnabled: true, RouteSelectionEnabled: true},
		CircuitBreaker: CircuitBreakerConfig{Policies: []Policy{}}}
}

// DecodeConfig 严格拒绝未知字段和多个 JSON 文档；缺省开关保持公开默认值。
func DecodeConfig(data []byte) (Config, error) {
	cfg := DefaultConfig()
	if err := DecodeStrict(data, &cfg); err != nil {
		return Config{}, err
	}
	if _, err := compileConfig(cfg); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

// DecodeStrict 用于管理 API，避免无效字段被静默忽略。
func DecodeStrict(data []byte, target any) error {
	if trimmed := bytes.TrimSpace(data); len(trimmed) == 0 || trimmed[0] != '{' {
		return fmt.Errorf("expected a JSON object")
	}
	tokens := json.NewDecoder(bytes.NewReader(data))
	for {
		token, err := tokens.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		if token == nil {
			return fmt.Errorf("null is not valid in resilience configuration")
		}
	}
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if err := d.Decode(target); err != nil {
		return err
	}
	if err := d.Decode(new(any)); err != io.EOF {
		return fmt.Errorf("expected a single JSON object")
	}
	return nil
}

// compileConfig 深拷贝并预编译策略，发布后调用者不能修改运行中的配置。
func compileConfig(cfg Config) (*compiledConfig, error) {
	raw, err := providerUtils.MarshalSorted(cfg)
	if err != nil {
		return nil, err
	}
	var owned Config
	if err := json.Unmarshal(raw, &owned); err != nil {
		return nil, err
	}
	out := &compiledConfig{config: owned}
	names := make(map[string]bool)
	for i, policy := range owned.CircuitBreaker.Policies {
		field := fmt.Sprintf("circuit_breaker_config.policies[%d]", i)
		nameKey := strings.ToLower(policy.Name)
		if policy.Name == "" || strings.ContainsRune(policy.Name, '\x00') || names[nameKey] || policy.PrimaryProvider == "" || policy.PrimaryModel == "" {
			return nil, fmt.Errorf("%s: unique name, primary_provider and primary_model are required", field)
		}
		names[nameKey] = true
		if policy.Enabled == nil {
			enabled := true
			policy.Enabled = &enabled
		}
		if policy.FallbackProvider == "" || policy.FallbackModel == "" {
			return nil, fmt.Errorf("%s: fallback_provider and fallback_model are required", field)
		}
		if policy.Condition.Operator == "" {
			policy.Condition.Operator = "OR"
		}
		if policy.Condition.Operator != "OR" && policy.Condition.Operator != "AND" {
			return nil, fmt.Errorf("%s.condition.operator: expected OR or AND", field)
		}
		if policy.DefaultCooldown == "" {
			policy.DefaultCooldown = "30s"
		}
		cooldown, e1 := time.ParseDuration(policy.DefaultCooldown)
		if e1 != nil || cooldown < 0 {
			return nil, fmt.Errorf("%s.default_cooldown: expected a non-negative Go duration", field)
		}
		if len(policy.Condition.Signals) == 0 {
			return nil, fmt.Errorf("%s.condition.signals: at least one signal is required", field)
		}
		for j, signal := range policy.Condition.Signals {
			if signal.Source != "response_header" || signal.HeaderName == "" ||
				(signal.HeaderValue != nil && signal.HeaderContains != nil) {
				return nil, fmt.Errorf("%s.condition.signals[%d]: invalid header signal", field, j)
			}
		}
		seen := make(map[string]bool)
		for _, id := range policy.PrimaryKeyIDs {
			if id == "" || seen[id] {
				return nil, fmt.Errorf("%s.primary_key_ids: empty or duplicate key id", field)
			}
			seen[id] = true
		}
		cp := compiledPolicy{Policy: policy, cooldown: cooldown}
		out.policies = append(out.policies, cp)
		out.config.CircuitBreaker.Policies[i] = policy
	}
	return out, nil
}
