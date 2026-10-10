package resilience

import (
	"context"
	"fmt"
	"math"
	"math/rand/v2"
	"slices"
	"strings"
	"time"

	"github.com/maximhq/bifrost/core/keyselectors"
	"github.com/maximhq/bifrost/core/schemas"
)

type contextKey string

const (
	attemptContextKey         contextKey                = "resilience-attempt"
	typeContextKey            contextKey                = "resilience-request-type"
	forcedCheckKey            contextKey                = "resilience-held-check-key"
	ProviderKeylessContextKey schemas.BifrostContextKey = "resilience-provider-keyless"
)

// BypassRequest 保持已有任务身份，不因健康状态改变查询、下载或取消的目标。
func BypassRequest(rt schemas.RequestType) bool {
	switch rt {
	case schemas.VideoRetrieveRequest, schemas.VideoDownloadRequest, schemas.VideoDeleteRequest, schemas.VideoListRequest,
		schemas.BatchRetrieveRequest, schemas.BatchResultsRequest, schemas.BatchCancelRequest, schemas.BatchListRequest,
		schemas.ResponsesRetrieveRequest, schemas.ResponsesCancelRequest, schemas.ResponsesDeleteRequest:
		return true
	}
	return false
}

func requestType(ctx *schemas.BifrostContext) schemas.RequestType {
	if ctx == nil {
		return ""
	}
	if rt, ok := ctx.Value(typeContextKey).(schemas.RequestType); ok {
		return rt
	}
	rt, _ := ctx.Value(schemas.BifrostContextKeyHTTPRequestType).(schemas.RequestType)
	return rt
}

func pinnedKey(ctx *schemas.BifrostContext, key schemas.Key) bool {
	if ctx == nil {
		return false
	}
	if id := requestKeyID(ctx); id != "" {
		return key.ID == id
	}
	name, _ := ctx.Value(schemas.BifrostContextKeyAPIKeyName).(string)
	return name != "" && key.Name == name
}

func hasKeyPin(ctx *schemas.BifrostContext) bool {
	if ctx == nil {
		return false
	}
	id := requestKeyID(ctx)
	name, _ := ctx.Value(schemas.BifrostContextKeyAPIKeyName).(string)
	return id != "" || name != ""
}

// requestKeyID 与 core 的路由规则提交顺序一致，优先读取尚未提交的规则 pin。
func requestKeyID(ctx *schemas.BifrostContext) string {
	if ctx == nil {
		return ""
	}
	if id, _ := ctx.Value(schemas.BifrostContextKeyRoutingPinnedAPIKeyID).(string); strings.TrimSpace(id) != "" {
		return strings.TrimSpace(id)
	}
	id, _ := ctx.Value(schemas.BifrostContextKeyAPIKeyID).(string)
	return strings.TrimSpace(id)
}

func policyMatches(p compiledPolicy, t target) bool {
	return (p.Enabled == nil || *p.Enabled) && p.PrimaryProvider == string(t.provider) && p.PrimaryModel == t.model
}

func policyCircuitID(p compiledPolicy, t target) (circuitID, bool) {
	if !policyMatches(p, t) {
		return circuitID{}, false
	}
	if len(p.PrimaryKeyIDs) == 0 {
		t.key = ""
	} else if t.key == "" || !slices.Contains(p.PrimaryKeyIDs, t.key) {
		return circuitID{}, false
	}
	return circuitID{policy: p.Name, target: t}, true
}

func (r *Runtime) availableLocked(t target, now time.Time, id uint64, ignoreHold bool) bool {
	for _, p := range r.config.Load().policies {
		cid, ok := policyCircuitID(p, t)
		if !ok && t.key == "" && policyMatches(p, t) && len(p.PrimaryKeyIDs) > 0 {
			allOpen := true
			for _, key := range p.PrimaryKeyIDs {
				perKey := t
				perKey.key = key
				c := r.circuits[circuitID{policy: p.Name, target: perKey}]
				if c == nil || c.state == Closed || (!now.Before(c.openUntil) && (c.probe == 0 || c.probe == id)) {
					allOpen = false
					break
				}
			}
			if allOpen {
				return false
			}
		}
		if !ok {
			continue
		}
		if c := r.circuits[cid]; c != nil && c.state != Closed {
			if now.Before(c.openUntil) || (c.probe != 0 && c.probe != id) {
				return false
			}
		}
	}
	if t.key == "" {
		return true
	}
	for _, held := range []target{t, {provider: t.provider, key: t.key}} {
		if h := r.holds[held]; h != nil && h.released.IsZero() {
			if h.probe != 0 && h.probe != id {
				return false
			}
			if !ignoreHold && now.Before(h.until) {
				return false
			}
		}
	}
	return true
}

// FilterKeys 只缩小调用方已经授权和筛选的池，不重新枚举 key 或扩大 scope。
func (r *Runtime) FilterKeys(ctx *schemas.BifrostContext, provider schemas.ModelProvider, model string, keys []schemas.Key) ([]schemas.Key, error) {
	if BypassRequest(requestType(ctx)) {
		return slices.Clone(keys), nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return []schemas.Key{}, nil
	}
	id := AttemptID(ctx)
	now := time.Now()
	out := make([]schemas.Key, 0, len(keys))
	for _, key := range keys {
		if hasKeyPin(ctx) && !pinnedKey(ctx, key) {
			continue
		}
		if r.availableLocked(target{provider, model, key.ID}, now, id, pinnedKey(ctx, key)) {
			out = append(out, key)
		}
	}
	if len(out) == 0 {
		// All-held is a live check, never an escape from a header circuit.
		for _, key := range keys {
			t := target{provider, model, key.ID}
			if (hasKeyPin(ctx) && !pinnedKey(ctx, key)) || !r.availableLocked(t, now, id, true) {
				continue
			}
			free := true
			for _, held := range []target{t, {provider: provider, key: key.ID}} {
				if h := r.holds[held]; h != nil && h.released.IsZero() && h.probe != 0 && h.probe != id {
					free = false
				}
			}
			if free && ctx != nil {
				ctx.SetValue(forcedCheckKey, key.ID)
				return []schemas.Key{key}, nil
			}
		}
		return []schemas.Key{}, nil
	}
	return out, nil
}

// SelectKey 使用预计算权重乘原权重；仅中选 key 原子占有 half-open 探测。
func (r *Runtime) SelectKey(ctx *schemas.BifrostContext, keys []schemas.Key, provider schemas.ModelProvider, model string) (schemas.Key, error) {
	pool, err := r.FilterKeys(ctx, provider, model, keys)
	if err != nil {
		return schemas.Key{}, err
	}
	bypass := BypassRequest(requestType(ctx))
	for len(pool) > 0 {
		weights := make([]float64, len(pool))
		for i, key := range pool {
			weight := key.Weight
			if math.IsNaN(weight) || math.IsInf(weight, 0) || weight < 0 {
				return schemas.Key{}, fmt.Errorf("invalid key weight for key %s", key.ID)
			}
			if r.config.Load().config.LoadBalancer.RouteSelectionEnabled && !bypass {
				weight *= r.factor(target{provider, model, key.ID})
			}
			weights[i] = weight
		}
		index := weightedIndex(weights)
		if !r.config.Load().config.LoadBalancer.RouteSelectionEnabled || bypass {
			selected, selectErr := keyselectors.WeightedRandom(ctx, pool, provider, model)
			if selectErr != nil {
				return schemas.Key{}, selectErr
			}
			index = slices.IndexFunc(pool, func(key schemas.Key) bool { return key.ID == selected.ID })
		}
		if hasKeyPin(ctx) || len(pool) == 1 {
			index = 0
		}
		if index < 0 {
			return schemas.Key{}, ErrUnavailable
		}
		selected := pool[index]
		if bypass {
			return selected, nil
		}
		if _, err := r.bindKey(ctx, target{provider, model, selected.ID}); err == nil {
			return selected, nil
		}
		pool = slices.Delete(pool, index, index+1)
	}
	return schemas.Key{}, ErrUnavailable
}

func weightedIndex(weights []float64) int {
	total := 0.0
	for _, weight := range weights {
		total += weight
	}
	if len(weights) == 0 {
		return -1
	}
	if total == 0 {
		return rand.IntN(len(weights))
	}
	if total < 0 {
		return -1
	}
	if math.IsInf(total, 0) {
		maximum := slices.Max(weights)
		normalized := make([]float64, len(weights))
		for i, weight := range weights {
			normalized[i] = weight / maximum
		}
		return weightedIndex(normalized)
	}
	value := rand.Float64() * total
	for i, weight := range weights {
		if weight <= 0 {
			continue
		}
		value -= weight
		if value < 0 {
			return i
		}
	}
	return -1
}

// FilterProviders 保留输入候选与 key scope，未知/未观测 key 不被当作失败。
func (r *Runtime) FilterProviders(ctx *schemas.BifrostContext, eligible []schemas.ProviderCandidate, model string) []schemas.ProviderCandidate {
	if BypassRequest(requestType(ctx)) {
		return slices.Clone(eligible)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]schemas.ProviderCandidate, 0, len(eligible))
	checkable := make([]schemas.ProviderCandidate, 0, len(eligible))
	now := time.Now()
	for _, candidate := range eligible {
		t := target{provider: schemas.ModelProvider(candidate.Provider), model: model}
		if !r.availableLocked(t, now, AttemptID(ctx), true) {
			continue
		}
		keyIDs, keyless := r.candidateKeysLocked(ctx, candidate, model)
		allBlocked, canCheck := !keyless, keyless
		for _, keyID := range keyIDs {
			t.key = keyID
			if r.availableLocked(t, now, AttemptID(ctx), false) {
				allBlocked = false
			}
			if r.availableLocked(t, now, AttemptID(ctx), true) {
				canCheck = true
			}
		}
		if canCheck {
			checkable = append(checkable, candidate)
		}
		if allBlocked {
			continue
		}
		out = append(out, candidate)
	}
	if len(out) == 0 {
		return checkable
	}
	return out
}

// SelectProvider 仅对已通过 governance 授权和预算的候选加权，不修改请求意图。
func (r *Runtime) SelectProvider(ctx *schemas.BifrostContext, eligible []schemas.ProviderCandidate, model string) (schemas.ProviderCandidate, error) {
	pool := r.FilterProviders(ctx, eligible, model)
	pool = slices.DeleteFunc(slices.Clone(pool), func(candidate schemas.ProviderCandidate) bool { return candidate.Weight == nil })
	weights := make([]float64, len(pool))
	for i, candidate := range pool {
		if candidate.Weight == nil {
			continue
		}
		weight := *candidate.Weight
		if weight < 0 || math.IsNaN(weight) || math.IsInf(weight, 0) {
			return schemas.ProviderCandidate{}, fmt.Errorf("invalid provider weight for %s", candidate.Provider)
		}
		if r.config.Load().config.LoadBalancer.DirectionSelectionEnabled {
			weight *= r.factor(target{provider: schemas.ModelProvider(candidate.Provider), model: model})
		}
		weights[i] = weight
	}
	if i := weightedIndex(weights); i >= 0 {
		return pool[i], nil
	}
	return schemas.ProviderCandidate{}, ErrUnavailable
}

// BeginAttempt 每次真实上游调用创建独立租约；集成方须先结算上一 attempt。
func (r *Runtime) BeginAttempt(ctx *schemas.BifrostContext, provider schemas.ModelProvider, model, keyID string, rt schemas.RequestType) (uint64, error) {
	if ctx == nil {
		return 0, fmt.Errorf("attempt context is required")
	}
	if BypassRequest(rt) {
		return 0, nil
	}
	if pinned := requestKeyID(ctx); pinned != "" && keyID != "" && pinned != keyID {
		return 0, fmt.Errorf("attempt key does not match the explicit key pin")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.releaseLocked(AttemptID(ctx))
	id := r.next.Add(1)
	t := target{provider, model, keyID}
	forced, _ := ctx.Value(forcedCheckKey).(string)
	if r.closed || ctx.Err() != nil || !r.availableLocked(t, time.Now(), id, hasKeyPin(ctx) || (keyID != "" && forced == keyID)) {
		return 0, ErrUnavailable
	}
	a := &attempt{target: t, requestType: rt, started: time.Now(), generation: r.generations[target{provider: provider, key: keyID}],
		holdEpoch: r.holdEpochs[t], keyEpoch: r.holdEpochs[target{provider: provider, key: keyID}], config: r.config.Load()}
	r.attempts[id] = a
	r.reserveLocked(id, a)
	a.stop = context.AfterFunc(ctx, func() { r.CancelAttempt(id) })
	ctx.SetValue(attemptContextKey, id)
	ctx.SetValue(typeContextKey, rt)
	return id, nil
}

// bindKey 将选中 key 绑定到本次 attempt，保留之前已获得的 provider probe。
func (r *Runtime) bindKey(ctx *schemas.BifrostContext, t target) (uint64, error) {
	r.mu.Lock()
	id := AttemptID(ctx)
	a := r.attempts[id]
	if a == nil || a.target.provider != t.provider || a.target.model != t.model || a.target.key != "" {
		r.mu.Unlock()
		return r.BeginAttempt(ctx, t.provider, t.model, t.key, requestType(ctx))
	}
	defer r.mu.Unlock()
	forced, _ := ctx.Value(forcedCheckKey).(string)
	if !r.availableLocked(t, time.Now(), id, hasKeyPin(ctx) || forced == t.key) {
		return 0, ErrUnavailable
	}
	a.target = t
	a.generation = r.generations[target{provider: t.provider, key: t.key}]
	a.holdEpoch = r.holdEpochs[t]
	a.keyEpoch = r.holdEpochs[target{provider: t.provider, key: t.key}]
	r.reserveLocked(id, a)
	return id, nil
}

func (r *Runtime) reserveLocked(id uint64, a *attempt) {
	now := time.Now()
	for _, p := range r.config.Load().policies {
		cid, ok := policyCircuitID(p, a.target)
		if !ok {
			continue
		}
		if c := r.circuits[cid]; c != nil && c.state != Closed && !now.Before(c.openUntil) {
			c.state, c.probe, c.updated = HalfOpen, id, now
			if !slices.Contains(a.circuits, cid) {
				a.circuits = append(a.circuits, cid)
			}
		}
	}
	if a.target.key == "" {
		return
	}
	for _, t := range []target{a.target, {provider: a.target.provider, key: a.target.key}} {
		if h := r.holds[t]; h != nil && h.released.IsZero() {
			h.probe, h.updated = id, now
			if !slices.Contains(a.holds, t) {
				a.holds = append(a.holds, t)
			}
		}
	}
}

func AttemptID(ctx *schemas.BifrostContext) uint64 {
	if ctx == nil {
		return 0
	}
	id, _ := ctx.Value(attemptContextKey).(uint64)
	return id
}

func normalizedHeaders(headers map[string]string) map[string]string {
	out := make(map[string]string, len(headers))
	for name, value := range headers {
		out[strings.ToLower(name)] = value
	}
	return out
}
