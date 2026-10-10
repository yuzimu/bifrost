package guardrails

import (
	"context"
	"encoding/json"

	"github.com/maximhq/bifrost/core/schemas"
	"github.com/maximhq/bifrost/framework/configstore"
	external "github.com/maximhq/bifrost/framework/guardrails/providers"
)

const PluginName = "guardrails"

type Config struct {
	Enabled   bool      `json:"enabled"`
	Providers []Profile `json:"guardrail_providers"`
	Rules     []Rule    `json:"guardrail_rules"`
}

type Profile struct {
	ID           uint            `json:"id"`
	ProviderName string          `json:"provider_name"`
	PolicyName   string          `json:"policy_name"`
	Enabled      bool            `json:"enabled"`
	Timeout      int             `json:"timeout,omitempty"`
	Config       json.RawMessage `json:"config"`
}

type Rule struct {
	ID                          uint   `json:"id"`
	Name                        string `json:"name"`
	Description                 string `json:"description,omitempty"`
	Enabled                     bool   `json:"enabled"`
	Target                      string `json:"target,omitempty"`
	CELExpression               string `json:"cel_expression"`
	ApplyTo                     string `json:"apply_to"`
	SamplingRate                *int   `json:"sampling_rate,omitempty"`
	Timeout                     int    `json:"timeout,omitempty"`
	SendAllConversationTurns    *bool  `json:"send_all_conversation_turns,omitempty"`
	MaxTurnsToSend              int    `json:"max_turns_to_send,omitempty"`
	EvaluationMode              string `json:"evaluation_mode,omitempty"`
	StreamReplayEventIntervalMS int    `json:"stream_replay_event_interval_ms,omitempty"`
	ProviderConfigIDs           []uint `json:"provider_config_ids"`
}

type Pattern struct {
	Pattern           string `json:"pattern"`
	Description       string `json:"description,omitempty"`
	EntityType        string `json:"entity_type,omitempty"`
	Flags             string `json:"flags,omitempty"`
	Action            string `json:"action,omitempty"`
	RedactionStrategy string `json:"redaction_strategy,omitempty"`
	RedactionMode     string `json:"redaction_mode,omitempty"`
}

type RegexConfig struct {
	Patterns []Pattern `json:"patterns"`
	Timeout  int       `json:"timeout,omitempty"`
}

type SecretsConfig struct {
	IgnoredSecretKeywords []string `json:"ignored_secret_keywords,omitempty"`
	Action                string   `json:"action,omitempty"`
	RedactionStrategy     string   `json:"redaction_strategy,omitempty"`
	RedactionMode         string   `json:"redaction_mode,omitempty"`
	Timeout               int      `json:"timeout,omitempty"`
}

type PromptConfig struct {
	JudgeProvider   string `json:"judge_provider"`
	JudgeModel      string `json:"judge_model"`
	Rule            string `json:"rule"`
	PromptTemplate  string `json:"prompt_template,omitempty"`
	Timeout         int    `json:"timeout,omitempty"`
	MaxOutputTokens int    `json:"max_output_tokens,omitempty"`
}

// Scope 只接收宿主已认证的身份和允许参与规则匹配的请求元数据。
type Scope struct {
	Headers      map[string]string
	Params       map[string]any
	VirtualKey   string
	Customer     string
	Team         string
	User         string
	Model        string
	Provider     string
	MCPClient    string
	MCPTool      string
	MCPArguments map[string]any
}

type ScopeResolver func(*schemas.BifrostContext) (Scope, error)

// ChatExecutor 必须使用已配置的宿主模型，并跳过 guardrails 防止评判递归。
type ChatExecutor interface {
	ValidateJudge(context.Context, PromptConfig) error
	ExecuteChat(context.Context, *schemas.BifrostChatRequest) (*schemas.BifrostChatResponse, error)
}

// ResponsesExecutor 由真实宿主提供，只在 Chat 明确不支持时切换协议。
type ResponsesExecutor interface {
	ExecuteResponses(context.Context, *schemas.BifrostResponsesRequest) (*schemas.BifrostResponsesResponse, error)
}

// StreamTextRewriter 由宿主维护原生协议，必须同时重写 gate 缓冲及尚未入 gate 的终态事件。
// Rewrite 返回前不得释放缓冲；只允许修改 TextRewrite 指定的文本及其 delta/terminal 副本。
type StreamTextRewriter interface {
	ValidateRequest(*schemas.BifrostContext, *schemas.BifrostRequest) error
	Rewrite(*schemas.BifrostContext, *schemas.BifrostResponse, *schemas.BifrostResponse, []schemas.TextRewrite) (*schemas.BifrostResponse, error)
}

// Adapter 校验和执行均由真实 provider 实现；不得返回模拟安全判定。
type Adapter interface {
	Validate(json.RawMessage) error
	Capabilities() Capabilities
	Evaluate(context.Context, json.RawMessage, Evaluation) (AdapterResult, error)
}

type Capabilities struct {
	CanBlock                 bool `json:"can_block"`
	CanRedact                bool `json:"can_redact"`
	Transforms               bool `json:"transforms"`
	Input                    bool `json:"input"`
	Output                   bool `json:"output"`
	ToolContext              bool `json:"tool_context"`
	OutputRequiresFullBuffer bool `json:"output_requires_full_buffer"`
	SkipTextOnlyOutputStream bool `json:"skip_text_only_output_stream"`
}

type Evaluation struct {
	Phase        string
	Target       string
	Texts        []string
	Scope        Scope
	RequestID    string
	Messages     []external.Message
	Tools        []external.Tool
	PlainText    bool
	Streaming    bool
	Complete     bool
	HasToolCalls bool
}

// Finding 使用 UTF-8 字节偏移，只能引用对应 TextIndex 的完整字符边界。
type Finding struct {
	TextIndex int    `json:"text_index"`
	Start     int    `json:"start"`
	End       int    `json:"end"`
	Entity    string `json:"entity_type"`
	Action    string `json:"action"`
	Strategy  string `json:"redaction_strategy,omitempty"`
	Mode      string `json:"redaction_mode,omitempty"`
}

type AdapterResult struct {
	Blocked  bool
	Findings []Finding
	Rewrites []schemas.TextRewrite
	Skipped  bool
	Reason   string
}

type Dependencies struct {
	ConfigStore    configstore.ConfigStore
	ChatExecutor   ChatExecutor
	ScopeResolver  ScopeResolver
	Adapters       map[string]Adapter
	StreamRewriter StreamTextRewriter
}

// Result 的公开判定不包含原始命中值；脱敏映射仅供宿主日志链路使用。
type Result struct {
	Blocked             bool                              `json:"blocked"`
	Reason              string                            `json:"reason,omitempty"`
	Texts               []string                          `json:"texts"`
	Metadata            *schemas.BifrostGuardrailMetadata `json:"metadata,omitempty"`
	Rewrites            []schemas.TextRewrite             `json:"-"`
	Redaction           schemas.RedactionData             `json:"-"`
	RuntimeReplacements map[string]string                 `json:"-"`
}
