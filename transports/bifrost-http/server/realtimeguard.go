package server

import (
	"github.com/google/cel-go/cel"
	"github.com/google/cel-go/common/types"
	"github.com/maximhq/bifrost/core/schemas"
)

// ValidateRealtimeOutput 在上游连接和事件转发前拒绝当前无法完整扣留的输出策略，不执行检测器或 judge。
func (p *hostGuardrailPlugin) ValidateRealtimeOutput(ctx *schemas.BifrostContext, req *schemas.BifrostRequest) *schemas.BifrostError {
	cfg := p.Config()
	if !cfg.Enabled {
		return nil
	}
	deny := func() *schemas.BifrostError {
		return &schemas.BifrostError{
			IsBifrostError: true, StatusCode: schemas.Ptr(400), AllowFallbacks: schemas.Ptr(false),
			Type: schemas.Ptr("invalid_request_error"),
			Error: &schemas.ErrorField{
				Type: schemas.Ptr("guardrail_intervention"), Code: schemas.Ptr("realtime_output_guardrails_unsupported"),
				Message: "Realtime output guardrails are unsupported for this request; no protected output can be forwarded.",
			},
			ExtraFields: schemas.BifrostErrorExtraFields{RequestType: schemas.RealtimeRequest},
		}
	}
	profiles := make(map[uint]bool, len(cfg.Providers))
	for _, profile := range cfg.Providers {
		profiles[profile.ID] = profile.Enabled
	}
	scope, err := p.ResolveScope(ctx)
	if err != nil || req == nil || req.ResponsesRequest == nil {
		return deny()
	}
	scope.Provider, scope.Model = string(req.ResponsesRequest.Provider), req.ResponsesRequest.Model
	headers := scope.Headers
	if headers == nil {
		headers = map[string]string{}
	}
	activation := map[string]any{
		"headers": headers, "virtual_key": scope.VirtualKey, "customer": scope.Customer,
		"team": scope.Team, "user": scope.User, "provider": scope.Provider, "model": scope.Model, "params": map[string]any{},
	}
	// 会话参数可由后续事件改变；不能用当前空参数把未来受保护的 turn 判为未匹配。
	partial, err := cel.PartialVars(activation, cel.AttributePattern("params"))
	if err != nil {
		return deny()
	}
	for _, rule := range cfg.Rules {
		if !rule.Enabled || rule.Target != "llm" || rule.ApplyTo == "input" || rule.SamplingRate != nil && *rule.SamplingRate == 0 {
			continue
		}
		active := false
		for _, id := range rule.ProviderConfigIDs {
			active = active || profiles[id]
		}
		if !active {
			continue
		}
		env, err := cel.NewEnv(cel.CrossTypeNumericComparisons(true),
			cel.Variable("headers", cel.MapType(cel.StringType, cel.StringType)),
			cel.Variable("virtual_key", cel.StringType), cel.Variable("customer", cel.StringType),
			cel.Variable("team", cel.StringType), cel.Variable("user", cel.StringType),
			cel.Variable("provider", cel.StringType), cel.Variable("model", cel.StringType),
			cel.Variable("params", cel.MapType(cel.StringType, cel.DynType)))
		if err != nil {
			return deny()
		}
		ast, issues := env.Compile(rule.CELExpression)
		if issues.Err() != nil {
			return deny()
		}
		program, err := env.Program(ast, cel.CostLimit(10000), cel.InterruptCheckFrequency(100), cel.EvalOptions(cel.OptPartialEval))
		if err != nil {
			return deny()
		}
		out, _, err := program.ContextEval(ctx, partial)
		if err != nil || types.IsError(out) || types.IsUnknown(out) || out != types.False {
			return deny()
		}
	}
	return nil
}
