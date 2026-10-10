package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync/atomic"
	"time"

	"github.com/fasthttp/router"
	"github.com/maximhq/bifrost/core/keyselectors"
	"github.com/maximhq/bifrost/core/schemas"
	"github.com/maximhq/bifrost/framework/configstore"
	"github.com/maximhq/bifrost/framework/configstore/tables"
	"github.com/maximhq/bifrost/framework/guardrails"
	"github.com/maximhq/bifrost/framework/logstore"
	"github.com/maximhq/bifrost/framework/resilience"
	"github.com/maximhq/bifrost/plugins/governance"
	"github.com/maximhq/bifrost/transports/bifrost-http/handlers"
	"github.com/maximhq/bifrost/transports/bifrost-http/lib"
	"github.com/valyala/fasthttp"
	"gorm.io/gorm"
)

const adaptivePluginName = "adaptive-routing"
const circuitPluginName = "circuit-breaker"

type ossPluginManager struct {
	runtime         atomic.Pointer[resilience.Runtime]
	guardrails      atomic.Pointer[guardrails.Plugin]
	guardrailRoutes atomic.Pointer[router.Router]
	reveal          *guardrails.RevealManager
	refreshKeys     func(schemas.ModelProvider, string)
}

type resilienceConfigurationPlugin struct {
	name   string
	config resilience.Config
}

type hostResiliencePlugin struct{ *resilience.Plugin }

type hostRoutingDeniedKey struct{}

// PreRequestHook 保留普通 hook 的错误契约，并把失败状态交给可阻断的 PreLLMHook。
func (p *hostResiliencePlugin) PreRequestHook(ctx *schemas.BifrostContext, req *schemas.BifrostRequest) error {
	err := p.Plugin.PreRequestHook(ctx, req)
	if ctx != nil {
		ctx.SetValue(hostRoutingDeniedKey{}, err != nil)
	}
	return err
}

// PreLLMHook 把唯一实际 attempt 观察器交给 core，普通 plugin hook 仍沿 C 的实现。
func (p *hostResiliencePlugin) PreLLMHook(ctx *schemas.BifrostContext, req *schemas.BifrostRequest) (*schemas.BifrostRequest, *schemas.LLMPluginShortCircuit, error) {
	if denied, _ := ctx.Value(hostRoutingDeniedKey{}).(bool); denied {
		return req, &schemas.LLMPluginShortCircuit{Error: &schemas.BifrostError{
			IsBifrostError: true, StatusCode: schemas.Ptr(503), AllowFallbacks: schemas.Ptr(false),
			Error: &schemas.ErrorField{Message: "authorized routing policy could not be applied"},
		}}, nil
	}
	ctx.SetValue("bifrost-provider-attempt-observer", p)
	return p.Plugin.PreLLMHook(ctx, req)
}

// BeginProviderAttempt 对固定 key、轮换 key 和内部同 key 重试使用相同 lease 边界。
func (p *hostResiliencePlugin) BeginProviderAttempt(ctx *schemas.BifrostContext, provider schemas.ModelProvider, model, keyID string, rt schemas.RequestType) *schemas.BifrostError {
	if _, err := p.Runtime.BeginAttempt(ctx, provider, model, keyID, rt); err != nil {
		return &schemas.BifrostError{IsBifrostError: true, StatusCode: schemas.Ptr(503),
			Error: &schemas.ErrorField{Message: "provider attempt is unavailable"}}
	}
	return nil
}

// FinishProviderAttempt 只记录实际发送的结果，不把内部重试链总耗时当作单次延迟。
func (p *hostResiliencePlugin) FinishProviderAttempt(ctx *schemas.BifrostContext, resp *schemas.BifrostResponse, err *schemas.BifrostError, latency time.Duration) {
	observation := resilience.ObservationFromResponse(resp, err)
	observation.Latency = latency
	observation.Canceled = observation.Canceled || ctx.Err() != nil
	if len(observation.ResponseHeaders) == 0 {
		observation.ResponseHeaders, _ = ctx.Value(schemas.BifrostContextKeyProviderResponseHeaders).(map[string]string)
	}
	p.Runtime.ObserveAttempt(resilience.AttemptID(ctx), observation)
}

func (p *resilienceConfigurationPlugin) GetName() string { return p.name }
func (p *resilienceConfigurationPlugin) Cleanup() error  { return nil }

// filterKeys 将所有硬排除转为空池，不触发 core 的错误后未过滤兜底。
func (m *ossPluginManager) filterKeys(ctx *schemas.BifrostContext, provider schemas.ModelProvider, model string, keys []schemas.Key) ([]schemas.Key, error) {
	if r := m.runtime.Load(); r != nil {
		filtered, err := r.FilterKeys(ctx, provider, model, keys)
		if err != nil {
			return []schemas.Key{}, nil
		}
		return filtered, nil
	}
	return keys, nil
}

// selectKey 与过滤器读取同一宿主实例，不缓存可被删除的插件指针。
func (m *ossPluginManager) selectKey(ctx *schemas.BifrostContext, keys []schemas.Key, provider schemas.ModelProvider, model string) (schemas.Key, error) {
	if r := m.runtime.Load(); r != nil {
		return r.SelectKey(ctx, keys, provider, model)
	}
	return keyselectors.WeightedRandom(ctx, keys, provider, model)
}

// FilterProviders 只转发治理已经筛选的候选，不重新枚举 provider。
func (m *ossPluginManager) FilterProviders(ctx *schemas.BifrostContext, eligible []schemas.ProviderCandidate, model string) []schemas.ProviderCandidate {
	if m.refreshKeys != nil {
		for _, candidate := range eligible {
			m.refreshKeys(schemas.ModelProvider(candidate.Provider), model)
		}
	}
	if r := m.runtime.Load(); r != nil {
		return r.FilterProviders(ctx, eligible, model)
	}
	return eligible
}

// SelectProvider 与 key hooks 共享运行时，不持有可被管理接口替换的插件。
func (m *ossPluginManager) SelectProvider(ctx *schemas.BifrostContext, eligible []schemas.ProviderCandidate, model string) (schemas.ProviderCandidate, error) {
	if r := m.runtime.Load(); r != nil {
		return r.SelectProvider(ctx, eligible, model)
	}
	return schemas.ProviderCandidate{}, resilience.ErrUnavailable
}

// eligibleAdaptiveProviders 复用治理许可与预算门禁，再提供完整 model-capable key 元数据。
func (s *BifrostHTTPServer) eligibleAdaptiveProviders(ctx *schemas.BifrostContext, req *schemas.BifrostRequest) ([]schemas.ProviderCandidate, error) {
	gov, err := s.getGovernancePlugin()
	if err != nil {
		return nil, err
	}
	access, err := gov.ResolveAccess(ctx)
	if err != nil || access == nil {
		return nil, err
	}
	_, model, _ := req.GetRequestFields()
	out := []schemas.ProviderCandidate{}
	for _, candidate := range access.ProvidersForModel(model) {
		if decision, err := gov.GetGovernanceStore().CheckProviderCandidateExclusion(ctx, access, candidate, model); err != nil || decision != governance.DecisionAllow {
			continue
		}
		s.refreshResilienceKeyPool(schemas.ModelProvider(candidate.Provider), model)
		out = append(out, candidate)
	}
	return out, nil
}

// refineAdaptiveModel 使用既有 catalog 规范化，而不是为新功能猜测 model 别名。
func (s *BifrostHTTPServer) refineAdaptiveModel(provider schemas.ModelProvider, model string) (string, error) {
	if s.Config.ModelCatalog == nil {
		return model, nil
	}
	return s.Config.ModelCatalog.RefineModelForProvider(provider, model)
}

// refreshResilienceKeyPool 传入完整配置池，不能用请求的授权子池替代 provider 视图。
func (s *BifrostHTTPServer) refreshResilienceKeyPool(provider schemas.ModelProvider, model string) {
	keys, err := s.Config.GetProviderKeysRaw(provider)
	if err != nil {
		return
	}
	pool := make([]schemas.Key, 0, len(keys))
	for _, key := range keys {
		if keyEnabled(key) && key.Models.IsAllowed(model) && !key.BlacklistedModels.IsBlocked(model) {
			pool = append(pool, key)
		}
	}
	if runtime := s.ossPluginManager.runtime.Load(); runtime != nil {
		runtime.SetProviderModelKeys(provider, model, pool)
	}
}

// initializeOSSPluginManager 保持未启用开关为零值，以非空策略数组创建唯一运行时。
func (s *BifrostHTTPServer) initializeOSSPluginManager(ctx context.Context) error {
	if s.ossPluginManager != nil {
		return nil
	}
	cfg := resilience.DefaultConfig()
	cfg.LoadBalancer = resilience.AdaptiveConfig{}
	for _, name := range []string{adaptivePluginName, circuitPluginName} {
		row := s.getPluginConfig(name)
		if row == nil || !row.Enabled {
			continue
		}
		candidate, err := decodeResilienceSection(name, row.Config)
		if err != nil {
			return err
		}
		if name == adaptivePluginName {
			cfg.LoadBalancer = candidate.LoadBalancer
		} else {
			cfg.CircuitBreaker = candidate.CircuitBreaker
		}
	}
	r, err := resilience.New(cfg, logger)
	if err != nil {
		return err
	}
	s.ossPluginManager = &ossPluginManager{}
	s.ossPluginManager.reveal = guardrails.NewRevealManager(guardrails.FrameworkMappingCipher{}, authorizeGuardrailReveal)
	s.ossPluginManager.runtime.Store(r)
	s.ossPluginManager.refreshKeys = s.refreshResilienceKeyPool
	governance.SetLoadBalancePolicy(s.ossPluginManager)
	s.Config.HostPluginFactory = s.instantiateOSSPlugin
	s.Config.HostLogStore = func(store logstore.LogStore) logstore.LogStore {
		return &guardrailLogStore{LogStore: store, reveal: s.ossPluginManager.reveal}
	}
	for _, row := range s.Config.PluginConfigs {
		if !lib.IsHostManagedPlugin(row.Name) {
			continue
		}
		candidate, err := s.instantiateOSSPlugin(ctx, row.Name, row.Config)
		if err != nil {
			_ = r.Cleanup()
			return fmt.Errorf("invalid %s configuration: %w", row.Name, err)
		}
		_ = candidate.Cleanup()
	}
	if s.Config.ConfigStore != nil {
		err := s.Config.ConfigStore.ExecuteTransaction(ctx, func(tx *gorm.DB) error {
			for _, name := range s.Config.HostPluginDeletes {
				if err := s.Config.ConfigStore.DeletePlugin(ctx, name, tx); err != nil {
					return err
				}
			}
			for _, cfg := range s.Config.PluginConfigs {
				if !lib.IsHostManagedPlugin(cfg.Name) {
					continue
				}
				version := int16(1)
				if cfg.Version != nil {
					version = *cfg.Version
				}
				row := &tables.TablePlugin{Name: cfg.Name, Enabled: cfg.Enabled, Config: cfg.Config,
					Path: cfg.Path, Version: version, Placement: cfg.Placement, Order: cfg.Order}
				row.ConfigHash = s.Config.HostPluginHashes[cfg.Name]
				if err := s.Config.ConfigStore.UpsertPlugin(ctx, row, tx); err != nil {
					return err
				}
			}
			return nil
		})
		if err != nil {
			_ = r.Cleanup()
			return err
		}
		s.Config.HostPluginDeletes = nil
	}
	return nil
}

// decodeResilienceSection 保留另一命名空间的禁用开关和空策略数组，再严格校验完整候选。
func decodeResilienceSection(name string, value any) (resilience.Config, error) {
	data, err := json.Marshal(value)
	if err != nil {
		return resilience.Config{}, err
	}
	if value == nil {
		data = []byte("{}")
	}
	cfg := resilience.DefaultConfig()
	cfg.LoadBalancer = resilience.AdaptiveConfig{}
	switch name {
	case adaptivePluginName:
		cfg.LoadBalancer = resilience.DefaultConfig().LoadBalancer
		err = resilience.DecodeStrict(data, &cfg.LoadBalancer)
	case circuitPluginName:
		err = resilience.DecodeStrict(data, &cfg.CircuitBreaker)
	default:
		return cfg, fmt.Errorf("unknown resilience namespace")
	}
	if err != nil {
		return cfg, err
	}
	validated, err := json.Marshal(cfg)
	if err != nil {
		return cfg, err
	}
	return resilience.DecodeConfig(validated)
}

// instantiateOSSPlugin 只构造已验证候选，不修改正在服务的运行时。
func (s *BifrostHTTPServer) instantiateOSSPlugin(ctx context.Context, name string, value any) (schemas.BasePlugin, error) {
	if name == "guardrails" {
		return s.instantiateGuardrails(ctx, value)
	}
	cfg, err := decodeResilienceSection(name, value)
	if err != nil {
		return nil, err
	}
	return &resilienceConfigurationPlugin{name: name, config: cfg}, nil
}

// loadOSSPlugins 注册真实观测器与持久化配置插件，不受企业标记控制。
func (s *BifrostHTTPServer) loadOSSPlugins(ctx context.Context) error {
	if s.ossPluginManager == nil {
		if err := s.initializeOSSPluginManager(ctx); err != nil {
			return err
		}
	}
	r := s.ossPluginManager.runtime.Load()
	observer := &hostResiliencePlugin{Plugin: &resilience.Plugin{Runtime: r,
		EligibleTargets: s.eligibleCircuitTargets, EligibleProviders: s.eligibleAdaptiveProviders,
		RefineModel: s.refineAdaptiveModel}}
	if err := s.Config.ReloadPlugin(observer); err != nil {
		return err
	}
	s.Config.SetPluginOrderInfo(observer.GetName(), schemas.Ptr(schemas.PluginPlacementBuiltin), schemas.Ptr(6))
	s.Config.UpdatePluginOverallStatus(observer.GetName(), observer.GetName(), schemas.PluginStatusActive, nil, InferPluginTypes(observer))
	for _, name := range []string{"guardrails", adaptivePluginName, circuitPluginName} {
		row := s.getPluginConfig(name)
		if name == "guardrails" && row == nil {
			if err := s.registerPluginWithStatus(ctx, name, nil, &guardrails.Config{}, true); err != nil {
				return err
			}
			p, err := lib.FindPluginAs[*hostGuardrailPlugin](s.Config, name)
			if err != nil {
				return err
			}
			s.publishGuardrailManagement(p.Plugin)
			s.markPluginDisabled(name)
			continue
		}
		if row == nil || !row.Enabled {
			if name == "guardrails" {
				cfg, err := guardrails.DecodeConfig(row.Config)
				if err != nil {
					return err
				}
				cfg.Enabled = false
				candidate, err := s.instantiateGuardrails(ctx, cfg)
				if err != nil {
					return err
				}
				s.publishGuardrailManagement(candidate.(*hostGuardrailPlugin).Plugin)
			}
			s.markPluginDisabled(name)
			continue
		}
		value := row.Config
		if name == "guardrails" {
			cfg, err := guardrails.DecodeConfig(value)
			if err != nil {
				return err
			}
			cfg.Enabled = row.Enabled
			value = cfg
		}
		if err := s.registerPluginWithStatus(ctx, name, nil, value, true); err != nil {
			return err
		}
		if name == "guardrails" {
			p, err := lib.FindPluginAs[*hostGuardrailPlugin](s.Config, name)
			if err != nil {
				return err
			}
			s.publishGuardrailManagement(p.Plugin)
		}
		s.Config.SetPluginOrderInfo(name, schemas.Ptr(schemas.PluginPlacementBuiltin), schemas.Ptr(0))
	}
	return nil
}

// persistResilience 保存两个独立 section，不改写运行时状态或其他插件配置。
func (s *BifrostHTTPServer) persistResilience(ctx context.Context, cfg resilience.Config) error {
	if s.Config.ConfigStore == nil {
		return fmt.Errorf("configuration persistence is unavailable")
	}
	request, ok := ctx.(*fasthttp.RequestCtx)
	if !ok {
		return fmt.Errorf("management request context is required")
	}
	name, value := circuitPluginName, any(cfg.CircuitBreaker)
	if strings.HasPrefix(string(request.Path()), "/api/load-balancer-config") {
		name, value = adaptivePluginName, cfg.LoadBalancer
	}
	row, err := s.Config.ConfigStore.GetPlugin(ctx, name)
	if err != nil && !errors.Is(err, configstore.ErrNotFound) {
		return err
	}
	if row == nil {
		row = &tables.TablePlugin{Name: name}
	}
	row.Config, row.Enabled = value, true
	if err := s.Config.ConfigStore.UpsertPlugin(ctx, row); err != nil {
		return err
	}
	s.Config.UpdatePluginOverallStatus(name, name, schemas.PluginStatusActive, nil, nil)
	s.Config.RememberPluginConfig(row)
	return nil
}

// registerOSSManagementRoutes 使用既有管理认证中间件和实时运行时 resolver。
func (s *BifrostHTTPServer) registerOSSManagementRoutes(middlewares ...schemas.BifrostHTTPMiddleware) {
	serialize := func(next fasthttp.RequestHandler) fasthttp.RequestHandler {
		return func(ctx *fasthttp.RequestCtx) {
			s.pluginChangeMu.Lock()
			defer s.pluginChangeMu.Unlock()
			next(ctx)
		}
	}
	handlers.NewResilienceHandler(func() *resilience.Runtime {
		return s.ossPluginManager.runtime.Load()
	}, s.persistResilience).RegisterRoutes(s.Router, append(middlewares, requireOSSManagementAuth, serialize)...)
	s.registerGuardrailRoutes(middlewares...)
}

// applyResilienceSection 更新独立配置段，禁用 circuit 时保留可严格序列化的空策略数组。
func (s *BifrostHTTPServer) applyResilienceSection(plugin *resilienceConfigurationPlugin, enabled bool) error {
	r := s.ossPluginManager.runtime.Load()
	return r.ChangeConfig(func(cfg *resilience.Config) error {
		if plugin.name == adaptivePluginName {
			cfg.LoadBalancer = resilience.AdaptiveConfig{}
			if enabled {
				cfg.LoadBalancer = plugin.config.LoadBalancer
			}
		} else {
			cfg.CircuitBreaker = resilience.DefaultConfig().CircuitBreaker
			if enabled {
				cfg.CircuitBreaker = plugin.config.CircuitBreaker
			}
		}
		return nil
	}, func(resilience.Config) error { return nil })
}

// eligibleCircuitTargets 对策略目标重新应用真实访问许可和预算过滤。
func (s *BifrostHTTPServer) eligibleCircuitTargets(ctx *schemas.BifrostContext, req *schemas.BifrostRequest) ([]schemas.Fallback, error) {
	gov, err := s.getGovernancePlugin()
	if err != nil {
		return nil, err
	}
	access, err := gov.ResolveAccess(ctx)
	if err != nil {
		return nil, err
	}
	provider, model, fallbacks := req.GetRequestFields()
	targets := append([]schemas.Fallback{{Provider: provider, Model: model}}, fallbacks...)
	for _, policy := range s.ossPluginManager.runtime.Load().GetConfig().CircuitBreaker.Policies {
		if policy.FallbackProvider != "" {
			targets = append(targets, schemas.Fallback{Provider: schemas.ModelProvider(policy.FallbackProvider), Model: policy.FallbackModel})
		}
	}
	out := make([]schemas.Fallback, 0, len(targets))
	for _, target := range targets {
		if target.Provider == "" || target.Model == "" {
			continue
		}
		s.Config.Mu.RLock()
		_, configured := s.Config.Providers[target.Provider]
		s.Config.Mu.RUnlock()
		if !configured {
			continue
		}
		if access == nil {
			out = append(out, target)
			continue
		}
		for _, candidate := range access.ProvidersForModel(target.Model) {
			if candidate.Provider != string(target.Provider) {
				continue
			}
			if decision, err := gov.GetGovernanceStore().CheckProviderCandidateExclusion(ctx, access, candidate, target.Model); err == nil && decision == governance.DecisionAllow {
				out = append(out, target)
			}
		}
	}
	return out, nil
}
