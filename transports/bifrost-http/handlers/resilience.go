package handlers

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/fasthttp/router"
	"github.com/maximhq/bifrost/core/schemas"
	"github.com/maximhq/bifrost/framework/resilience"
	"github.com/maximhq/bifrost/transports/bifrost-http/lib"
	"github.com/valyala/fasthttp"
)

type ResilienceResolver func() *resilience.Runtime
type ResiliencePersister func(context.Context, resilience.Config) error

type ResilienceHandler struct {
	resolve ResilienceResolver
	persist ResiliencePersister
}

var (
	errResilienceConflict = errors.New("policy already exists")
	errResilienceMissing  = errors.New("policy not found")
)

// NewResilienceHandler 通过 resolver 跟随插件生命周期；写操作要求现有配置存储回调。
func NewResilienceHandler(resolve ResilienceResolver, persist ResiliencePersister) *ResilienceHandler {
	return &ResilienceHandler{resolve: resolve, persist: persist}
}

// RegisterRoutes 所有管理路由均使用调用方提供的认证与资源权限 middleware。
func (h *ResilienceHandler) RegisterRoutes(r *router.Router, middlewares ...schemas.BifrostHTTPMiddleware) {
	r.GET("/api/load-balancer-config", lib.ChainMiddlewares(h.getLoadBalancer, middlewares...))
	r.PUT("/api/load-balancer-config", lib.ChainMiddlewares(h.putLoadBalancer, middlewares...))
	r.POST("/api/load-balancer-config/conditions/clear", lib.ChainMiddlewares(h.clearHeld, middlewares...))
	r.GET("/api/adaptive-routing", lib.ChainMiddlewares(h.getAdaptiveSnapshot, middlewares...))
	r.GET("/api/circuit-breaker/policies", lib.ChainMiddlewares(h.listPolicies, middlewares...))
	r.POST("/api/circuit-breaker/policies", lib.ChainMiddlewares(h.createPolicy, middlewares...))
	r.PUT("/api/circuit-breaker/policies/{name}", lib.ChainMiddlewares(h.updatePolicy, middlewares...))
	r.DELETE("/api/circuit-breaker/policies/{name}", lib.ChainMiddlewares(h.deletePolicy, middlewares...))
	r.GET("/api/circuit-breaker/state", lib.ChainMiddlewares(h.getCircuitState, middlewares...))
}

func (h *ResilienceHandler) runtime(ctx *fasthttp.RequestCtx) *resilience.Runtime {
	if h.resolve != nil {
		if runtime := h.resolve(); runtime != nil {
			return runtime
		}
	}
	SendError(ctx, fasthttp.StatusServiceUnavailable, "resilience plugin is not loaded")
	return nil
}

func (h *ResilienceHandler) getLoadBalancer(ctx *fasthttp.RequestCtx) {
	if r := h.runtime(ctx); r != nil {
		SendJSON(ctx, r.GetConfig().LoadBalancer)
	}
}

// change 将持久化失败与配置错误区分，成功持久化后才应用 immutable 配置。
func (h *ResilienceHandler) change(ctx *fasthttp.RequestCtx, r *resilience.Runtime, change func(*resilience.Config) error) bool {
	if h.persist == nil {
		SendError(ctx, fasthttp.StatusServiceUnavailable, "resilience configuration persistence is not configured")
		return false
	}
	var storageError error
	err := r.ChangeConfig(change, func(config resilience.Config) error {
		storageError = h.persist(ctx, config)
		return storageError
	})
	if err == nil {
		return true
	}
	status := fasthttp.StatusBadRequest
	if errors.Is(err, errResilienceConflict) {
		status = fasthttp.StatusConflict
	} else if errors.Is(err, errResilienceMissing) {
		status = fasthttp.StatusNotFound
	} else if storageError != nil {
		status = fasthttp.StatusInternalServerError
	}
	if storageError != nil {
		SendError(ctx, status, "failed to persist resilience configuration")
	} else {
		SendError(ctx, status, err.Error())
	}
	return false
}

// putLoadBalancer 按公开 API 的 full replacement 语义处理五个开关。
func (h *ResilienceHandler) putLoadBalancer(ctx *fasthttp.RequestCtx) {
	r := h.runtime(ctx)
	if r == nil {
		return
	}
	var config resilience.AdaptiveConfig
	if err := resilience.DecodeStrict(ctx.PostBody(), &config); err != nil {
		SendError(ctx, fasthttp.StatusBadRequest, err.Error())
		return
	}
	if h.change(ctx, r, func(cfg *resilience.Config) error { cfg.LoadBalancer = config; return nil }) {
		SendJSON(ctx, r.GetConfig().LoadBalancer)
	}
}

func (h *ResilienceHandler) getAdaptiveSnapshot(ctx *fasthttp.RequestCtx) {
	if r := h.runtime(ctx); r != nil {
		SendJSON(ctx, r.GetSnapshot())
	}
}

// clearHeld 空 body 清全部；字段依赖由 runtime 验证。
func (h *ResilienceHandler) clearHeld(ctx *fasthttp.RequestCtx) {
	r := h.runtime(ctx)
	if r == nil {
		return
	}
	var filter resilience.ClearConditions
	if len(ctx.PostBody()) > 0 {
		if err := resilience.DecodeStrict(ctx.PostBody(), &filter); err != nil {
			SendError(ctx, fasthttp.StatusBadRequest, err.Error())
			return
		}
	}
	cleared, err := r.ClearHeldKeys(filter)
	if err != nil {
		SendError(ctx, fasthttp.StatusBadRequest, err.Error())
		return
	}
	SendJSON(ctx, struct {
		Cleared []string `json:"cleared"`
		Count   int      `json:"count"`
	}{cleared, len(cleared)})
}

type resiliencePolicyResponse struct {
	resilience.Policy
	DefaultCooldown int64 `json:"default_cooldown"`
}

func policyResponse(p resilience.Policy) resiliencePolicyResponse {
	duration, _ := time.ParseDuration(p.DefaultCooldown)
	return resiliencePolicyResponse{Policy: p, DefaultCooldown: int64(duration)}
}

func (h *ResilienceHandler) listPolicies(ctx *fasthttp.RequestCtx) {
	r := h.runtime(ctx)
	if r == nil {
		return
	}
	policies := []resiliencePolicyResponse{}
	for _, p := range r.GetConfig().CircuitBreaker.Policies {
		policies = append(policies, policyResponse(p))
	}
	SendJSON(ctx, struct {
		Policies []resiliencePolicyResponse `json:"policies"`
		Count    int                        `json:"count"`
	}{policies, len(policies)})
}

// writePolicy 实现创建冲突、路径名称一致和替换缺失检查。
func (h *ResilienceHandler) writePolicy(ctx *fasthttp.RequestCtx, update bool) {
	r := h.runtime(ctx)
	if r == nil {
		return
	}
	var policy resilience.Policy
	if err := resilience.DecodeStrict(ctx.PostBody(), &policy); err != nil {
		SendError(ctx, fasthttp.StatusBadRequest, err.Error())
		return
	}
	if update {
		name, _ := ctx.UserValue("name").(string)
		if policy.Name != "" && policy.Name != name {
			SendError(ctx, fasthttp.StatusBadRequest, "policy name must match the URL")
			return
		}
		policy.Name = name
	}
	ok := h.change(ctx, r, func(cfg *resilience.Config) error {
		for i, existing := range cfg.CircuitBreaker.Policies {
			if strings.EqualFold(existing.Name, policy.Name) {
				if !update {
					return errResilienceConflict
				}
				cfg.CircuitBreaker.Policies[i] = policy
				return nil
			}
		}
		if update {
			return errResilienceMissing
		}
		cfg.CircuitBreaker.Policies = append(cfg.CircuitBreaker.Policies, policy)
		return nil
	})
	if ok {
		status := fasthttp.StatusCreated
		if update {
			status = fasthttp.StatusOK
		}
		for _, saved := range r.GetConfig().CircuitBreaker.Policies {
			if strings.EqualFold(saved.Name, policy.Name) {
				SendJSONWithStatus(ctx, policyResponse(saved), status)
				return
			}
		}
	}
}

func (h *ResilienceHandler) createPolicy(ctx *fasthttp.RequestCtx) { h.writePolicy(ctx, false) }
func (h *ResilienceHandler) updatePolicy(ctx *fasthttp.RequestCtx) { h.writePolicy(ctx, true) }

// deletePolicy 通过配置替换同步清理该 policy 的 circuit。
func (h *ResilienceHandler) deletePolicy(ctx *fasthttp.RequestCtx) {
	r := h.runtime(ctx)
	if r == nil {
		return
	}
	name, _ := ctx.UserValue("name").(string)
	if h.change(ctx, r, func(cfg *resilience.Config) error {
		for i, policy := range cfg.CircuitBreaker.Policies {
			if strings.EqualFold(name, policy.Name) {
				cfg.CircuitBreaker.Policies = append(cfg.CircuitBreaker.Policies[:i], cfg.CircuitBreaker.Policies[i+1:]...)
				return nil
			}
		}
		return errResilienceMissing
	}) {
		SendJSON(ctx, struct {
			Message string `json:"message"`
		}{"policy deleted"})
	}
}

func (h *ResilienceHandler) getCircuitState(ctx *fasthttp.RequestCtx) {
	if r := h.runtime(ctx); r != nil {
		SendJSON(ctx, struct {
			Circuits map[string]resilience.CircuitSnapshot `json:"circuits"`
		}{r.GetSnapshot().Circuits})
	}
}
