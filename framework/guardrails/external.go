package guardrails

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"

	"github.com/maximhq/bifrost/core/schemas"
	external "github.com/maximhq/bifrost/framework/guardrails/providers"
)

type externalAdapter struct{ adapter external.Adapter }

// NewExternalAdapters 只桥接子包实际注册的实现，不为未实现厂商生成占位项。
func NewExternalAdapters() map[string]Adapter {
	registry := external.NewAdapters()
	for name, adapter := range external.NewCloudAdapters() {
		registry[name] = adapter
	}
	adapters := make(map[string]Adapter, len(registry))
	for name, adapter := range registry {
		adapters[name] = externalAdapter{adapter}
	}
	return adapters
}

func (a externalAdapter) Validate(raw json.RawMessage) error {
	if err := validateJSON(raw); err != nil {
		return err
	}
	if err := rejectRawCredentials(raw); err != nil {
		return err
	}
	return a.adapter.Validate(raw)
}

func (a externalAdapter) Capabilities() Capabilities {
	c := a.adapter.Capabilities()
	return Capabilities{CanBlock: c.CanBlock, CanRedact: c.CanRedact, Transforms: c.Transforms,
		Input: c.Input, Output: c.Output, ToolContext: c.ToolContext,
		OutputRequiresFullBuffer: c.OutputRequiresFullBuffer, SkipTextOnlyOutputStream: c.SkipTextOnlyOutputStream}
}

// Evaluate 保持 phase、工具边界和原始行索引；跳过不等同于安全判定。
func (a externalAdapter) Evaluate(ctx context.Context, raw json.RawMessage, ev Evaluation) (AdapterResult, error) {
	caps := a.adapter.Capabilities()
	if ev.Phase == "input" && !caps.Input || ev.Phase == "output" && !caps.Output {
		return AdapterResult{}, errors.New("provider 不支持该评估阶段")
	}
	if ev.Target == "mcp" && !caps.ToolContext {
		return AdapterResult{}, errors.New("provider 不支持 MCP 工具上下文")
	}
	in := external.Input{Phase: ev.Phase, Texts: ev.Texts,
		Scope:    external.Scope{Headers: ev.Scope.Headers, Model: ev.Scope.Model, Provider: ev.Scope.Provider, RequestID: ev.RequestID},
		Messages: ev.Messages, Tools: ev.Tools, PlainText: ev.PlainText,
		Streaming: ev.Streaming, Complete: ev.Complete, HasToolCalls: ev.HasToolCalls}
	out, err := a.adapter.Evaluate(ctx, raw, in)
	if errors.Is(err, external.ErrSkipped) {
		return AdapterResult{Skipped: true, Reason: "provider_stream_skipped"}, nil
	}
	if err != nil {
		return AdapterResult{}, errors.New("外部护栏评估失败")
	}
	result := AdapterResult{Blocked: out.Blocked, Reason: "provider_policy_decision"}
	for _, f := range out.Findings {
		result.Findings = append(result.Findings, Finding{TextIndex: f.TextIndex, Start: f.Start, End: f.End,
			Entity: f.Entity, Action: f.Action, Strategy: f.Strategy, Mode: f.Mode})
	}
	for _, r := range out.Rewrites {
		result.Rewrites = append(result.Rewrites, schemas.TextRewrite{
			TargetID: schemas.TextTargetIDForIndex(r.Index), Original: r.Original, Replacement: r.Replacement})
	}
	return result, nil
}

// selectExternalMessages 裁剪后重新编号可写文本，只读工具上下文保留其真实身份。
func selectExternalMessages(messages []external.Message, group []int) []external.Message {
	indices := make(map[int]int, len(group))
	for local, original := range group {
		indices[original] = local
	}
	out := make([]external.Message, 0, len(messages))
	for _, message := range messages {
		if message.TextIndex == nil {
			out = append(out, message)
			continue
		}
		if local, ok := indices[*message.TextIndex]; ok {
			message.TextIndex = schemas.Ptr(local)
			out = append(out, message)
		}
	}
	return out
}

// externalTools 将函数定义转换为独立子包协议，非函数工具必须显式拒绝而不能遗漏。
func externalTools(raw any, responses bool) ([]external.Tool, error) {
	data, err := schemas.MarshalSorted(raw)
	if err != nil {
		return nil, errors.New("工具定义无法序列化")
	}
	var definitions []json.RawMessage
	if err := json.Unmarshal(data, &definitions); err != nil {
		return nil, errors.New("工具定义无效")
	}
	var tools []external.Tool
	for _, definition := range definitions {
		var envelope struct {
			Type        string                  `json:"type"`
			Function    external.ToolDefinition `json:"function"`
			Name        string                  `json:"name"`
			Description string                  `json:"description"`
			Parameters  json.RawMessage         `json:"parameters"`
		}
		if json.Unmarshal(definition, &envelope) != nil || envelope.Type != "function" {
			return nil, errors.New("外部护栏不支持该工具类型")
		}
		function := envelope.Function
		if responses {
			function = external.ToolDefinition{Name: envelope.Name, Description: envelope.Description, Parameters: envelope.Parameters}
		}
		tools = append(tools, external.Tool{Type: envelope.Type, Function: function})
	}
	return tools, nil
}

// externalMessages 将文本字段按真实角色映射；参数叶子保持 tool 身份而非伪造 user 提示。
func externalMessages(rows []textRow) []external.Message {
	messages := make([]external.Message, 0, len(rows))
	for index, row := range rows {
		role := row.role
		if role == "" {
			role = "user"
		}
		messages = append(messages, external.Message{Role: role, Content: row.original,
			TextIndex: schemas.Ptr(index), ToolCallID: row.toolCallID})
	}
	return messages
}

func rewriteIndex(id schemas.TextTargetID) (int, error) {
	return strconv.Atoi(string(id))
}

func rulesUseExternal(s *snapshot, rules []compiledRule) bool {
	for _, rule := range rules {
		for _, id := range rule.rule.ProviderConfigIDs {
			profile := s.profiles[id]
			if profile.profile.Enabled {
				if _, ok := profile.adapter.(externalAdapter); ok {
					return true
				}
			}
		}
	}
	return false
}

// responseExternalContext 使用已完成输出里的函数身份，不能借输入工具定义推测实际调用。
func responseExternalContext(resp *schemas.BifrostResponse) ([]external.Message, []external.Tool, error) {
	if resp == nil {
		return nil, nil, nil
	}
	req := &schemas.BifrostRequest{}
	if resp.ChatResponse != nil {
		req.ChatRequest = &schemas.BifrostChatRequest{}
		for _, choice := range resp.ChatResponse.Choices {
			if choice.ChatNonStreamResponseChoice != nil && choice.Message != nil {
				req.ChatRequest.Input = append(req.ChatRequest.Input, *choice.Message)
			}
		}
	}
	if resp.ResponsesResponse != nil {
		req.ResponsesRequest = &schemas.BifrostResponsesRequest{Input: resp.ResponsesResponse.Output}
	}
	return requestExternalContext(req)
}

// requestExternalContext 保留函数调用与定义的完整语义，不能把 assistant/tool 降成 user 列表。
func requestExternalContext(req *schemas.BifrostRequest) ([]external.Message, []external.Tool, error) {
	var messages []external.Message
	var tools []external.Tool
	var err error
	if req.ChatRequest != nil {
		if req.ChatRequest.Params != nil {
			tools, err = externalTools(req.ChatRequest.Params.Tools, false)
		}
		for _, message := range req.ChatRequest.Input {
			if message.ChatAssistantMessage == nil || len(message.ToolCalls) == 0 {
				continue
			}
			context := external.Message{Role: string(message.Role)}
			for _, call := range message.ToolCalls {
				if call.ID == nil || call.Function.Name == nil {
					return nil, nil, errors.New("工具调用缺少身份")
				}
				context.ToolCalls = append(context.ToolCalls, external.ToolCall{ID: *call.ID, Type: "function",
					Function: external.FunctionCall{Name: *call.Function.Name, Arguments: call.Function.Arguments}})
			}
			messages = append(messages, context)
		}
	}
	if req.ResponsesRequest != nil {
		if req.ResponsesRequest.Params != nil {
			tools, err = externalTools(req.ResponsesRequest.Params.Tools, true)
		}
		for _, message := range req.ResponsesRequest.Input {
			if message.ResponsesToolMessage == nil || message.Arguments == nil {
				continue
			}
			if message.Name == nil || message.CallID == nil {
				return nil, nil, errors.New("工具调用缺少身份")
			}
			messages = append(messages, external.Message{Role: "assistant", ToolCalls: []external.ToolCall{
				{ID: *message.CallID, Type: "function", Function: external.FunctionCall{Name: *message.Name, Arguments: *message.Arguments}},
			}})
		}
	}
	return messages, tools, err
}
