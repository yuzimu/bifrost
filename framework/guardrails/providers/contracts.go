// Package providers implements external guardrail protocols without importing the parent engine.
package providers

import (
	"context"
	"encoding/json"
	"errors"
)

var (
	ErrInvalidConfig     = errors.New("guardrail provider: invalid configuration")
	ErrInvalidInput      = errors.New("guardrail provider: invalid input")
	ErrProvider          = errors.New("guardrail provider: request failed")
	ErrInvalidResponse   = errors.New("guardrail provider: invalid response")
	ErrUnsupportedStream = errors.New("guardrail provider: complete buffered output required")
	ErrSkipped           = errors.New("guardrail provider: text-only output stream intentionally skipped")
)

type Adapter interface {
	Validate(json.RawMessage) error
	Capabilities() Capabilities
	Evaluate(context.Context, json.RawMessage, Input) (Result, error)
}

type Capabilities struct {
	Input                    bool
	Output                   bool
	CanBlock                 bool
	CanRedact                bool
	Transforms               bool
	ToolContext              bool
	OutputRequiresFullBuffer bool
	SkipTextOnlyOutputStream bool
}

// Scope 仅接收宿主已认证的元数据；Headers 不会直接转发为 HTTP 请求头。
type Scope struct {
	Headers   map[string]string
	Model     string
	Provider  string
	RequestID string
}

type Input struct {
	Phase        string
	Texts        []string
	Scope        Scope
	Messages     []Message
	Tools        []Tool
	PlainText    bool // 仅真实普通文本请求可设为 true；Chat/Responses 必须提供结构化消息。
	Streaming    bool
	Complete     bool // 宿主已缓冲完整输出，且尚未向客户端释放待保护内容。
	HasToolCalls bool
}

// Message.TextIndex 指向可改写的完整文本；nil 表示只读上下文，不允许改写。
type Message struct {
	Role       string     `json:"role"`
	Content    string     `json:"content"`
	ToolCalls  []ToolCall `json:"tool_calls,omitempty"`
	ToolCallID string     `json:"tool_call_id,omitempty"`
	TextIndex  *int       `json:"-"`
}

type ToolCall struct {
	ID       string       `json:"id"`
	Type     string       `json:"type"`
	Function FunctionCall `json:"function"`
}

type FunctionCall struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

type Tool struct {
	Type     string         `json:"type"`
	Function ToolDefinition `json:"function"`
}

type ToolDefinition struct {
	Name        string          `json:"name"`
	Description string          `json:"description,omitempty"`
	Parameters  json.RawMessage `json:"parameters,omitempty"`
}

// Finding 的 Start/End 为对应 TextIndex 上的 UTF-8 字节半开区间。
type Finding struct {
	TextIndex int
	Start     int
	End       int
	Entity    string
	Action    string
	Strategy  string
	Mode      string
}

type Rewrite struct {
	Index       int
	Original    string
	Replacement string
}

type Result struct {
	Blocked  bool
	Findings []Finding
	Rewrites []Rewrite
	Reason   string // 仅含静态说明，不包含上游原文、令牌或命中内容。
}
