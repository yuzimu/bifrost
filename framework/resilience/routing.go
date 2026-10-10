package resilience

import (
	"slices"
	"sort"
	"time"

	"github.com/maximhq/bifrost/core/schemas"
)

type ModelRefiner func(schemas.ModelProvider, string) (string, error)

// RouteRequest 只处理已授权同一模型的候选；方向关闭时不修改 provider 或 fallback。
func (r *Runtime) RouteRequest(ctx *schemas.BifrostContext, req *schemas.BifrostRequest, eligible []schemas.ProviderCandidate, refine ModelRefiner) error {
	cfg := r.config.Load().config.LoadBalancer
	if req == nil || !cfg.DirectionSelectionEnabled || BypassRequest(req.RequestType) || hasKeyPin(ctx) {
		return nil
	}
	provider, model, existing := req.GetRequestFields()
	if model == "" {
		return nil
	}
	pool := r.FilterProviders(ctx, eligible, model)
	originalProvider := provider
	pinned := provider != ""
	primary := schemas.ProviderCandidate{Provider: string(provider)}
	known := false
	for _, candidate := range eligible {
		if candidate.Provider == string(provider) {
			primary, known = candidate, true
			break
		}
	}
	failed := known && !r.candidateAvailable(ctx, primary, model)
	reroute := pinned && cfg.RerouteFailedDirections && failed
	if pinned && !cfg.AppendFallbacksToPinned && !reroute {
		return nil
	}
	if !pinned || reroute {
		selection := pool
		if reroute {
			selection = nil
			for _, candidate := range pool {
				if candidate.Provider != string(provider) && r.candidateAvailable(ctx, candidate, model) {
					selection = append(selection, candidate)
				}
			}
		}
		if len(selection) > 0 {
			selected, err := r.SelectProvider(ctx, selection, model)
			if err != nil {
				return err
			}
			provider = schemas.ModelProvider(selected.Provider)
		} else if !pinned {
			return ErrUnavailable
		}
	}
	refineModel := func(p schemas.ModelProvider, m string) (string, error) {
		if refine != nil {
			return refine(p, m)
		}
		return m, nil
	}
	primaryModel, err := refineModel(provider, model)
	if err != nil {
		return err
	}
	// Existing creation attempts must not acquire a newly synthesized retry chain.
	mediaCreation := req.RequestType == schemas.VideoGenerationRequest || req.RequestType == schemas.VideoEditRequest ||
		req.RequestType == schemas.VideoRemixRequest || req.RequestType == schemas.ImageGenerationRequest ||
		req.RequestType == schemas.ImageGenerationStreamRequest || req.RequestType == schemas.ImageEditRequest ||
		req.RequestType == schemas.ImageEditStreamRequest || req.RequestType == schemas.ImageVariationRequest
	if pinned && mediaCreation {
		return nil
	}
	fallbacks := make([]schemas.Fallback, 0, len(existing)+len(pool))
	seen := map[schemas.Fallback]bool{{Provider: provider, Model: primaryModel, KeyID: requestKeyID(ctx)}: true}
	for _, fallback := range existing {
		fallbackModel, err := refineModel(fallback.Provider, fallback.Model)
		if err != nil {
			return err
		}
		fallback.Model = fallbackModel
		if cfg.PruneFailedFallbacks {
			candidate := schemas.ProviderCandidate{Provider: string(fallback.Provider)}
			available := false
			for _, allowed := range eligible {
				if allowed.Provider == candidate.Provider {
					if fallback.KeyID != "" {
						if !slices.Contains(allowed.KeyIDs, "*") && !slices.Contains(allowed.KeyIDs, fallback.KeyID) {
							continue
						}
						allowed.KeyIDs = schemas.WhiteList{fallback.KeyID}
					}
					if r.candidateAvailable(ctx, allowed, fallback.Model) {
						available = true
						break
					}
				}
			}
			if !available {
				continue
			}
		}
		if !seen[fallback] {
			fallbacks = append(fallbacks, fallback)
			seen[fallback] = true
		}
	}
	if !mediaCreation {
		sort.SliceStable(pool, func(i, j int) bool {
			return r.factor(target{provider: schemas.ModelProvider(pool[i].Provider), model: model}) >
				r.factor(target{provider: schemas.ModelProvider(pool[j].Provider), model: model})
		})
		for _, candidate := range pool {
			if candidate.Provider == string(provider) || !r.candidateAvailable(ctx, candidate, model) {
				continue
			}
			p := schemas.ModelProvider(candidate.Provider)
			m, err := refineModel(p, model)
			if err != nil {
				return err
			}
			fallback := schemas.Fallback{Provider: p, Model: m}
			if !seen[fallback] {
				fallbacks = append(fallbacks, fallback)
				seen[fallback] = true
			}
		}
	}
	if pinned && provider != originalProvider && !reroute {
		return ErrUnavailable
	}
	req.SetProvider(provider)
	req.SetModel(primaryModel)
	req.SetFallbacks(fallbacks)
	return nil
}

// candidateAvailable 不使用 all-held 的最终兜底，供方向重路由与 fallback 剪枝判断。
func (r *Runtime) candidateAvailable(ctx *schemas.BifrostContext, candidate schemas.ProviderCandidate, model string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	t := target{provider: schemas.ModelProvider(candidate.Provider), model: model}
	now := time.Now()
	if !r.availableLocked(t, now, AttemptID(ctx), true) {
		return false
	}
	keys, keyless := r.candidateKeysLocked(ctx, candidate, model)
	for _, key := range keys {
		t.key = key
		if r.availableLocked(t, now, AttemptID(ctx), false) {
			return true
		}
	}
	return keyless
}

// candidateKeysLocked 区分明确无 key 的能力和空授权集；完整池只能收窄通配授权。
func (r *Runtime) candidateKeysLocked(ctx *schemas.BifrostContext, candidate schemas.ProviderCandidate, model string) ([]string, bool) {
	if ctx != nil {
		if capabilities, ok := ctx.Value(ProviderKeylessContextKey).(map[schemas.ModelProvider]bool); ok &&
			capabilities[schemas.ModelProvider(candidate.Provider)] {
			return nil, true
		}
	}
	if len(candidate.KeyIDs) == 0 {
		return nil, false
	}
	t := target{provider: schemas.ModelProvider(candidate.Provider), model: model}
	pool, known := r.keyPools[t]
	if slices.Contains(candidate.KeyIDs, "*") {
		if known {
			return pool.keys, false
		}
		// 未提供完整池时保留通配授权，不能将它用于证明空集有权访问。
		return []string{""}, false
	}
	if !known {
		return candidate.KeyIDs, false
	}
	keys := make([]string, 0, len(candidate.KeyIDs))
	for _, id := range candidate.KeyIDs {
		if slices.Contains(pool.keys, id) {
			keys = append(keys, id)
		}
	}
	return keys, false
}
