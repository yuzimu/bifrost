package guardrails

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/maximhq/bifrost/core/schemas"
)

type JudgeExecutionError struct {
	ResponsesFallback bool
}

func (*JudgeExecutionError) Error() string { return "judge provider request failed" }

// JudgeErrorFromBifrost 保留真实协议拒绝分类，错误正文和凭据不越过宿主边界。
func JudgeErrorFromBifrost(err *schemas.BifrostError) error {
	if err == nil {
		return nil
	}
	text := strings.ToLower(err.GetErrorString())
	fallback := strings.Contains(text, "/v1/responses") &&
		(strings.Contains(text, "/v1/chat/completions") || strings.Contains(text, "function tool")) ||
		strings.Contains(text, "chat completion") && strings.Contains(text, "not supported")
	return &JudgeExecutionError{ResponsesFallback: fallback}
}

// judgeNeedsResponses 仅响应上游明确协议拒绝，不对断网、超时或普通策略错误重复调用。
func judgeNeedsResponses(err error) bool {
	if err == nil {
		return false
	}
	var providerErr *JudgeExecutionError
	return errors.As(err, &providerErr) && providerErr.ResponsesFallback
}

// VerifyPrompt 通过正式宿主执行一次真实评判，运行态 fail-open 不得变成 Verify 成功。
func (p *Plugin) VerifyPrompt(ctx context.Context, raw json.RawMessage) error {
	if err := validateJSON(raw); err != nil {
		return err
	}
	if err := rejectRawCredentials(raw); err != nil {
		return err
	}
	profile, err := p.compileProfile(Profile{ID: 1, ProviderName: "prompt-guardrail", PolicyName: "verify", Config: raw})
	if err != nil {
		return err
	}
	_, call, err := p.judge(ctx, profile, Evaluation{Phase: "input", Target: "llm", Texts: []string{"test"}})
	if err != nil || call == nil || call.Reason != "judge_policy_decision" {
		return errors.New("judge 验证失败")
	}
	return nil
}
