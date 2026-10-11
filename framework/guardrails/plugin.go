package guardrails

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/maximhq/bifrost/core/schemas"
	external "github.com/maximhq/bifrost/framework/guardrails/providers"
)

var _ schemas.LLMPlugin = (*Plugin)(nil)
var _ schemas.MCPPlugin = (*Plugin)(nil)
var _ schemas.HTTPTransportPlugin = (*Plugin)(nil)
var _ schemas.ConfigMarshallerPlugin = (*Plugin)(nil)

type stateContextKey string

const llmStateKey stateContextKey = "guardrails-llm-state"
const mcpStateKey stateContextKey = "guardrails-mcp-state"

type requestState struct {
	mu              sync.Mutex
	snapshot        *snapshot
	scope           Scope
	rules           []compiledRule
	stream          bool
	held            bool
	bytes           int
	started         time.Time
	redaction       schemas.RedactionData
	stop            func() bool
	timer           *time.Timer
	rewrite         bool
	abort           func()
	contextMessages []external.Message
	tools           []external.Tool
	plainText       bool
	redactionID     string
	toolCallID      string
	outputReview    *schemas.GuardrailOutputReview
}

func (*Plugin) GetName() string                                                       { return PluginName }
func (*Plugin) PreRequestHook(*schemas.BifrostContext, *schemas.BifrostRequest) error { return nil }
func (*Plugin) HTTPTransportPreAuthHook(*schemas.BifrostContext, *schemas.HTTPRequest) (*schemas.HTTPResponse, error) {
	return nil, nil
}
func (*Plugin) HTTPTransportPreHook(*schemas.BifrostContext, *schemas.HTTPRequest) (*schemas.HTTPResponse, error) {
	return nil, nil
}
func (*Plugin) HTTPTransportPostHook(*schemas.BifrostContext, *schemas.HTTPRequest, *schemas.HTTPResponse) error {
	return nil
}
func (*Plugin) HTTPTransportResponseHeadersHook(*schemas.BifrostContext, *schemas.HTTPRequest, *schemas.HTTPResponseMetadata) error {
	return nil
}
func (*Plugin) HTTPTransportStreamChunkHook(_ *schemas.BifrostContext, _ *schemas.HTTPRequest, chunk *schemas.BifrostStreamChunk) (*schemas.BifrostStreamChunk, error) {
	return chunk, nil
}

// Cleanup 仅释放本插件的内存状态，不启停宿主服务。
func (p *Plugin) Cleanup() error {
	p.requests.Range(func(key, value any) bool {
		state := value.(*requestState)
		state.mu.Lock()
		if state.abort != nil {
			state.abort()
		}
		if state.stop != nil {
			state.stop()
		}
		if state.timer != nil {
			state.timer.Stop()
		}
		p.requests.Delete(key)
		state.mu.Unlock()
		return true
	})
	p.redactions.Range(func(key, value any) bool {
		p.redactions.Delete(key)
		return true
	})
	return nil
}

// deny 返回不可 fallback 的标准干预错误，普通 Go hook error 不能阻止调用。
func deny(reason string) *schemas.BifrostError {
	return &schemas.BifrostError{IsBifrostError: true, AllowFallbacks: schemas.Ptr(false), StatusCode: schemas.Ptr(403),
		Error: &schemas.ErrorField{Type: schemas.Ptr("guardrail_intervention"), Message: reason}}
}

// trustedScope 默认只读取服务端治理上下文；自定义 header 条件须由宿主显式提供。
func (p *Plugin) trustedScope(ctx *schemas.BifrostContext) (Scope, error) {
	if p.deps.ScopeResolver != nil {
		return p.deps.ScopeResolver(ctx)
	}
	str := func(key schemas.BifrostContextKey) string { value, _ := ctx.Value(key).(string); return value }
	return Scope{VirtualKey: str(schemas.BifrostContextKeyGovernanceVirtualKeyID), Team: str(schemas.BifrostContextKeyGovernanceTeamID),
		Customer: str(schemas.BifrostContextKeyGovernanceCustomerID), User: str(schemas.BifrostContextKeyUserID)}, nil
}

// storeState 在 manager 中保存快照和请求状态，上下文只存 opaque ID。
func (p *Plugin) storeState(ctx *schemas.BifrostContext, key stateContextKey, state *requestState) string {
	requestID, _ := ctx.Value(schemas.BifrostContextKeyRequestID).(string)
	if requestID == "" {
		requestID = uuid.NewString()
	}
	id := requestID + ":" + uuid.NewString()
	state.abort = func() {
		if state.held && ctx.IsStreamPaused() {
			if err := ctx.ClearPausedStreamBuffer(); err == nil {
				ctx.EndStream(nil)
			}
		}
		ctx.Cancel()
	}
	state.timer = time.AfterFunc(5*time.Minute, func() {
		state.mu.Lock()
		defer state.mu.Unlock()
		value, ok := p.requests.LoadAndDelete(id)
		if !ok || value != state {
			return
		}
		if state.held {
			if err := ctx.ClearPausedStreamBuffer(); err == nil {
				ctx.EndStream(deny("输出流超过护栏时限"))
			} else {
				ctx.Cancel()
			}
		}
	})
	p.requests.Store(id, state)
	ctx.SetValue(key, id)
	state.stop = context.AfterFunc(ctx, func() {
		state.timer.Stop()
		state.mu.Lock()
		defer state.mu.Unlock()
		if _, ok := p.requests.LoadAndDelete(id); !ok {
			return
		}
		if state.held && ctx.IsStreamPaused() {
			if err := ctx.ClearPausedStreamBuffer(); err == nil {
				ctx.EndStream(nil)
			}
		}
	})
	return id
}

func (p *Plugin) state(ctx *schemas.BifrostContext, key stateContextKey) (*requestState, string) {
	id, _ := ctx.Value(key).(string)
	value, ok := p.requests.Load(id)
	if !ok {
		return nil, id
	}
	return value.(*requestState), id
}

func (p *Plugin) drop(id string, state *requestState) {
	p.requests.Delete(id)
	if state.stop != nil {
		state.stop()
	}
	if state.timer != nil {
		state.timer.Stop()
	}
}

// attachResult 在 trace 完成前注册分阶段 literal 替换；缺少安全注册能力时阻断，不导出可逆映射。
func (p *Plugin) attachResult(ctx *schemas.BifrostContext, state *requestState, result Result) error {
	literals := result.Redaction.LiteralReplacements.Clone()
	if literals.HasReplacements() {
		mappingBytes := 0
		for _, replacements := range []map[string]string{literals.Input, literals.Output} {
			if len(replacements) > maxFindings {
				return errors.New("trace 脱敏映射超过安全上限")
			}
			for raw, placeholder := range replacements {
				mappingBytes += len(raw) + len(placeholder)
			}
		}
		if mappingBytes > 2*maxMappingBytes {
			return errors.New("trace 脱敏映射超过安全上限")
		}
		tracer := ctx.Value(schemas.BifrostContextKeyTracer)
		traceID, _ := ctx.Value(schemas.BifrostContextKeyTraceID).(string)
		traceID = strings.TrimSpace(traceID)
		if _, noop := tracer.(*schemas.NoOpTracer); !noop && (tracer != nil || traceID != "") {
			register, ok := tracer.(interface {
				SetTraceRedactionReplacements(string, schemas.RedactionPhase, map[string]string)
			})
			if !ok || traceID == "" {
				return errors.New("trace 缺少安全脱敏注册能力")
			}
			register.SetTraceRedactionReplacements(traceID, schemas.RedactionPhaseInput, literals.Input)
			register.SetTraceRedactionReplacements(traceID, schemas.RedactionPhaseOutput, literals.Output)
		}
	}
	if result.Metadata != nil {
		metadata, _ := schemas.GuardrailMetadataFromContext(ctx)
		if metadata == nil {
			metadata = &schemas.BifrostGuardrailMetadata{}
		}
		metadata.JudgeCalls = append(metadata.JudgeCalls, result.Metadata.JudgeCalls...)
		metadata.Detections = append(metadata.Detections, result.Metadata.Detections...)
		if len(metadata.Detections) > 512 {
			metadata.Detections = metadata.Detections[:512]
		}
		schemas.SetGuardrailMetadataOnContext(ctx, metadata)
	}
	state.redaction.LiteralReplacements.MergePhase(schemas.RedactionPhaseInput, result.Redaction.LiteralReplacements.Input)
	state.redaction.LiteralReplacements.MergePhase(schemas.RedactionPhaseOutput, result.Redaction.LiteralReplacements.Output)
	state.redaction.ReversibleMappings.MergePhase(schemas.RedactionPhaseInput, result.Redaction.ReversibleMappings.Input)
	state.redaction.ReversibleMappings.MergePhase(schemas.RedactionPhaseOutput, result.Redaction.ReversibleMappings.Output)
	if state.redaction.HasReplacements() {
		if state.redactionID == "" {
			state.redactionID = uuid.NewString()
			id := state.redactionID
			context.AfterFunc(ctx, func() { p.redactions.Delete(id) })
			time.AfterFunc(5*time.Minute, func() { p.redactions.Delete(id) })
		}
		p.redactions.Store(state.redactionID, state.redaction.Clone())
		ctx.SetValue(schemas.BifrostContextKeyRedactionData, redactionDataHandle{p, state.redactionID})
	}
	return nil
}

// PreLLMHook 完成输入检查，并在上游开始生成前建立输出流保护。
func (p *Plugin) PreLLMHook(ctx *schemas.BifrostContext, req *schemas.BifrostRequest) (*schemas.BifrostRequest, *schemas.LLMPluginShortCircuit, error) {
	s := p.current.Load()
	if ctx != nil {
		if previous, id := p.state(ctx, llmStateKey); previous != nil {
			previous.mu.Lock()
			s = previous.snapshot
			if previous.held {
				if err := ctx.ClearPausedStreamBuffer(); err != nil {
					previous.mu.Unlock()
					return req, &schemas.LLMPluginShortCircuit{Error: deny("无法安全更新输出流护栏")}, nil
				}
				ctx.ResumeStream()
			}
			p.drop(id, previous)
			previous.mu.Unlock()
		}
	}
	if !s.config.Enabled || len(s.rules) == 0 {
		return req, nil, nil
	}
	reject := func(reason string) (*schemas.BifrostRequest, *schemas.LLMPluginShortCircuit, error) {
		return req, &schemas.LLMPluginShortCircuit{Error: deny(reason)}, nil
	}
	if ctx == nil || req == nil {
		return reject("护栏缺少请求上下文")
	}
	scope, err := p.trustedScope(ctx)
	if err != nil {
		return reject("可信请求身份解析失败")
	}
	switch {
	case req.ChatRequest != nil:
		scope.Provider, scope.Model = string(req.ChatRequest.Provider), req.ChatRequest.Model
	case req.ResponsesRequest != nil:
		scope.Provider, scope.Model = string(req.ResponsesRequest.Provider), req.ResponsesRequest.Model
	case req.TextCompletionRequest != nil:
		scope.Provider, scope.Model = string(req.TextCompletionRequest.Provider), req.TextCompletionRequest.Model
	default:
		return req, nil, nil
	}
	scope.Params, err = requestParams(req)
	if err != nil {
		return reject(err.Error())
	}
	requestID, _ := ctx.Value(schemas.BifrostContextKeyRequestID).(string)
	if requestID == "" {
		requestID = uuid.NewString()
		ctx.SetValue(schemas.BifrostContextKeyRequestID, requestID)
	}
	ev := Evaluation{Target: "llm", Phase: "input", Scope: scope, RequestID: requestID}
	inputRules, err := matchingRules(ctx, s, ev)
	if err != nil {
		return reject(err.Error())
	}
	state := &requestState{snapshot: s, scope: scope, started: time.Now()}
	if existing, ok := schemas.RedactionDataFromContext(ctx); ok {
		state.redaction = existing.Clone()
	}
	state.plainText = req.TextCompletionRequest != nil
	var contextErr error
	state.contextMessages, state.tools, contextErr = requestExternalContext(req)
	if contextErr != nil && rulesUseExternal(s, inputRules) {
		return reject(contextErr.Error())
	}
	if len(inputRules) > 0 {
		rows, err := requestRows(req)
		if err != nil {
			return reject(err.Error())
		}
		ev.Texts = rowTexts(rows)
		ev.Messages = append(externalMessages(rows), state.contextMessages...)
		ev.Tools, ev.PlainText = state.tools, state.plainText
		ev.HasToolCalls = len(state.contextMessages) > 0
		ev.Complete = true
		result, err := p.evaluate(ctx, s, inputRules, ev, rows, state.redaction)
		if attachErr := p.attachResult(ctx, state, result); attachErr != nil {
			return reject(attachErr.Error())
		}
		if err != nil {
			return reject(err.Error())
		}
		if result.Blocked {
			return reject(result.Reason)
		}
		if len(result.Rewrites) > 0 {
			req = cloneGuardrailRequest(req)
			rows, err = requestRows(req)
			if err != nil {
				return reject(err.Error())
			}
			if raw, _ := ctx.Value(schemas.BifrostContextKeyUseRawRequestBody).(bool); raw {
				if err := syncRawRequest(ctx, req, result); err != nil {
					return reject(err.Error())
				}
			}
			if err := applyRows(rows, result); err != nil {
				return reject(err.Error())
			}
		}
	}
	ev.Phase = "output"
	state.rules, err = matchingRules(ctx, s, ev)
	if err != nil {
		return reject(err.Error())
	}
	if contextErr != nil && rulesUseExternal(s, state.rules) {
		return reject("工具定义不受外部护栏支持")
	}
	protected := false
	for _, rule := range state.rules {
		for _, profileID := range rule.rule.ProviderConfigIDs {
			protected = protected || s.profiles[profileID].profile.Enabled
		}
	}
	if protected {
		state.outputReview = &schemas.GuardrailOutputReview{}
		ctx.SetValue(schemas.BifrostContextKeyGuardrailOutputReview, state.outputReview)
		tracer := ctx.Value(schemas.BifrostContextKeyTracer)
		if _, noop := tracer.(*schemas.NoOpTracer); tracer != nil && !noop {
			register, ok := tracer.(interface {
				SetTraceGuardrailOutputReview(string, *schemas.GuardrailOutputReview) bool
			})
			traceID, _ := ctx.Value(schemas.BifrostContextKeyTraceID).(string)
			if !ok || !register.SetTraceGuardrailOutputReview(traceID, state.outputReview) {
				return reject("trace 缺少未审查输出的安全出口门禁")
			}
		}
	}
	state.stream = strings.Contains(string(req.RequestType), "stream")
	if state.stream && len(state.rules) > 0 {
		for _, rule := range state.rules {
			for _, id := range rule.rule.ProviderConfigIDs {
				cp := s.profiles[id]
				if !cp.profile.Enabled {
					continue
				}
				state.rewrite = state.rewrite || cp.caps.CanRedact || cp.caps.Transforms
				state.held = state.held || cp.caps.CanBlock || cp.caps.OutputRequiresFullBuffer
			}
		}
		if state.rewrite {
			if p.deps.StreamRewriter == nil {
				return reject("该输出策略需要尚未接入的安全流文本重写器")
			}
			if err := p.deps.StreamRewriter.ValidateRequest(ctx, req); err != nil {
				return reject("宿主没有该协议的安全流文本重写能力")
			}
			state.held = true
		}
		tracer, ok := ctx.Value(schemas.BifrostContextKeyTracer).(schemas.Tracer)
		traceID, _ := ctx.Value(schemas.BifrostContextKeyTraceID).(string)
		if !ok || tracer == nil || traceID == "" {
			return reject("输出流护栏需要真实累积器")
		}
		if _, noop := tracer.(*schemas.NoOpTracer); noop {
			return reject("输出流护栏不能使用 NoOpTracer")
		}
		if state.held {
			ctx.PauseStream()
			if !ctx.IsStreamPaused() {
				return reject("输出流未安全暂停")
			}
			if err := ctx.ClearPausedStreamBuffer(); err != nil {
				return reject("输出流 gate 不支持安全丢弃")
			}
		}
	}
	p.storeState(ctx, llmStateKey, state)
	return req, nil, nil
}

// PostLLMHook 用完整流结果处理跨 chunk 命中；拒绝时清空扣留内容后生成终止错误。
func (p *Plugin) PostLLMHook(ctx *schemas.BifrostContext, resp *schemas.BifrostResponse, upstreamErr *schemas.BifrostError) (*schemas.BifrostResponse, *schemas.BifrostError, error) {
	state, id := p.state(ctx, llmStateKey)
	if state == nil {
		return resp, upstreamErr, nil
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	block := func(reason string) (*schemas.BifrostResponse, *schemas.BifrostError, error) {
		if state.held {
			if err := ctx.ClearPausedStreamBuffer(); err != nil {
				// 不能安全丢弃时不允许 resume；取消请求以终止潜在泄漏。
				p.drop(id, state)
				ctx.Cancel()
				return nil, deny("无法安全丢弃输出流"), nil
			}
			ctx.ResumeStream()
		}
		p.drop(id, state)
		return nil, deny(reason), nil
	}
	final, _ := ctx.Value(schemas.BifrostContextKeyStreamEndIndicator).(bool)
	if state.stream && len(state.rules) > 0 {
		encoded, _ := schemas.MarshalSorted(resp)
		state.bytes += len(encoded)
		if state.bytes > maxTextBytes || time.Since(state.started) > 5*time.Minute {
			return block("输出流超过护栏安全上限")
		}
		if upstreamErr != nil {
			return block("上游输出流失败")
		}
		if !final {
			return resp, nil, nil
		}
		respSnapshot := ctx.GetAccumulatedResponse()
		if respSnapshot == nil {
			return block("无法取得完整输出流")
		}
		result, err := p.evaluateResponse(ctx, state, respSnapshot)
		if attachErr := p.attachResult(ctx, state, result); attachErr != nil {
			return block(attachErr.Error())
		}
		if err != nil {
			return block(err.Error())
		}
		if result.Blocked {
			return block(result.Reason)
		}
		if len(result.Rewrites) > 0 {
			if p.deps.StreamRewriter == nil {
				return block("缺少安全流文本重写路径")
			}
			rewritten, err := p.deps.StreamRewriter.Rewrite(ctx, respSnapshot, resp, result.Rewrites)
			if err != nil || rewritten == nil {
				return block("输出流文本重写失败")
			}
			resp = rewritten
		}
		if state.held {
			interval := 0
			for _, rule := range state.rules {
				if rule.rule.StreamReplayEventIntervalMS > interval {
					interval = rule.rule.StreamReplayEventIntervalMS
				}
			}
			if interval > 0 {
				tr, _ := ctx.Value(schemas.BifrostContextKeyTracer).(schemas.Tracer)
				traceID, _ := ctx.Value(schemas.BifrostContextKeyTraceID).(string)
				paced, ok := tr.(interface {
					ResumeStreamWithReplayInterval(string, time.Duration) bool
				})
				if !ok || !paced.ResumeStreamWithReplayInterval(traceID, time.Duration(interval)*time.Millisecond) {
					return block("流 gate 不支持配置的回放间隔")
				}
			} else {
				ctx.ResumeStream()
			}
		}
		if state.outputReview != nil && ctx.Err() == nil {
			state.outputReview.Approve()
		}
		p.drop(id, state)
		return resp, nil, nil
	}
	if upstreamErr != nil {
		p.drop(id, state)
		return resp, upstreamErr, nil
	}
	result, err := p.evaluateResponse(ctx, state, resp)
	if attachErr := p.attachResult(ctx, state, result); attachErr != nil {
		return block(attachErr.Error())
	}
	if err != nil {
		return block(err.Error())
	}
	if result.Blocked {
		return block(result.Reason)
	}
	if len(result.Rewrites) > 0 {
		owned, err := cloneStreamValue(resp)
		if err != nil {
			return block(err.Error())
		}
		if resp != nil && resp.GetExtraFields() != nil {
			owned.GetExtraFields().RawResponse = resp.GetExtraFields().RawResponse
		}
		resp = owned
	}
	rows, err := responseRows(resp)
	if err != nil {
		return block(err.Error())
	}
	if len(result.Rewrites) > 0 && resp != nil {
		if len(rows) != len(result.Texts) {
			return block("文本重写数量不匹配")
		}
		changed := false
		for i, row := range rows {
			changed = changed || row.original != result.Texts[i]
		}
		if extra := resp.GetExtraFields(); changed && extra != nil && extra.RawResponse != nil {
			transform, ok := ctx.Value(schemas.BifrostContextKeyRawResponseTextTransformer).(schemas.RawResponseTextTransformer)
			if !ok {
				return block("原生响应缺少安全文本重写器")
			}
			rewritten, err := transform(extra.RawResponse, result.Rewrites)
			if err != nil {
				return block("原生响应文本重写失败")
			}
			if present, err := nativeLogProbsPresent(rewritten); err != nil || present {
				return block("原生响应无法安全清除概率载体")
			}
			extra.RawResponse = rewritten
		}
		if err := applyRows(rows, result); err != nil {
			return block(err.Error())
		}
	}
	if state.outputReview != nil && ctx.Err() == nil {
		state.outputReview.Approve()
	}
	p.drop(id, state)
	return resp, nil, nil
}

// evaluateResponse 始终使用请求开始时的配置快照，热更新不改变进行中的策略。
func (p *Plugin) evaluateResponse(ctx *schemas.BifrostContext, state *requestState, resp *schemas.BifrostResponse) (Result, error) {
	rows, err := responseRows(resp)
	if err != nil {
		return Result{}, err
	}
	requestID, _ := ctx.Value(schemas.BifrostContextKeyRequestID).(string)
	ev := Evaluation{Target: "llm", Phase: "output", Scope: state.scope, RequestID: requestID, Texts: rowTexts(rows),
		Messages: externalMessages(rows), Tools: state.tools, PlainText: state.plainText,
		Streaming: state.stream, Complete: !state.stream || state.held}
	contextMessages, _, err := responseExternalContext(resp)
	if err != nil && rulesUseExternal(state.snapshot, state.rules) {
		return Result{}, err
	}
	ev.Messages = append(ev.Messages, contextMessages...)
	ev.HasToolCalls = len(contextMessages) > 0
	return p.evaluate(ctx, state.snapshot, state.rules, ev, rows, state.redaction)
}

// PreMCPHook 保护实际执行边界，只检查参数字符串叶子，不改变数字和工具身份。
func (p *Plugin) PreMCPHook(ctx *schemas.BifrostContext, req *schemas.BifrostMCPRequest) (*schemas.BifrostMCPRequest, *schemas.MCPPluginShortCircuit, error) {
	s := p.current.Load()
	if !s.config.Enabled || len(s.rules) == 0 {
		return req, nil, nil
	}
	reject := func(reason string) (*schemas.BifrostMCPRequest, *schemas.MCPPluginShortCircuit, error) {
		return req, &schemas.MCPPluginShortCircuit{Error: deny(reason)}, nil
	}
	if ctx == nil || req == nil {
		return reject("MCP 护栏缺少请求上下文")
	}
	if !req.RequestType.IsExecuteTool() {
		return req, nil, nil
	}
	scope, err := p.trustedScope(ctx)
	if err != nil {
		return reject("可信 MCP 身份解析失败")
	}
	scope.MCPClient, scope.MCPTool = req.ClientName, req.GetToolName()
	var args *string
	if req.ChatAssistantMessageToolCall != nil {
		args = &req.ChatAssistantMessageToolCall.Function.Arguments
	} else if req.ResponsesToolMessage != nil {
		args = req.Arguments
	}
	if args != nil && *args != "" {
		if len(*args) > maxTextBytes || validateJSON([]byte(*args)) != nil {
			return reject("MCP 参数无效或超过上限")
		}
		var err error
		scope.MCPArguments, err = typedArguments(*args)
		if err != nil {
			return reject("MCP 参数无效")
		}
	}
	requestID, _ := ctx.Value(schemas.BifrostContextKeyRequestID).(string)
	if requestID == "" {
		requestID = uuid.NewString()
		ctx.SetValue(schemas.BifrostContextKeyRequestID, requestID)
	}
	ev := Evaluation{Target: "mcp", Phase: "input", Scope: scope, RequestID: requestID}
	inputRules, err := matchingRules(ctx, s, ev)
	if err != nil {
		return reject(err.Error())
	}
	state := &requestState{snapshot: s, scope: scope, started: time.Now()}
	if req.ChatAssistantMessageToolCall != nil && req.ChatAssistantMessageToolCall.ID != nil {
		state.toolCallID = *req.ChatAssistantMessageToolCall.ID
	}
	if req.ResponsesToolMessage != nil && req.CallID != nil {
		state.toolCallID = *req.CallID
	}
	if len(inputRules) > 0 {
		var rows []textRow
		if err := jsonRows(&rows, args, 0); err != nil {
			return reject(err.Error())
		}
		ev.Texts = rowTexts(rows)
		ev.Messages = externalMessages(rows)
		for i := range ev.Messages {
			ev.Messages[i].Role = "tool"
			ev.Messages[i].ToolCallID = state.toolCallID
		}
		if args != nil {
			ev.Messages = append(ev.Messages, external.Message{Role: "assistant", ToolCalls: []external.ToolCall{
				{ID: state.toolCallID, Type: "function", Function: external.FunctionCall{Name: scope.MCPTool, Arguments: *args}},
			}})
		}
		ev.HasToolCalls, ev.Complete = true, true
		result, err := p.evaluate(ctx, s, inputRules, ev, rows, state.redaction)
		if attachErr := p.attachResult(ctx, state, result); attachErr != nil {
			return reject(attachErr.Error())
		}
		if err != nil {
			return reject(err.Error())
		}
		if result.Blocked {
			return reject(result.Reason)
		}
		if len(result.Rewrites) > 0 {
			owned, err := cloneStreamValue(req)
			if err != nil {
				return reject(err.Error())
			}
			req = owned
			args = nil
			if req.ChatAssistantMessageToolCall != nil {
				args = &req.ChatAssistantMessageToolCall.Function.Arguments
			} else if req.ResponsesToolMessage != nil {
				args = req.Arguments
			}
			rows = nil
			if err := jsonRows(&rows, args, 0); err != nil {
				return reject(err.Error())
			}
		}
		if err := applyRows(rows, result); err != nil {
			return reject(err.Error())
		}
	}
	ev.Phase = "output"
	state.rules, err = matchingRules(ctx, s, ev)
	if err != nil {
		return reject(err.Error())
	}
	p.storeState(ctx, mcpStateKey, state)
	return req, nil, nil
}

// PostMCPHook 在成功的文本结果返回前执行输出策略，不对工具错误伪造成功。
func (p *Plugin) PostMCPHook(ctx *schemas.BifrostContext, resp *schemas.BifrostMCPResponse, upstreamErr *schemas.BifrostError) (*schemas.BifrostMCPResponse, *schemas.BifrostError, error) {
	state, id := p.state(ctx, mcpStateKey)
	if state == nil {
		return resp, upstreamErr, nil
	}
	defer p.drop(id, state)
	if upstreamErr != nil || resp == nil {
		return resp, upstreamErr, nil
	}
	var rows []textRow
	if err := chatRows(&rows, resp.ChatMessage, 0); err != nil {
		return nil, deny(err.Error()), nil
	}
	if err := responsesRows(&rows, resp.ResponsesMessage, 0); err != nil {
		return nil, deny(err.Error()), nil
	}
	requestID, _ := ctx.Value(schemas.BifrostContextKeyRequestID).(string)
	ev := Evaluation{Target: "mcp", Phase: "output", Scope: state.scope, Texts: rowTexts(rows),
		RequestID: requestID, Messages: externalMessages(rows), Complete: true, HasToolCalls: true}
	for i := range ev.Messages {
		ev.Messages[i].Role, ev.Messages[i].ToolCallID = "tool", state.toolCallID
	}
	result, err := p.evaluate(ctx, state.snapshot, state.rules, ev, rows, state.redaction)
	if attachErr := p.attachResult(ctx, state, result); attachErr != nil {
		return nil, deny(attachErr.Error()), nil
	}
	if err != nil {
		return nil, deny(err.Error()), nil
	}
	if result.Blocked {
		return nil, deny(result.Reason), nil
	}
	if len(result.Rewrites) > 0 {
		owned, err := cloneStreamValue(resp)
		if err != nil {
			return nil, deny(err.Error()), nil
		}
		resp = owned
		rows = nil
		if err := chatRows(&rows, resp.ChatMessage, 0); err != nil {
			return nil, deny(err.Error()), nil
		}
		if err := responsesRows(&rows, resp.ResponsesMessage, 0); err != nil {
			return nil, deny(err.Error()), nil
		}
	}
	if err := applyRows(rows, result); err != nil {
		return nil, deny(err.Error()), nil
	}
	return resp, nil, nil
}

// ResolveScope 为受授权的管理评估入口提供相同可信身份边界。
func (p *Plugin) ResolveScope(ctx *schemas.BifrostContext) (Scope, error) {
	if ctx == nil {
		return Scope{}, errors.New("缺少可信请求上下文")
	}
	return p.trustedScope(ctx)
}

// ProviderNames 仅返回已有真实实现的配置类型。
func (p *Plugin) ProviderNames() []string {
	names := []string{"regex", "secrets", "presidio"}
	if p.deps.ChatExecutor != nil {
		names = append(names, "prompt-guardrail")
	}
	for name := range p.deps.Adapters {
		if name != "presidio" {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	return names
}

// ProviderCapabilities 从真实注册项暴露能力边界，具体 profile 的 block/redact 配置仍由编译器限制。
func (p *Plugin) ProviderCapabilities(name string) (Capabilities, bool) {
	switch name {
	case "regex", "secrets", "presidio":
		return Capabilities{Input: true, Output: true, CanBlock: true, CanRedact: true, ToolContext: true}, true
	case "prompt-guardrail":
		if p.deps.ChatExecutor != nil {
			return Capabilities{Input: true, Output: true, CanBlock: true, ToolContext: true, OutputRequiresFullBuffer: true}, true
		}
	default:
		if adapter := p.deps.Adapters[name]; adapter != nil {
			return adapter.Capabilities(), true
		}
	}
	return Capabilities{}, false
}

func (p *Plugin) String() string {
	return fmt.Sprintf("guardrails(enabled=%t)", p.current.Load().config.Enabled)
}
