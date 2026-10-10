package providers

import (
	"context"
	"encoding/json"
	"sort"
)

type functionalAdapter struct {
	validate func(json.RawMessage) error
	evaluate func(context.Context, json.RawMessage, Input) (Result, error)
	caps     Capabilities
}

func (a functionalAdapter) Validate(raw json.RawMessage) error { return a.validate(raw) }
func (a functionalAdapter) Capabilities() Capabilities         { return a.caps }
func (a functionalAdapter) Evaluate(ctx context.Context, raw json.RawMessage, in Input) (Result, error) {
	return a.evaluate(ctx, raw, in)
}

func textCapabilities() Capabilities {
	return Capabilities{Input: true, Output: true, CanBlock: true, OutputRequiresFullBuffer: true}
}

// NewRegistry 返回仅含真实协议实现的独立注册表；调用方负责验证后原子更新配置。
func NewRegistry() map[string]Adapter {
	crowd := textCapabilities()
	crowd.Transforms, crowd.ToolContext = true, true
	gray := textCapabilities()
	gray.ToolContext, gray.SkipTextOnlyOutputStream = true, true
	lakera := textCapabilities()
	lakera.CanRedact = true
	return map[string]Adapter{
		"a10":              functionalAdapter{validateA10, evaluateA10, textCapabilities()},
		"crowdstrike-aidr": functionalAdapter{validateCrowdStrike, evaluateCrowdStrike, crowd},
		"grayswan":         functionalAdapter{validateGraySwan, evaluateGraySwan, gray},
		"patronus-ai":      functionalAdapter{validatePatronus, evaluatePatronus, textCapabilities()},
		"lakera":           functionalAdapter{validateLakera, evaluateLakera, lakera},
		"repelloai-argus":  functionalAdapter{validateRepello, evaluateRepello, textCapabilities()},
	}
}

// NewAdapters 为宿主桥接提供 HTTP 注册表；cloud 注册由其独立工厂完成。
func NewAdapters() map[string]Adapter { return NewRegistry() }

// ProviderNames 从实际注册表派生名单，避免文档枚举被误报为可执行能力。
func ProviderNames() []string {
	names := make([]string, 0, len(NewRegistry()))
	for name := range NewRegistry() {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}
