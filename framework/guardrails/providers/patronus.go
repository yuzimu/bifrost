package providers

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
)

type PatronusEvaluator struct {
	Evaluator       string `json:"evaluator"`
	Criteria        string `json:"criteria,omitempty"`
	ExplainStrategy string `json:"explain_strategy,omitempty"`
}

type PatronusConfig struct {
	connection
	Evaluators []PatronusEvaluator `json:"evaluators"`
	Capture    string              `json:"capture,omitempty"`
}

// loadPatronus 校验每个 evaluator 和公开枚举，禁止空评估列表。
func loadPatronus(raw json.RawMessage) (PatronusConfig, string, string, error) {
	var c PatronusConfig
	if err := decodeConfig(raw, &c); err != nil {
		return c, "", "", err
	}
	if len(c.Evaluators) == 0 {
		return c, "", "", fmt.Errorf("%w: evaluators required", ErrInvalidConfig)
	}
	if c.Capture == "" {
		c.Capture = "none"
	}
	if c.Capture != "none" && c.Capture != "fails-only" && c.Capture != "all" {
		return c, "", "", fmt.Errorf("%w: invalid capture mode", ErrInvalidConfig)
	}
	for _, evaluator := range c.Evaluators {
		if strings.TrimSpace(evaluator.Evaluator) == "" {
			return c, "", "", fmt.Errorf("%w: evaluator name required", ErrInvalidConfig)
		}
		switch evaluator.ExplainStrategy {
		case "", "never", "on-fail", "on-success", "always":
		default:
			return c, "", "", fmt.Errorf("%w: invalid explain_strategy", ErrInvalidConfig)
		}
	}
	key, err := secret(c.APIKey)
	if err != nil {
		return c, "", "", err
	}
	target, err := endpoint(c.BaseURL, "https://api.patronus.ai", "/v1/evaluate", false)
	if err != nil {
		return c, "", "", err
	}
	_, err = timeoutSeconds(c.Timeout)
	return c, key, target, err
}

func validatePatronus(raw json.RawMessage) error {
	_, _, _, err := loadPatronus(raw)
	return err
}

// evaluatePatronus 要求所有 evaluator 返回实际 pass，缺结果或 evaluator 错误不能放行。
func evaluatePatronus(ctx context.Context, raw json.RawMessage, in Input) (Result, error) {
	c, key, target, err := loadPatronus(raw)
	if err != nil {
		return Result{}, err
	}
	if _, err := prepare(in, textCapabilities()); err != nil {
		return Result{}, err
	}
	body := struct {
		Evaluators           []PatronusEvaluator `json:"evaluators"`
		EvaluatedModelInput  string              `json:"evaluated_model_input,omitempty"`
		EvaluatedModelOutput string              `json:"evaluated_model_output,omitempty"`
		Capture              string              `json:"capture"`
	}{Evaluators: c.Evaluators, Capture: c.Capture}
	if in.Phase == "input" {
		body.EvaluatedModelInput = strings.Join(in.Texts, "\n")
	} else {
		body.EvaluatedModelOutput = strings.Join(in.Texts, "\n")
		var contextText []string
		for _, message := range in.Messages {
			if message.TextIndex == nil {
				contextText = append(contextText, message.Content)
			}
		}
		body.EvaluatedModelInput = strings.Join(contextText, "\n")
	}
	var response struct {
		Results []struct {
			EvaluationResult *struct {
				Pass *bool `json:"pass"`
			} `json:"evaluation_result"`
			Error json.RawMessage `json:"error"`
		} `json:"results"`
	}
	if err := postJSON(ctx, target, c.Timeout, map[string]string{"X-API-Key": key}, body, &response); err != nil {
		return Result{}, err
	}
	if len(response.Results) != len(c.Evaluators) {
		return Result{}, fmt.Errorf("%w: incomplete Patronus results", ErrInvalidResponse)
	}
	blocked := false
	for _, result := range response.Results {
		if result.EvaluationResult == nil || result.EvaluationResult.Pass == nil ||
			(len(result.Error) > 0 && string(result.Error) != "null") {
			return Result{}, fmt.Errorf("%w: evaluator failed or omitted pass", ErrInvalidResponse)
		}
		blocked = blocked || !*result.EvaluationResult.Pass
	}
	if blocked {
		return Result{Blocked: true, Reason: "Patronus evaluator returned pass false"}, nil
	}
	return Result{Reason: "all Patronus evaluators passed"}, nil
}
