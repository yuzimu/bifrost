package resilience

import (
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/maximhq/bifrost/core/schemas"
)

type CircuitSnapshot struct {
	Status    CircuitState `json:"status"`
	OpenedAt  time.Time    `json:"opened_at"`
	Cooldown  int64        `json:"cooldown"`
	ExpiresAt time.Time    `json:"expires_at"`
}

type RouteSnapshot struct {
	Provider        schemas.ModelProvider `json:"provider"`
	Model           string                `json:"model"`
	KeyID           string                `json:"key_id,omitempty"`
	State           HealthState           `json:"state"`
	Factor          float64               `json:"adaptive_factor"`
	Requests        uint64                `json:"requests"`
	Errors          uint64                `json:"errors"`
	ErrorRate       float64               `json:"error_rate"`
	Latency         float64               `json:"latency_per_100_tokens_ms"`
	TokensPerSecond float64               `json:"tokens_per_second"`
	LastSeen        time.Time             `json:"last_seen"`
}

type HoldSnapshot struct {
	Provider schemas.ModelProvider `json:"provider"`
	Model    string                `json:"model,omitempty"`
	KeyID    string                `json:"key_id"`
	Reason   schemas.FailureClass  `json:"failure_class"`
	Since    time.Time             `json:"held_at"`
	Due      time.Time             `json:"check_due_at"`
	Checking bool                  `json:"checking"`
}

type Snapshot struct {
	Routes   []RouteSnapshot            `json:"routes"`
	HeldKeys []HoldSnapshot             `json:"held_keys"`
	Circuits map[string]CircuitSnapshot `json:"circuits"`
}

// GetSnapshot 只暴露 key ID 与统计量，closed circuit 不出现在官方状态 map。
func (r *Runtime) GetSnapshot() Snapshot {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := time.Now()
	out := Snapshot{Routes: []RouteSnapshot{}, HeldKeys: []HoldSnapshot{}, Circuits: make(map[string]CircuitSnapshot)}
	for t, m := range r.metrics {
		state := m.state
		if t.key == "" && state == Failed {
			state = Degraded
		}
		if t.key == "" {
			if pool, ok := r.keyPools[t]; ok && len(pool.keys) > 0 {
				allFailed := true
				for _, key := range pool.keys {
					route := target{provider: t.provider, model: t.model, key: key}
					h, global := r.holds[route], r.holds[target{provider: t.provider, key: key}]
					held := (h != nil && h.released.IsZero()) || (global != nil && global.released.IsZero())
					routeMetric := r.metrics[route]
					if !held && (routeMetric == nil || routeMetric.state != Failed) {
						allFailed = false
						break
					}
				}
				if allFailed {
					state = Failed
				}
			}
		}
		if h := r.holds[t]; h != nil && h.released.IsZero() {
			state = Failed
		}
		if h := r.holds[target{provider: t.provider, key: t.key}]; t.key != "" && h != nil && h.released.IsZero() {
			state = Failed
		}
		rate := 0.0
		if m.requests > 0 {
			rate = m.failures / m.requests
		}
		out.Routes = append(out.Routes, RouteSnapshot{Provider: t.provider, Model: t.model, KeyID: t.key,
			State: state, Factor: r.factor(t), Requests: m.total, Errors: m.errors, ErrorRate: rate,
			Latency: m.latency, TokensPerSecond: m.throughput, LastSeen: m.last})
	}
	for t, h := range r.holds {
		if h.released.IsZero() {
			out.HeldKeys = append(out.HeldKeys, HoldSnapshot{Provider: t.provider, Model: t.model,
				KeyID: t.key, Reason: h.class, Since: h.since, Due: h.until, Checking: h.probe != 0})
		}
	}
	for id, c := range r.circuits {
		if c.state == Closed || !now.Before(c.openUntil) {
			continue
		}
		key := id.policy
		if id.target.key != "" {
			key += "\x00" + id.target.key
		}
		out.Circuits[key] = CircuitSnapshot{Status: Open, OpenedAt: c.openedAt,
			Cooldown: int64(c.openUntil.Sub(c.openedAt)), ExpiresAt: c.openUntil}
	}
	for _, p := range r.config.Load().policies {
		if len(p.PrimaryKeyIDs) == 0 {
			continue
		}
		var main CircuitSnapshot
		all := true
		for _, key := range p.PrimaryKeyIDs {
			sub, ok := out.Circuits[p.Name+"\x00"+key]
			if !ok {
				all = false
				break
			}
			if main.ExpiresAt.IsZero() || sub.ExpiresAt.Before(main.ExpiresAt) {
				main = sub
			}
		}
		if all {
			out.Circuits[p.Name] = main
		}
	}
	sort.Slice(out.Routes, func(i, j int) bool {
		a, b := out.Routes[i], out.Routes[j]
		return string(a.Provider)+"\x00"+a.Model+"\x00"+a.KeyID < string(b.Provider)+"\x00"+b.Model+"\x00"+b.KeyID
	})
	sort.Slice(out.HeldKeys, func(i, j int) bool {
		a, b := out.HeldKeys[i], out.HeldKeys[j]
		return string(a.Provider)+"\x00"+a.Model+"\x00"+a.KeyID < string(b.Provider)+"\x00"+b.Model+"\x00"+b.KeyID
	})
	return out
}

type ClearConditions struct {
	Provider string `json:"provider,omitempty"`
	KeyID    string `json:"key_id,omitempty"`
	Model    string `json:"model,omitempty"`
}

// ClearHeldKeys 依据公开字段依赖释放 hold；model 清理不影响全 key hold。
func (r *Runtime) ClearHeldKeys(filter ClearConditions) ([]string, error) {
	if (filter.KeyID != "" && filter.Provider == "") || (filter.Model != "" && (filter.Provider == "" || filter.KeyID == "")) {
		return nil, fmt.Errorf("key_id requires provider; model requires provider and key_id")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	cleared := []string{}
	scopes := make(map[target]bool)
	for t := range r.holdEpochs {
		scopes[t] = true
	}
	for t := range r.holds {
		scopes[t] = true
	}
	for _, a := range r.attempts {
		if a.target.key != "" {
			scopes[a.target] = true
			scopes[target{provider: a.target.provider, key: a.target.key}] = true
		}
	}
	for t := range scopes {
		if (filter.Provider == "" || string(t.provider) == filter.Provider) &&
			(filter.KeyID == "" || t.key == filter.KeyID) && (filter.Model == "" || t.model == filter.Model) {
			r.advanceHoldEpochLocked(t)
		}
	}
	for t, h := range r.holds {
		if !h.released.IsZero() || (filter.Provider != "" && string(t.provider) != filter.Provider) ||
			(filter.KeyID != "" && t.key != filter.KeyID) || (filter.Model != "" && t.model != filter.Model) {
			continue
		}
		delete(r.holds, t)
		r.recoverLocked(t)
		for route := range r.metrics {
			if route.provider == t.provider && route.key == t.key && (t.model == "" || route.model == t.model) {
				r.recoverLocked(route)
			}
		}
		cleared = append(cleared, string(t.provider)+":lb-identifier:"+t.model+":lb-identifier:"+t.key)
	}
	sort.Strings(cleared)
	return cleared, nil
}

// ResetCircuit 删除指定策略的运行时状态，不更改其持久化定义。
func (r *Runtime) ResetCircuit(policy, keyID string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	count := 0
	for id := range r.circuits {
		if (policy == "" || strings.EqualFold(policy, id.policy)) && (keyID == "" || keyID == id.target.key) {
			delete(r.circuits, id)
			count++
		}
	}
	return count
}

// InvalidateKey 必须在编辑、轮换或删除 key 时调用，旧 attempt 不能重新 hold 新 key。
func (r *Runtime) InvalidateKey(provider schemas.ModelProvider, keyID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.generations[target{provider: provider, key: keyID}]++
	for t := range r.holds {
		if t.provider == provider && t.key == keyID {
			delete(r.holds, t)
		}
	}
	for t := range r.metrics {
		if t.provider == provider && t.key == keyID {
			delete(r.metrics, t)
		}
	}
	for id := range r.circuits {
		if id.target.provider == provider && id.target.key == keyID {
			delete(r.circuits, id)
		}
	}
}

// SetProviderModelKeys 接收完整配置池的 ID 视图，不能传入某个请求裁剪后的子集。
func (r *Runtime) SetProviderModelKeys(provider schemas.ModelProvider, model string, keys []schemas.Key) {
	r.mu.Lock()
	defer r.mu.Unlock()
	ids := make([]string, 0, len(keys))
	seen := make(map[string]bool)
	for _, key := range keys {
		if key.ID != "" && !seen[key.ID] && (key.Enabled == nil || *key.Enabled) {
			ids = append(ids, key.ID)
			seen[key.ID] = true
		}
	}
	r.keyPools[target{provider: provider, model: model}] = keyPool{keys: ids, updated: time.Now()}
}

// InvalidateProvider 清理被删除 provider 的所有状态，并使旧调用失去写入权。
func (r *Runtime) InvalidateProvider(provider schemas.ModelProvider) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for id, a := range r.attempts {
		if a.target.provider == provider {
			r.releaseLocked(id)
		}
	}
	for t := range r.holds {
		if t.provider == provider {
			delete(r.holds, t)
		}
	}
	for t := range r.metrics {
		if t.provider == provider {
			delete(r.metrics, t)
		}
	}
	for t := range r.keyPools {
		if t.provider == provider {
			delete(r.keyPools, t)
		}
	}
	for id := range r.circuits {
		if id.target.provider == provider {
			delete(r.circuits, id)
		}
	}
}

// RedirectTarget 只沿已授权目标跳转；明确 key pin 不被 circuit 策略解除。
func (r *Runtime) RedirectTarget(ctx *schemas.BifrostContext, provider schemas.ModelProvider, model string, eligible []schemas.Fallback) (schemas.Fallback, error) {
	return r.redirectTarget(ctx, schemas.Fallback{Provider: provider, Model: model, KeyID: requestKeyID(ctx)}, eligible, hasKeyPin(ctx))
}

// redirectTarget 保留完整原目标；新目标采用 resolver 授权的独立 pin，不继承旧 key。
func (r *Runtime) redirectTarget(ctx *schemas.BifrostContext, current schemas.Fallback, eligible []schemas.Fallback, pinned bool) (schemas.Fallback, error) {
	if BypassRequest(requestType(ctx)) || pinned || current.KeyID != "" {
		return current, nil
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	visited := make(map[schemas.Fallback]bool)
	now := time.Now()
	for {
		visited[current] = true
		moved := false
		for _, p := range r.config.Load().policies {
			t := target{provider: current.Provider, model: current.Model, key: current.KeyID}
			if !policyMatches(p, t) || r.availableLocked(t, now, AttemptID(ctx), true) {
				continue
			}
			next := schemas.Fallback{Provider: schemas.ModelProvider(p.FallbackProvider), Model: p.FallbackModel}
			allowed := false
			for _, candidate := range eligible {
				if candidate.Provider == next.Provider && candidate.Model == next.Model {
					next = candidate
					allowed = true
					break
				}
			}
			if !allowed {
				return current, ErrUnavailable
			}
			if visited[next] {
				return current, nil
			}
			current, moved = next, true
			break
		}
		if !moved || current.KeyID != "" {
			return current, nil
		}
	}
}

// ApplyCircuitPolicies 只重写后续请求目标与 fallback，不重放已经完成的调用。
func (r *Runtime) ApplyCircuitPolicies(ctx *schemas.BifrostContext, req *schemas.BifrostRequest, eligible []schemas.Fallback) error {
	if req == nil || BypassRequest(req.RequestType) {
		return nil
	}
	provider, model, fallbacks := req.GetRequestFields()
	primary, err := r.RedirectTarget(ctx, provider, model, eligible)
	if err != nil {
		return err
	}
	redirected := make([]schemas.Fallback, 0, len(fallbacks))
	seen := map[schemas.Fallback]bool{primary: true}
	for _, fb := range fallbacks {
		next, err := r.redirectTarget(ctx, fb, eligible, false)
		if err != nil {
			continue
		}
		if !seen[next] {
			redirected = append(redirected, next)
			seen[next] = true
		}
	}
	if primary.KeyID != "" && primary.KeyID != requestKeyID(ctx) {
		if ctx == nil {
			return ErrUnavailable
		}
		ctx.SetValue(schemas.BifrostContextKeyRoutingPinnedAPIKeyID, primary.KeyID)
	}
	req.SetProvider(primary.Provider)
	req.SetModel(primary.Model)
	req.SetFallbacks(redirected)
	return nil
}
