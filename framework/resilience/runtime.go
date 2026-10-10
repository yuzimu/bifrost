package resilience

import (
	"context"
	"errors"
	"math"
	"reflect"
	"sync"
	"sync/atomic"
	"time"

	"github.com/maximhq/bifrost/core/schemas"
)

var ErrUnavailable = errors.New("all eligible routes are unavailable")

type HealthState string
type CircuitState string

const (
	Healthy    HealthState  = "Healthy"
	Degraded   HealthState  = "Degraded"
	Failed     HealthState  = "Failed"
	Recovering HealthState  = "Recovering"
	Closed     CircuitState = "closed"
	Open       CircuitState = "open"
	HalfOpen   CircuitState = "half-open"
	stateTTL                = time.Hour
	probeTTL                = 5 * time.Minute
)

type target struct {
	provider schemas.ModelProvider
	model    string
	key      string
}

type metric struct {
	last, updated            time.Time
	requests, failures       float64
	latency, baseline        float64
	tokens, throughput       float64
	total, errors, successes uint64
	state                    HealthState
}

type circuitID struct {
	policy string
	target target
}

type circuit struct {
	state     CircuitState
	openedAt  time.Time
	openUntil time.Time
	updated   time.Time
	probe     uint64
}

type hold struct {
	class                 schemas.FailureClass
	since, until, updated time.Time
	released              time.Time
	rung                  int
	probe                 uint64
}

type attempt struct {
	target      target
	requestType schemas.RequestType
	started     time.Time
	circuits    []circuitID
	holds       []target
	stop        func() bool
	generation  uint64
	holdEpoch   uint64
	keyEpoch    uint64
	config      *compiledConfig
}

type weightTable struct {
	factors map[target]float64
}

type keyPool struct {
	keys    []string
	updated time.Time
}

type Runtime struct {
	config      atomic.Pointer[compiledConfig]
	weights     atomic.Pointer[weightTable]
	mu          sync.Mutex
	configMu    sync.Mutex
	metrics     map[target]*metric
	circuits    map[circuitID]*circuit
	holds       map[target]*hold
	attempts    map[uint64]*attempt
	generations map[target]uint64
	holdEpochs  map[target]uint64
	holdNext    uint64
	next        atomic.Uint64
	logger      schemas.Logger
	cancel      context.CancelFunc
	wg          sync.WaitGroup
	closed      bool
	kv          schemas.KVStore
	metadataKey string
	keyPools    map[target]keyPool
}

// New 初始化单进程状态与五秒权重刷新；不会向模型发送主动探测。
func New(cfg Config, logger schemas.Logger, options ...Option) (*Runtime, error) {
	compiled, err := compileConfig(cfg)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	r := &Runtime{metrics: make(map[target]*metric), circuits: make(map[circuitID]*circuit),
		holds: make(map[target]*hold), attempts: make(map[uint64]*attempt),
		generations: make(map[target]uint64), holdEpochs: make(map[target]uint64), logger: logger, cancel: cancel}
	r.keyPools = make(map[target]keyPool)
	r.config.Store(compiled)
	r.weights.Store(&weightTable{factors: make(map[target]float64)})
	for _, option := range options {
		if err := option(r); err != nil {
			cancel()
			return nil, err
		}
	}
	r.wg.Add(1)
	go r.run(ctx)
	return r, nil
}

// UpdateConfig 先验证整份配置再原子替换，清除旧策略的状态与预留。
func (r *Runtime) UpdateConfig(cfg Config) error {
	r.configMu.Lock()
	defer r.configMu.Unlock()
	return r.updateConfig(cfg)
}

func (r *Runtime) updateConfig(cfg Config) error {
	compiled, err := compileConfig(cfg)
	if err != nil {
		return err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.closed {
		return errors.New("resilience runtime is closed")
	}
	old := r.config.Load()
	r.config.Store(compiled)
	for id := range r.circuits {
		unchanged := false
		for _, before := range old.policies {
			for _, after := range compiled.policies {
				if before.Name == id.policy && reflect.DeepEqual(before.Policy, after.Policy) {
					unchanged = true
				}
			}
		}
		if !unchanged {
			delete(r.circuits, id)
		}
	}
	return nil
}

// ChangeConfig 串行化管理更新，持久化成功后才发布运行时配置。
func (r *Runtime) ChangeConfig(change func(*Config) error, persist func(Config) error) error {
	r.configMu.Lock()
	defer r.configMu.Unlock()
	cfg := r.GetConfig()
	if err := change(&cfg); err != nil {
		return err
	}
	if _, err := compileConfig(cfg); err != nil {
		return err
	}
	if persist != nil {
		if err := persist(cfg); err != nil {
			return err
		}
	}
	return r.updateConfig(cfg)
}

// GetConfig 返回脱离运行中配置的副本。
func (r *Runtime) GetConfig() Config {
	cloned, _ := compileConfig(r.config.Load().config)
	return cloned.config
}

// Cleanup 停止后台刷新并释放全部真实请求租约。
func (r *Runtime) Cleanup() error {
	r.configMu.Lock()
	defer r.configMu.Unlock()
	r.cancel()
	r.wg.Wait()
	r.persistMetadata(time.Now())
	r.mu.Lock()
	defer r.mu.Unlock()
	r.closed = true
	for id := range r.attempts {
		r.releaseLocked(id)
	}
	return nil
}

// run 定期衰减观测、预计算双层权重并回收未返回的探测。
func (r *Runtime) run(ctx context.Context) {
	defer r.wg.Done()
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	lastPersist := time.Now()
	for {
		select {
		case now := <-ticker.C:
			r.recompute(now)
			if now.Sub(lastPersist) >= 30*time.Second {
				r.persistMetadata(now)
				lastPersist = now
			}
		case <-ctx.Done():
			return
		}
	}
}

// recompute 用时间衰减错误、token-aware EWMA 延迟及吞吐利用率计算独立因子。
func (r *Runtime) recompute(now time.Time) {
	r.mu.Lock()
	defer r.mu.Unlock()
	type peers struct {
		latency, throughput float64
		count               int
	}
	groups := make(map[target]peers)
	for t, m := range r.metrics {
		if now.Sub(m.last) > stateTTL {
			delete(r.metrics, t)
			continue
		}
		r.decay(m, now)
		g := target{model: t.model}
		if t.key != "" {
			g.provider = t.provider
		}
		p := groups[g]
		p.latency += m.latency
		p.throughput += m.throughput
		p.count++
		groups[g] = p
	}
	table := &weightTable{factors: make(map[target]float64, len(r.metrics))}
	for t, m := range r.metrics {
		g := target{model: t.model}
		if t.key != "" {
			g.provider = t.provider
		}
		p := groups[g]
		errorRate := m.failures / math.Max(1, m.requests)
		relative := m.latency / math.Max(1, p.latency/float64(p.count))
		baseline := m.latency / math.Max(1, m.baseline)
		latencyPenalty := math.Max(1, math.Max(relative, baseline))
		utilization := m.throughput / math.Max(1, p.throughput/float64(p.count))
		if m.state == Recovering {
			errorRate *= 0.2
		}
		factor := math.Exp(-5*errorRate) / latencyPenalty / math.Max(1, utilization)
		table.factors[t] = math.Max(0.02, factor)
		switch {
		case m.state == Recovering && m.successes >= 3 && errorRate < 0.1:
			m.state = Healthy
		case m.state == Recovering:
		case errorRate >= 0.6 && m.requests >= 3:
			m.state = Failed
		case errorRate >= 0.15 || latencyPenalty > 2:
			m.state = Degraded
		default:
			m.state = Healthy
		}
	}
	r.weights.Store(table)
	for id, a := range r.attempts {
		if ((len(a.circuits) > 0 || len(a.holds) > 0) && now.Sub(a.started) >= probeTTL) || now.Sub(a.started) >= stateTTL {
			r.releaseLocked(id)
		}
	}
	for id, c := range r.circuits {
		if c.probe == 0 && now.Sub(c.updated) > stateTTL && !now.Before(c.openUntil) {
			delete(r.circuits, id)
		}
	}
	for t, h := range r.holds {
		if h.probe == 0 && now.Sub(h.updated) > stateTTL && !now.Before(h.until) {
			delete(r.holds, t)
		}
	}
	for t, pool := range r.keyPools {
		if now.Sub(pool.updated) > stateTTL {
			delete(r.keyPools, t)
		}
	}
	activeScopes := make(map[target]bool, len(r.holds)+2*len(r.attempts))
	for t := range r.holds {
		activeScopes[t] = true
	}
	for _, a := range r.attempts {
		activeScopes[a.target] = true
		activeScopes[target{provider: a.target.provider, key: a.target.key}] = true
	}
	for t := range r.holdEpochs {
		if !activeScopes[t] {
			delete(r.holdEpochs, t)
		}
	}
}

// advanceHoldEpochLocked 更新单个 hold scope 的修订号，迟到请求不能跨修订结算。
func (r *Runtime) advanceHoldEpochLocked(t target) {
	r.holdNext++
	r.holdEpochs[t] = r.holdNext
}

func (r *Runtime) decay(m *metric, now time.Time) {
	if !m.updated.IsZero() {
		factor := math.Exp(-now.Sub(m.updated).Seconds() / 30)
		m.requests *= factor
		m.failures *= factor
		m.tokens *= factor
		m.throughput *= factor
	}
	m.updated = now
}

func (r *Runtime) factor(t target) float64 {
	if factor, ok := r.weights.Load().factors[t]; ok {
		return factor
	}
	return 1
}

// releaseLocked 按 attempt 身份释放探测，不允许旧请求清掉新租约。
func (r *Runtime) releaseLocked(id uint64) {
	a := r.attempts[id]
	if a == nil {
		return
	}
	delete(r.attempts, id)
	if a.stop != nil {
		a.stop()
	}
	for _, cid := range a.circuits {
		if c := r.circuits[cid]; c != nil && c.probe == id {
			c.probe = 0
		}
	}
	for _, t := range a.holds {
		if h := r.holds[t]; h != nil && h.probe == id {
			h.probe = 0
		}
	}
}

func (r *Runtime) CancelAttempt(id uint64) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.releaseLocked(id)
}
