package providers

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
)

// A10Config 仅接收公开配置；客户端凭据必须引用环境变量。
type A10Config struct {
	BaseURL  string `json:"base_url"`
	ClientID string `json:"client_id"`
	Timeout  int    `json:"timeout,omitempty"`
}

// loadA10 校验防火墙地址、凭据引用与时限，不发起配置验证请求。
func loadA10(raw json.RawMessage) (A10Config, string, string, error) {
	var c A10Config
	if err := decodeConfig(raw, &c); err != nil {
		return c, "", "", err
	}
	if c.BaseURL == "" {
		return c, "", "", fmt.Errorf("%w: A10 firewall origin is required", ErrInvalidConfig)
	}
	key, err := secret(c.ClientID)
	if err != nil {
		return c, "", "", err
	}
	target, err := endpoint(c.BaseURL, "", "/v1/validateParsedText", true)
	if err != nil {
		return c, "", "", err
	}
	_, err = timeoutSeconds(c.Timeout)
	return c, key, target, err
}

func validateA10(raw json.RawMessage) error {
	_, _, _, err := loadA10(raw)
	return err
}

// evaluateA10 按默认方向头提交结构化内容；未扫描的文本和歧义变换均不放行。
// 公开协议：https://docs.troj.ai/trojai-defend/eng-proxy-api
func evaluateA10(ctx context.Context, raw json.RawMessage, in Input) (Result, error) {
	c, key, target, err := loadA10(raw)
	if err != nil {
		return Result{}, err
	}
	for _, message := range in.Messages {
		if message.Role == "tool" || len(message.ToolCalls) != 0 {
			return Result{Blocked: true, Reason: "A10 tool content cannot be mapped safely"}, nil
		}
	}
	if in.HasToolCalls || len(in.Tools) != 0 {
		return Result{Blocked: true, Reason: "A10 tool content cannot be mapped safely"}, nil
	}
	messages, err := prepare(in, textCapabilities())
	if err != nil {
		return Result{}, err
	}
	expected := make([]string, 0, len(messages))
	var body any
	if in.Phase == "input" {
		if strings.TrimSpace(in.Scope.Model) == "" {
			return Result{}, fmt.Errorf("%w: A10 input requires the routed model", ErrInvalidInput)
		}
		for _, message := range messages {
			expected = append(expected, message.Content)
		}
		body = struct {
			Model    string    `json:"model"`
			Messages []Message `json:"messages"`
		}{in.Scope.Model, messages}
	} else {
		type choice struct {
			Index   int     `json:"index"`
			Message Message `json:"message"`
		}
		choices := make([]choice, 0, len(in.Texts))
		for _, message := range messages {
			if message.TextIndex == nil {
				continue
			}
			if message.Role != "assistant" {
				return Result{}, fmt.Errorf("%w: A10 output requires assistant messages", ErrInvalidInput)
			}
			choices = append(choices, choice{len(choices), message})
			expected = append(expected, message.Content)
		}
		body = struct {
			Object  string   `json:"object"`
			Model   string   `json:"model"`
			Choices []choice `json:"choices"`
		}{"chat.completion", in.Scope.Model, choices}
	}
	var response map[string]json.RawMessage
	if err := postJSON(ctx, target, c.Timeout, map[string]string{
		"x-eag-clientid":          key,
		"x-trojai-rule-direction": in.Phase,
	}, body, &response); err != nil {
		return Result{}, err
	}
	return a10Decision(response, in.Phase, expected)
}

// a10Decision 精确读取公开字段；规则阻断优先，FLAG 本身不阻断。
func a10Decision(response map[string]json.RawMessage, phase string, expected []string) (Result, error) {
	var action string
	if err := a10Field(response, "Action", &action); err != nil {
		return Result{}, err
	}
	blocked, transformed, err := a10Action(action)
	if err != nil {
		return Result{}, err
	}
	if blocked {
		return Result{Blocked: true, Reason: "A10 blocked content"}, nil
	}
	ruleField, stringsField := "InputRuleResults", "ModelInputStrings"
	if phase == "output" {
		ruleField, stringsField = "OutputRuleResults", "ModelOutputStrings"
	}
	var rules []map[string]json.RawMessage
	if err := a10Field(response, ruleField, &rules); err != nil {
		return Result{}, err
	}
	for _, rule := range rules {
		var ruleAction string
		var ruleBlocked, redacted bool
		for name, dst := range map[string]any{
			"action": &ruleAction, "blocked": &ruleBlocked, "redacted": &redacted,
		} {
			if err := a10Field(rule, name, dst); err != nil {
				return Result{}, err
			}
		}
		block, transform, err := a10Action(ruleAction)
		if err != nil {
			return Result{}, err
		}
		if block || ruleBlocked {
			return Result{Blocked: true, Reason: "A10 rule blocked content"}, nil
		}
		transformed = transformed || transform || redacted
	}
	// 官方未定义 consolidated map 的键与文本坐标关系，不能猜测替换目标。
	for _, name := range []string{"FinalInputJson", "ConsolidatedFinalInput", "ConsolidatedFinalOutput"} {
		value, present := response[name]
		if !present {
			continue
		}
		if !validObject(value) {
			return Result{}, fmt.Errorf("%w: ambiguous A10 transformation payload", ErrInvalidResponse)
		}
		var fields map[string]json.RawMessage
		if json.Unmarshal(value, &fields) != nil {
			return Result{}, ErrInvalidResponse
		}
		transformed = transformed || len(fields) != 0
	}
	if transformed {
		return Result{Blocked: true, Reason: "A10 transformation cannot be mapped safely"}, nil
	}
	var scanned []string
	if err := a10Field(response, stringsField, &scanned); err != nil {
		return Result{}, err
	}
	if len(expected) == 0 || !reflect.DeepEqual(scanned, expected) {
		return Result{}, fmt.Errorf("%w: A10 did not confirm complete text coverage", ErrInvalidResponse)
	}
	return Result{Reason: "A10 allowed content"}, nil
}

// a10Field 拒绝缺失、null 和类型不符；字段名必须与公开协议大小写一致。
func a10Field(object map[string]json.RawMessage, name string, dst any) error {
	raw, ok := object[name]
	if !ok || strings.TrimSpace(string(raw)) == "null" || json.Unmarshal(raw, dst) != nil {
		return fmt.Errorf("%w: missing or invalid A10 decision field", ErrInvalidResponse)
	}
	return nil
}

// a10Action 未知动作不隐式放行；只接受公开动作与集成文档明确的同义值。
func a10Action(action string) (bool, bool, error) {
	switch action {
	case "BLOCK", "BLOCKED":
		return true, false, nil
	case "REDACT", "REDACTED", "TRANSFORMED":
		return false, true, nil
	case "PASS", "FLAG":
		return false, false, nil
	default:
		return false, false, fmt.Errorf("%w: unknown A10 action", ErrInvalidResponse)
	}
}
