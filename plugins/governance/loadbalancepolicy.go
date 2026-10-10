package governance

import (
	"sync/atomic"

	"github.com/maximhq/bifrost/core/schemas"
	"github.com/maximhq/bifrost/framework/resilience"
)

// LoadBalancePolicy receives only the authorized, budget-eligible candidate pool.
type LoadBalancePolicy interface {
	FilterProviders(*schemas.BifrostContext, []schemas.ProviderCandidate, string) []schemas.ProviderCandidate
	SelectProvider(*schemas.BifrostContext, []schemas.ProviderCandidate, string) (schemas.ProviderCandidate, error)
}

type loadBalancePolicyHolder struct {
	policy LoadBalancePolicy
}

var runtimeLoadBalancePolicy atomic.Pointer[loadBalancePolicyHolder]

// SetLoadBalancePolicy 注入单进程 provider 策略；卸载时传 nil 恢复原有选择。
func SetLoadBalancePolicy(policy LoadBalancePolicy) {
	if policy == nil {
		runtimeLoadBalancePolicy.Store(nil)
		return
	}
	runtimeLoadBalancePolicy.Store(&loadBalancePolicyHolder{policy: policy})
}

func currentLoadBalancePolicy() LoadBalancePolicy {
	if holder := runtimeLoadBalancePolicy.Load(); holder != nil {
		return holder.policy
	}
	return nil
}

// publishProviderCapabilities 固定请求的锁内能力快照，不把动态凭据当成池授权。
func (p *GovernancePlugin) publishProviderCapabilities(ctx *schemas.BifrostContext) {
	if ctx == nil || p.inMemoryStore == nil {
		return
	}
	capabilities := make(map[schemas.ModelProvider]bool)
	if source, ok := p.inMemoryStore.(interface {
		GetProviderKeylessCapabilities() map[schemas.ModelProvider]bool
	}); ok {
		ctx.SetValue(resilience.ProviderKeylessContextKey, source.GetProviderKeylessCapabilities())
		return
	}
	for provider, cfg := range p.inMemoryStore.GetConfiguredProviders() {
		custom := cfg.CustomProviderConfig
		capabilities[provider] = custom != nil && custom.IsKeyLess && custom.BaseProviderType != schemas.Bedrock
	}
	ctx.SetValue(resilience.ProviderKeylessContextKey, capabilities)
}
