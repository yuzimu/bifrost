package providers

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"strings"
)

type GraySwanConfig struct {
	connection
	ViolationThreshold *float64          `json:"violation_threshold,omitempty"`
	ReasoningMode      string            `json:"reasoning_mode,omitempty"`
	PolicyID           string            `json:"policy_id"`
	PolicyIDs          []string          `json:"policy_ids,omitempty"`
	Rules              map[string]string `json:"rules,omitempty"`
}

// loadGraySwan 严格校验策略 ID、评分阈值和推理模式，不补造默认 policy。
func loadGraySwan(raw json.RawMessage) (GraySwanConfig, string, string, error) {
	var c GraySwanConfig
	if err := decodeConfig(raw, &c); err != nil {
		return c, "", "", err
	}
	if strings.TrimSpace(c.PolicyID) == "" {
		return c, "", "", fmt.Errorf("%w: policy_id required", ErrInvalidConfig)
	}
	if c.ReasoningMode == "" {
		c.ReasoningMode = "off"
	}
	if c.ReasoningMode != "off" && c.ReasoningMode != "hybrid" && c.ReasoningMode != "thinking" {
		return c, "", "", fmt.Errorf("%w: invalid reasoning_mode", ErrInvalidConfig)
	}
	if c.ViolationThreshold == nil {
		threshold := 0.5
		c.ViolationThreshold = &threshold
	}
	if math.IsNaN(*c.ViolationThreshold) || *c.ViolationThreshold < 0 || *c.ViolationThreshold > 1 {
		return c, "", "", fmt.Errorf("%w: violation_threshold must be 0..1", ErrInvalidConfig)
	}
	for _, id := range c.PolicyIDs {
		if strings.TrimSpace(id) == "" {
			return c, "", "", fmt.Errorf("%w: empty policy_ids entry", ErrInvalidConfig)
		}
	}
	for name, rule := range c.Rules {
		if strings.TrimSpace(name) == "" || strings.TrimSpace(rule) == "" {
			return c, "", "", fmt.Errorf("%w: empty natural language rule", ErrInvalidConfig)
		}
	}
	key, err := secret(c.APIKey)
	if err != nil {
		return c, "", "", err
	}
	target, err := endpoint(c.BaseURL, "https://api.grayswan.ai", "/cygnal/monitor", false)
	if err != nil {
		return c, "", "", err
	}
	_, err = timeoutSeconds(c.Timeout)
	return c, key, target, err
}

func validateGraySwan(raw json.RawMessage) error {
	_, _, _, err := loadGraySwan(raw)
	return err
}

// evaluateGraySwan 不发送纯文本输出流；有工具调用时只接受宿主完整缓冲的输出。
func evaluateGraySwan(ctx context.Context, raw json.RawMessage, in Input) (Result, error) {
	c, key, target, err := loadGraySwan(raw)
	if err != nil {
		return Result{}, err
	}
	messages, err := prepare(in, NewRegistry()["grayswan"].Capabilities())
	if err != nil {
		return Result{}, err
	}
	body := struct {
		Messages      []Message         `json:"messages"`
		Tools         []Tool            `json:"tools,omitempty"`
		PolicyID      string            `json:"policy_id"`
		PolicyIDs     []string          `json:"policy_ids,omitempty"`
		Categories    map[string]string `json:"categories,omitempty"`
		ReasoningMode string            `json:"reasoning_mode"`
		Metadata      struct {
			Headers map[string]string `json:"headers"`
		} `json:"metadata"`
	}{Messages: messages, Tools: in.Tools, PolicyID: c.PolicyID, PolicyIDs: c.PolicyIDs, Categories: c.Rules, ReasoningMode: c.ReasoningMode}
	body.Metadata.Headers = metadataHeaders(in.Scope.Headers)
	var response struct {
		Violation *float64 `json:"violation"`
		Error     bool     `json:"error"`
	}
	if err := postJSON(ctx, target, c.Timeout, map[string]string{"grayswan-api-key": key}, body, &response); err != nil {
		return Result{}, err
	}
	if response.Error || response.Violation == nil || math.IsNaN(*response.Violation) ||
		*response.Violation < 0 || *response.Violation > 1 {
		return Result{}, fmt.Errorf("%w: missing or invalid Cygnal violation score", ErrInvalidResponse)
	}
	if *response.Violation >= *c.ViolationThreshold {
		return Result{Blocked: true, Reason: "Gray Swan violation threshold exceeded"}, nil
	}
	return Result{Reason: "Gray Swan score below violation threshold"}, nil
}
