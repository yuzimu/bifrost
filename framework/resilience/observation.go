package resilience

import (
	"math"
	"math/rand/v2"
	"reflect"
	"strconv"
	"strings"
	"time"

	bifrost "github.com/maximhq/bifrost/core"
	"github.com/maximhq/bifrost/core/schemas"
)

type Observation struct {
	Success         bool
	Canceled        bool
	ProviderReached bool
	FailureClass    schemas.FailureClass
	AccountQuota    bool
	RetryAfter      time.Duration
	Latency         time.Duration
	Tokens          int64
	ResponseHeaders map[string]string
}

// ObserveAttempt 只消费一次最终结果，按租约中冻结的 provider/model/key 记账。
func (r *Runtime) ObserveAttempt(id uint64, observation Observation) {
	r.mu.Lock()
	defer r.mu.Unlock()
	a := r.attempts[id]
	if a == nil {
		return
	}
	defer r.releaseLocked(id)
	if observation.Canceled || !observation.ProviderReached || BypassRequest(a.requestType) {
		return
	}
	now := time.Now()
	if a.target.key != "" && a.generation != r.generations[target{provider: a.target.provider, key: a.target.key}] {
		return
	}
	class := observation.FailureClass
	if class != schemas.FailureClassCallerFault {
		r.observeMetric(a.target, observation, now)
		if a.target.key != "" {
			r.observeMetric(target{provider: a.target.provider, model: a.target.model}, observation, now)
		}
	}
	if a.target.key != "" && a.generation == r.generations[target{provider: a.target.provider, key: a.target.key}] {
		r.settleHolds(a, observation, now)
	}
	headers := normalizedHeaders(observation.ResponseHeaders)
	for _, p := range r.config.Load().policies {
		unchanged := false
		for _, old := range a.config.policies {
			if reflect.DeepEqual(old.Policy, p.Policy) {
				unchanged = true
				break
			}
		}
		if !unchanged {
			continue
		}
		cid, matches := policyCircuitID(p, a.target)
		if !matches {
			continue
		}
		c := r.circuits[cid]
		if signalsMatch(p.Condition, headers) {
			// A successful response may trip the circuit, but is never replayed.
			cooldown := p.cooldown
			if value, ok := headers[strings.ToLower(p.CooldownHeader)]; ok {
				if ms, err := strconv.ParseInt(value, 10, 64); err == nil && ms > 0 && ms <= math.MaxInt64/int64(time.Millisecond) {
					cooldown = time.Duration(ms) * time.Millisecond
				}
			}
			r.circuits[cid] = &circuit{state: Open, openedAt: now, openUntil: now.Add(cooldown), updated: now}
		} else if c != nil && c.probe == id {
			delete(r.circuits, cid)
		}
	}
}

// observeMetric 只保存常量大小的统计量，延迟按产出 token 归一化。
func (r *Runtime) observeMetric(t target, o Observation, now time.Time) {
	m := r.metrics[t]
	if m == nil {
		m = &metric{state: Healthy}
		r.metrics[t] = m
	}
	r.decay(m, now)
	m.last, m.total, m.requests = now, m.total+1, m.requests+1
	if !o.Success {
		m.failures++
		m.errors++
		m.successes = 0
	} else {
		m.successes++
		if m.state == Failed {
			m.state = Recovering
		}
	}
	if o.Latency > 0 {
		latency := float64(o.Latency.Milliseconds()) / math.Max(1, float64(o.Tokens)/100)
		if m.latency == 0 {
			m.latency, m.baseline = latency, latency
		} else {
			m.latency = 0.8*m.latency + 0.2*latency
			if o.Success {
				m.baseline = 0.95*m.baseline + 0.05*latency
			}
		}
	}
	m.tokens += float64(max(0, o.Tokens))
	m.throughput = m.tokens / 30
}

func signalsMatch(condition Condition, headers map[string]string) bool {
	if len(condition.Signals) == 0 {
		return false
	}
	all := condition.Operator == "AND"
	for _, signal := range condition.Signals {
		value, exists := headers[strings.ToLower(signal.HeaderName)]
		matched := exists
		if signal.HeaderValue != nil {
			matched = exists && strings.EqualFold(value, *signal.HeaderValue)
		} else if signal.HeaderContains != nil {
			matched = exists && strings.Contains(strings.ToLower(value), strings.ToLower(*signal.HeaderContains))
		}
		if all && !matched {
			return false
		}
		if !all && matched {
			return true
		}
	}
	return all
}

func holdCap(class schemas.FailureClass) time.Duration {
	switch class {
	case schemas.FailureClassCredential, schemas.FailureClassRegionBlocked:
		return 15 * time.Minute
	case schemas.FailureClassQuota, schemas.FailureClassModelAccess:
		return 5 * time.Minute
	case schemas.FailureClassModelGone:
		return 30 * time.Minute
	case schemas.FailureClassRateLimit:
		return 2 * time.Minute
	}
	return 0
}

// settleHolds 成功和失败都只结算 claim 时的 hold 修订，手动释放同样隔离旧请求。
func (r *Runtime) settleHolds(a *attempt, o Observation, now time.Time) {
	global := target{provider: a.target.provider, key: a.target.key}
	if a.holdEpoch != r.holdEpochs[a.target] || a.keyEpoch != r.holdEpochs[global] {
		return
	}
	scope := a.target
	if o.FailureClass == schemas.FailureClassCredential || (o.FailureClass == schemas.FailureClassQuota && o.AccountQuota) {
		scope.model = ""
	}
	for _, t := range []target{a.target, {provider: a.target.provider, key: a.target.key}} {
		h := r.holds[t]
		if h == nil || !h.released.IsZero() {
			continue
		}
		wasProbe := h.probe != 0 && r.attempts[h.probe] == a
		if o.Success || (o.FailureClass.IsPerKey() && (h.class != o.FailureClass || t != scope)) {
			h.released, h.updated, h.probe = now, now, 0
			r.advanceHoldEpochLocked(t)
			r.recoverLocked(a.target)
		} else if wasProbe && !o.FailureClass.IsPerKey() {
			h.until, h.updated, h.probe = now.Add(holdWait(h.class, h.rung, o.RetryAfter)), now, 0
		}
	}
	if holdCap(o.FailureClass) == 0 {
		return
	}
	h := r.holds[scope]
	if h != nil && h.released.IsZero() {
		if h.probe == 0 || r.attempts[h.probe] != a || a.started.Before(h.since) {
			return
		}
		h.rung++
	} else {
		rung := 0
		if h != nil && h.class == o.FailureClass && now.Sub(h.released) <= 10*time.Minute {
			rung = h.rung
		}
		h = &hold{rung: rung, since: now}
		r.holds[scope] = h
	}
	h.class, h.until, h.updated, h.released, h.probe = o.FailureClass, now.Add(holdWait(o.FailureClass, h.rung, o.RetryAfter)), now, time.Time{}, 0
	r.advanceHoldEpochLocked(scope)
	if m := r.metrics[a.target]; m != nil {
		m.state = Failed
	}
}

func holdWait(class schemas.FailureClass, rung int, hint time.Duration) time.Duration {
	if hint > 0 {
		// Core provider hints are bounded at five minutes.
		return min(5*time.Minute, max(10*time.Second, hint))
	}
	wait := min(holdCap(class), time.Duration(float64(30*time.Second)*math.Pow(2, float64(min(rung, 10)))))
	return min(holdCap(class), time.Duration(float64(wait)*(0.9+rand.Float64()*0.2)))
}

func (r *Runtime) recoverLocked(t target) {
	if m := r.metrics[t]; m != nil {
		m.state, m.successes = Recovering, 0
	}
}

// observationFromResponse 只提取统计和 header，不保留请求正文或凭据。
func ObservationFromResponse(resp *schemas.BifrostResponse, err *schemas.BifrostError) Observation {
	o := Observation{Success: err == nil && resp != nil, ProviderReached: resp != nil || (err != nil && !err.IsBifrostError)}
	if resp != nil {
		if ef := resp.GetExtraFields(); ef != nil {
			o.Latency = time.Duration(ef.Latency) * time.Millisecond
			o.ResponseHeaders = ef.ProviderResponseHeaders
		}
		if usage := resp.NormalizedUsage(); usage != nil {
			o.Tokens = int64(usage.TotalTokens)
		}
	}
	if err != nil {
		o.FailureClass = bifrost.ClassifyFailure(err)
		o.RetryAfter = time.Duration(err.ExtraFields.RetryAfter) * time.Millisecond
		o.Latency = time.Duration(err.ExtraFields.Latency) * time.Millisecond
		if err.Type != nil && *err.Type == schemas.RequestCancelled {
			o.Canceled = true
		}
		if err.Error != nil {
			message := strings.ToLower(err.Error.Message)
			kind, code := "", ""
			if err.Error.Type != nil {
				kind = strings.ToLower(*err.Error.Type)
			}
			if err.Error.Code != nil {
				code = strings.ToLower(*err.Error.Code)
			}
			if strings.Contains(kind, "guardrail") || strings.Contains(code, "content_filter") ||
				strings.Contains(code, "guardrail") || strings.Contains(message, "guardrail") ||
				strings.Contains(kind, "content_filter") {
				o.FailureClass = schemas.FailureClassCallerFault
			}
			o.AccountQuota = (err.StatusCode != nil && *err.StatusCode == 402) || code == "insufficient_quota" ||
				kind == "insufficient_quota" || strings.Contains(message, "credit balance")
		}
	}
	return o
}
