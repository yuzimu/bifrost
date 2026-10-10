package resilience

import (
	bifrost "github.com/maximhq/bifrost/core"
	"github.com/maximhq/bifrost/core/schemas"
)

// Plugin observes attempts; target redirection is supplied by the authorized routing integration.
type Plugin struct {
	Runtime           *Runtime
	EligibleTargets   func(*schemas.BifrostContext, *schemas.BifrostRequest) ([]schemas.Fallback, error)
	EligibleProviders func(*schemas.BifrostContext, *schemas.BifrostRequest) ([]schemas.ProviderCandidate, error)
	RefineModel       ModelRefiner
}

var _ schemas.LLMPlugin = (*Plugin)(nil)

func (p *Plugin) GetName() string { return PluginName }

// PreRequestHook 仅使用集成方已授权的目标处理 policy 链与既有 fallback。
func (p *Plugin) PreRequestHook(ctx *schemas.BifrostContext, req *schemas.BifrostRequest) error {
	if req == nil || ctx == nil || p.Runtime == nil || BypassRequest(req.RequestType) {
		return nil
	}
	ctx.SetValue(typeContextKey, req.RequestType)
	if p.EligibleProviders != nil {
		eligible, err := p.EligibleProviders(ctx, req)
		if err != nil {
			return err
		}
		if err := p.Runtime.RouteRequest(ctx, req, eligible, p.RefineModel); err != nil {
			return err
		}
	}
	if p.EligibleTargets == nil {
		return nil
	}
	eligible, err := p.EligibleTargets(ctx, req)
	if err != nil {
		return err
	}
	return p.Runtime.ApplyCircuitPolicies(ctx, req, eligible)
}

// PreLLMHook 记录请求类型并预留共享 circuit，选 key 时再绑定具体身份。
func (p *Plugin) PreLLMHook(ctx *schemas.BifrostContext, req *schemas.BifrostRequest) (*schemas.BifrostRequest, *schemas.LLMPluginShortCircuit, error) {
	if req == nil || ctx == nil || p.Runtime == nil {
		return req, nil, nil
	}
	ctx.SetValue(typeContextKey, req.RequestType)
	ctx.SetValue(forcedCheckKey, "")
	if BypassRequest(req.RequestType) {
		return req, nil, nil
	}
	provider, model, _ := req.GetRequestFields()
	if _, err := p.Runtime.BeginAttempt(ctx, provider, model, "", req.RequestType); err != nil {
		code := 503
		return req, &schemas.LLMPluginShortCircuit{Error: &schemas.BifrostError{IsBifrostError: true,
			StatusCode: &code, Error: &schemas.ErrorField{Message: ErrUnavailable.Error()}}}, nil
	}
	return req, nil, nil
}

// PostLLMHook 忽略中间 chunk，只有最终 chunk 或终止错误结算一次。
func (p *Plugin) PostLLMHook(ctx *schemas.BifrostContext, resp *schemas.BifrostResponse, err *schemas.BifrostError) (*schemas.BifrostResponse, *schemas.BifrostError, error) {
	if ctx == nil || p.Runtime == nil {
		return resp, err, nil
	}
	rt := requestType(ctx)
	final, _ := ctx.Value(schemas.BifrostContextKeyStreamEndIndicator).(bool)
	if bifrost.IsStreamRequestType(rt) && !final && err == nil {
		return resp, err, nil
	}
	o := ObservationFromResponse(resp, err)
	o.Canceled = o.Canceled || ctx.Err() != nil
	if len(o.ResponseHeaders) == 0 {
		o.ResponseHeaders, _ = ctx.Value(schemas.BifrostContextKeyProviderResponseHeaders).(map[string]string)
	}
	p.Runtime.ObserveAttempt(AttemptID(ctx), o)
	return resp, err, nil
}

func (p *Plugin) Cleanup() error { return p.Runtime.Cleanup() }
