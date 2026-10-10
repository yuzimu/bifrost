package providers

import (
	"context"
	"encoding/json"
	"fmt"
)

type CrowdStrikeConfig struct {
	connection
	AppID               string `json:"app_id,omitempty"`
	CollectorInstanceID string `json:"collector_instance_id,omitempty"`
}

// loadCrowdStrike 校验公开配置及凭据引用，不保存解析后的秘密。
func loadCrowdStrike(raw json.RawMessage) (CrowdStrikeConfig, string, string, error) {
	var c CrowdStrikeConfig
	if err := decodeConfig(raw, &c); err != nil {
		return c, "", "", err
	}
	key, err := secret(c.APIKey)
	if err != nil {
		return c, "", "", err
	}
	target, err := endpoint(c.BaseURL, "https://api.crowdstrike.com/aidr/aiguard", "/v1/guard_chat_completions", false)
	if err != nil {
		return c, "", "", err
	}
	_, err = timeoutSeconds(c.Timeout)
	return c, key, target, err
}

func validateCrowdStrike(raw json.RawMessage) error {
	_, _, _, err := loadCrowdStrike(raw)
	return err
}

// evaluateCrowdStrike 仅服从策略 blocked 判定，detector findings 不自动导致阻断。
func evaluateCrowdStrike(ctx context.Context, raw json.RawMessage, in Input) (Result, error) {
	c, key, target, err := loadCrowdStrike(raw)
	if err != nil {
		return Result{}, err
	}
	messages, err := prepare(in, NewRegistry()["crowdstrike-aidr"].Capabilities())
	if err != nil {
		return Result{}, err
	}
	body := struct {
		EventType  string `json:"event_type"`
		GuardInput struct {
			Messages []Message `json:"messages"`
			Tools    []Tool    `json:"tools,omitempty"`
		} `json:"guard_input"`
		AppID               string `json:"app_id,omitempty"`
		CollectorInstanceID string `json:"collector_instance_id,omitempty"`
		LLMProvider         string `json:"llm_provider,omitempty"`
		Model               string `json:"model,omitempty"`
	}{EventType: in.Phase, AppID: c.AppID, CollectorInstanceID: c.CollectorInstanceID, LLMProvider: in.Scope.Provider, Model: in.Scope.Model}
	body.GuardInput.Messages, body.GuardInput.Tools = messages, in.Tools
	var response struct {
		Blocked     *bool           `json:"blocked"`
		Transformed *bool           `json:"transformed"`
		GuardOutput json.RawMessage `json:"guard_output"`
	}
	if err := postJSON(ctx, target, c.Timeout, map[string]string{"Authorization": "Bearer " + key}, body, &response); err != nil {
		return Result{}, err
	}
	if response.Blocked == nil || response.Transformed == nil {
		return Result{}, fmt.Errorf("%w: missing AIDR decision", ErrInvalidResponse)
	}
	if *response.Blocked {
		return Result{Blocked: true, Reason: "CrowdStrike AIDR blocked content"}, nil
	}
	if *response.Transformed {
		return transformedMessages(in, messages, response.GuardOutput), nil
	}
	return Result{Reason: "CrowdStrike AIDR allowed content"}, nil
}
