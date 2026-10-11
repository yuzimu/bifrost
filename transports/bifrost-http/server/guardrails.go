package server

import (
	"context"
	"errors"
	"strings"

	"github.com/fasthttp/router"
	bifrost "github.com/maximhq/bifrost/core"
	"github.com/maximhq/bifrost/core/schemas"
	"github.com/maximhq/bifrost/framework/configstore"
	"github.com/maximhq/bifrost/framework/configstore/tables"
	"github.com/maximhq/bifrost/framework/guardrails"
	"github.com/maximhq/bifrost/transports/bifrost-http/handlers"
	"github.com/maximhq/bifrost/transports/bifrost-http/lib"
	"github.com/valyala/fasthttp"
	"gorm.io/gorm"
)

type hostGuardrailPlugin struct {
	*guardrails.Plugin
}

type guardrailInputReadyKey struct{ plugin *hostGuardrailPlugin }
type guardrailInputTarget struct {
	provider schemas.ModelProvider
	model    string
}
type guardrailJudgeInternalKey struct{}

func (*hostGuardrailPlugin) GuardrailPriority() bool { return true }

// Cleanup 不销毁热更新前请求的快照，完成和取消仍由护栏请求 manager 回收。
func (*hostGuardrailPlugin) Cleanup() error { return nil }

// PreLLMHook 复用同一目标的前置校验，路由改变后按实际目标重新匹配规则。
func (p *hostGuardrailPlugin) PreLLMHook(ctx *schemas.BifrostContext, req *schemas.BifrostRequest) (*schemas.BifrostRequest, *schemas.LLMPluginShortCircuit, error) {
	if internal, _ := ctx.Value(guardrailJudgeInternalKey{}).(bool); internal {
		return req, nil, nil
	}
	if req == nil {
		return p.Plugin.PreLLMHook(ctx, req)
	}
	if req != nil && req.RequestType == schemas.RealtimeRequest {
		if err := p.ValidateRealtimeOutput(ctx, req); err != nil {
			return req, &schemas.LLMPluginShortCircuit{Error: err}, nil
		}
	}
	key := guardrailInputReadyKey{p}
	provider, model, _ := req.GetRequestFields()
	target := guardrailInputTarget{provider: provider, model: model}
	if ready, ok := ctx.Value(key).(guardrailInputTarget); ok && ready == target {
		return req, nil, nil
	}
	next, short, err := p.Plugin.PreLLMHook(ctx, req)
	if short == nil && err == nil {
		ctx.SetValue(key, target)
	}
	return next, short, err
}

// PostLLMHook 保留流中间态，终止后允许下一个真实 attempt 建立独立检查状态。
func (p *hostGuardrailPlugin) PostLLMHook(ctx *schemas.BifrostContext, resp *schemas.BifrostResponse, err *schemas.BifrostError) (*schemas.BifrostResponse, *schemas.BifrostError, error) {
	final, _ := ctx.Value(schemas.BifrostContextKeyStreamEndIndicator).(bool)
	if err != nil || ctx.Value(schemas.BifrostContextKeyStreamStartTime) == nil || final {
		defer ctx.ClearValue(guardrailInputReadyKey{p})
	}
	return p.Plugin.PostLLMHook(ctx, resp, err)
}

// HTTPTransportPreHook 只传递匹配用 headers，不从客户端声明中构造可信身份。
func (p *hostGuardrailPlugin) HTTPTransportPreHook(ctx *schemas.BifrostContext, req *schemas.HTTPRequest) (*schemas.HTTPResponse, error) {
	headers := make(map[string]string, len(req.Headers))
	for key, value := range req.Headers {
		key = strings.ToLower(key)
		if key != "authorization" && key != "x-bf-vk" && key != "cookie" {
			headers[key] = value
		}
	}
	ctx.SetValue(schemas.BifrostContextKeyGuardrailHeaders, headers)
	return p.Plugin.HTTPTransportPreHook(ctx, req)
}

// instantiateGuardrails 编译候选策略，并绑定宿主真实身份和模型执行入口。
func (s *BifrostHTTPServer) instantiateGuardrails(ctx context.Context, value any) (schemas.BasePlugin, error) {
	cfg, err := guardrails.DecodeConfig(value)
	if err != nil {
		return nil, err
	}
	var store configstore.ConfigStore
	if s.Config.ConfigStore != nil {
		store = guardrailConfigStore{ConfigStore: s.Config.ConfigStore, config: s.Config}
	}
	p, err := guardrails.PluginInit(cfg, guardrails.Dependencies{
		ConfigStore:    store,
		ScopeResolver:  s.guardrailScope,
		ChatExecutor:   hostGuardrailJudge{s},
		StreamRewriter: guardrails.NewStreamTextRewriter(),
	})
	if err != nil {
		return nil, err
	}
	return &hostGuardrailPlugin{Plugin: p}, nil
}

type guardrailConfigStore struct {
	configstore.ConfigStore
	config *lib.Config
}

// UpsertPlugin 复用 B 的唯一持久化写入，在提交后同步宿主内存配置。
func (store guardrailConfigStore) UpsertPlugin(ctx context.Context, row *tables.TablePlugin, tx ...*gorm.DB) error {
	if store.ConfigStore == nil {
		return errors.New("configuration persistence is unavailable")
	}
	if err := store.ConfigStore.UpsertPlugin(ctx, row, tx...); err != nil {
		return err
	}
	store.config.RememberPluginConfig(row)
	return nil
}

// guardrailScope 在治理 hooks 前从已认证的 VK 解析所有者，忽略客户端 user/team 声明。
func (s *BifrostHTTPServer) guardrailScope(ctx *schemas.BifrostContext) (guardrails.Scope, error) {
	scope := guardrails.Scope{Params: map[string]any{}}
	headers, _ := ctx.Value(schemas.BifrostContextKeyGuardrailHeaders).(map[string]string)
	scope.Headers = headers
	value, _ := ctx.Value(schemas.BifrostContextKeyVirtualKey).(string)
	if value != "" {
		gov, err := s.getGovernancePlugin()
		if err != nil {
			return scope, err
		}
		vk, ok := gov.GetGovernanceStore().GetVirtualKey(ctx, value)
		if !ok || vk.IsActive != nil && !*vk.IsActive {
			return scope, errors.New("virtual key is not active")
		}
		scope.VirtualKey = vk.ID
		if vk.TeamID != nil {
			scope.Team = *vk.TeamID
		}
		if vk.CustomerID != nil {
			scope.Customer = *vk.CustomerID
		}
	}
	return scope, nil
}

type hostGuardrailJudge struct{ server *BifrostHTTPServer }

// ValidateJudge 只核对配置的 provider 和模型，不主动发送推理或探测。
func (j hostGuardrailJudge) ValidateJudge(ctx context.Context, cfg guardrails.PromptConfig) error {
	j.server.Config.Mu.RLock()
	_, ok := j.server.Config.Providers[schemas.ModelProvider(cfg.JudgeProvider)]
	j.server.Config.Mu.RUnlock()
	if !ok || cfg.JudgeModel == "" {
		return errors.New("judge provider/model is not configured")
	}
	return nil
}

// ExecuteChat 沿既有内部请求配方调用真实宿主客户端，隔离原始请求并防止护栏递归。
func (j hostGuardrailJudge) ExecuteChat(ctx context.Context, req *schemas.BifrostChatRequest) (*schemas.BifrostChatResponse, error) {
	if j.server.Client == nil {
		return nil, errors.New("judge client is not initialized")
	}
	if req == nil {
		return nil, errors.New("judge request is required")
	}
	if err := j.ValidateJudge(ctx, guardrails.PromptConfig{JudgeProvider: string(req.Provider), JudgeModel: req.Model}); err != nil {
		return nil, err
	}
	deadline, ok := ctx.Deadline()
	if !ok {
		deadline = schemas.NoDeadline
	}
	child := schemas.NewBifrostContext(ctx, deadline)
	defer child.Cancel()
	bifrost.PrepareContextForInternalRequest(child)
	child.SetValue(guardrailJudgeInternalKey{}, true)
	child.SetValue("bifrost-provider-attempt-observer", nil)
	reply, err := j.server.Client.ChatCompletionRequest(child, req)
	if err != nil {
		return nil, guardrails.JudgeErrorFromBifrost(err)
	}
	return reply, nil
}

// ExecuteResponses 为真实支持 Responses 的 judge 提供宿主入口，不伪造 Chat 成功。
func (j hostGuardrailJudge) ExecuteResponses(ctx context.Context, req *schemas.BifrostResponsesRequest) (*schemas.BifrostResponsesResponse, error) {
	if j.server.Client == nil {
		return nil, errors.New("judge client is not initialized")
	}
	if req == nil {
		return nil, errors.New("judge request is required")
	}
	if err := j.ValidateJudge(ctx, guardrails.PromptConfig{JudgeProvider: string(req.Provider), JudgeModel: req.Model}); err != nil {
		return nil, err
	}
	deadline, ok := ctx.Deadline()
	if !ok {
		deadline = schemas.NoDeadline
	}
	child := schemas.NewBifrostContext(ctx, deadline)
	defer child.Cancel()
	bifrost.PrepareContextForInternalRequest(child)
	child.SetValue(guardrailJudgeInternalKey{}, true)
	child.SetValue("bifrost-provider-attempt-observer", nil)
	reply, err := j.server.Client.ResponsesRequest(child, req)
	if err != nil {
		return nil, guardrails.JudgeErrorFromBifrost(err)
	}
	return reply, nil
}

// authorizeGuardrails 要求真实管理认证或 setup token，不放行 auth-disabled 的旁路请求。
func authorizeGuardrails(ctx *fasthttp.RequestCtx, operation string) bool {
	if bypassed, _ := ctx.UserValue(schemas.BifrostContextKeyAuthBypassed).(bool); bypassed {
		return false
	}
	if scope, _ := ctx.UserValue(schemas.BifrostContextKeyTempTokenScope).(string); scope != "" {
		return false
	}
	session, _ := ctx.UserValue(schemas.BifrostContextKeySessionToken).(string)
	setup, _ := ctx.UserValue(schemas.BifrostContextKeySetupTokenAuthenticated).(bool)
	apiKey, _ := ctx.UserValue(schemas.IsAPIKeyAuthContextKey).(bool)
	return session != "" || setup || apiKey
}

// requireOSSManagementAuth 限定为真实管理身份，不接受 scoped temp token 或 inference VK。
func requireOSSManagementAuth(next fasthttp.RequestHandler) fasthttp.RequestHandler {
	return func(ctx *fasthttp.RequestCtx) {
		if !authorizeGuardrails(ctx, "management") {
			handlers.SendError(ctx, fasthttp.StatusForbidden, "Management authentication is required")
			return
		}
		next(ctx)
	}
}

// publishGuardrailManagement 原子替换 B 管理路由实例，已注册的宿主入口不会捕获旧插件。
func (s *BifrostHTTPServer) publishGuardrailManagement(p *guardrails.Plugin) {
	r := router.New()
	r.NotFound = func(ctx *fasthttp.RequestCtx) {
		handlers.SendError(ctx, fasthttp.StatusNotFound, "Guardrails management route not found")
	}
	r.MethodNotAllowed = func(ctx *fasthttp.RequestCtx) {
		handlers.SendError(ctx, fasthttp.StatusMethodNotAllowed, "Guardrails management method is not allowed")
	}
	handlers.NewGuardrailsHandler(p, authorizeGuardrails).RegisterRoutes(r)
	s.ossPluginManager.guardrails.Store(p)
	s.ossPluginManager.guardrailRoutes.Store(r)
}

// registerGuardrailRoutes 显式绑定管理方法，避免 UI 的 GET 通配路由遮蔽认证和当前插件 resolver。
func (s *BifrostHTTPServer) registerGuardrailRoutes(middlewares ...schemas.BifrostHTTPMiddleware) {
	dispatch := func(ctx *fasthttp.RequestCtx) {
		s.pluginChangeMu.Lock()
		defer s.pluginChangeMu.Unlock()
		if r := s.ossPluginManager.guardrailRoutes.Load(); r != nil {
			r.Handler(ctx)
			return
		}
		handlers.SendError(ctx, fasthttp.StatusServiceUnavailable, "Guardrails management is unavailable")
	}
	wrapped := lib.ChainMiddlewares(dispatch, append(middlewares, requireOSSManagementAuth)...)
	for _, method := range []string{fasthttp.MethodGet, fasthttp.MethodPost, fasthttp.MethodPut, fasthttp.MethodDelete} {
		s.Router.Handle(method, "/api/guardrails", wrapped)
		s.Router.Handle(method, "/api/guardrails/{path:*}", wrapped)
	}
}
