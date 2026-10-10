package providers

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
)

type LakeraConfig struct {
	connection
	ProjectID         string `json:"project_id"`
	Action            string `json:"action,omitempty"`
	RedactionStrategy string `json:"redaction_strategy,omitempty"`
	RedactionMode     string `json:"redaction_mode,omitempty"`
}

// loadLakera 仅接受文档定义的 action 和脱敏配置；未知组合不会覆盖宿主 last-good。
func loadLakera(raw json.RawMessage) (LakeraConfig, string, string, error) {
	var c LakeraConfig
	if err := decodeConfig(raw, &c); err != nil {
		return c, "", "", err
	}
	if strings.TrimSpace(c.ProjectID) == "" {
		return c, "", "", fmt.Errorf("%w: project_id required", ErrInvalidConfig)
	}
	if c.Action == "" {
		c.Action = "block"
	}
	if c.RedactionStrategy == "" {
		c.RedactionStrategy = "replace"
	}
	if c.RedactionMode == "" {
		c.RedactionMode = "runtime"
	}
	if c.Action != "block" && c.Action != "detect_only" && c.Action != "redact" {
		return c, "", "", fmt.Errorf("%w: invalid action", ErrInvalidConfig)
	}
	if c.RedactionStrategy != "replace" && c.RedactionStrategy != "mask" && c.RedactionStrategy != "hash" {
		return c, "", "", fmt.Errorf("%w: invalid redaction_strategy", ErrInvalidConfig)
	}
	if c.RedactionMode != "runtime" && c.RedactionMode != "logs_only" && c.RedactionMode != "runtime_reversible" {
		return c, "", "", fmt.Errorf("%w: invalid redaction_mode", ErrInvalidConfig)
	}
	key, err := secret(c.APIKey)
	if err != nil {
		return c, "", "", err
	}
	target, err := endpoint(c.BaseURL, "https://api.lakera.ai", "/v2/guard", false)
	if err != nil {
		return c, "", "", err
	}
	_, err = timeoutSeconds(c.Timeout)
	return c, key, target, err
}

func validateLakera(raw json.RawMessage) error {
	_, _, _, err := loadLakera(raw)
	return err
}

type lakeraResponse struct {
	Flagged *bool `json:"flagged"`
	Payload []struct {
		MessageID    *int   `json:"message_id"`
		Start        *int   `json:"start"`
		End          *int   `json:"end"`
		Text         string `json:"text"`
		DetectorType string `json:"detector_type"`
	} `json:"payload"`
	Breakdown []struct {
		Detected     *bool  `json:"detected"`
		DetectorType string `json:"detector_type"`
	} `json:"breakdown"`
}

// evaluateLakera 逐个保护文本作为最新交互筛查，历史消息仅提供上下文。
func evaluateLakera(ctx context.Context, raw json.RawMessage, in Input) (Result, error) {
	c, key, target, err := loadLakera(raw)
	if err != nil {
		return Result{}, err
	}
	messages, err := prepare(in, NewRegistry()["lakera"].Capabilities())
	if err != nil {
		return Result{}, err
	}
	duration, err := timeoutSeconds(c.Timeout)
	if err != nil {
		return Result{}, err
	}
	ctx, cancel := context.WithTimeout(ctx, duration)
	defer cancel()
	combined := Result{Reason: "Lakera allowed content"}
	calls := 0
	for position, message := range messages {
		if message.TextIndex == nil {
			continue
		}
		calls++
		selected := messages[:position+1]
		body := struct {
			Messages  []Message         `json:"messages"`
			ProjectID string            `json:"project_id"`
			Payload   bool              `json:"payload"`
			Breakdown bool              `json:"breakdown"`
			Metadata  map[string]string `json:"metadata"`
		}{selected, c.ProjectID, c.Action == "redact", true, map[string]string{
			"bifrost_source": in.Phase, "bifrost_provider": in.Scope.Provider, "bifrost_model": in.Scope.Model,
		}}
		var response lakeraResponse
		if err := postJSON(ctx, target, c.Timeout, map[string]string{"Authorization": "Bearer " + key}, body, &response); err != nil {
			return Result{}, err
		}
		if response.Flagged == nil {
			return Result{}, fmt.Errorf("%w: missing Lakera flagged decision", ErrInvalidResponse)
		}
		if !*response.Flagged {
			continue
		}
		switch c.Action {
		case "block":
			return Result{Blocked: true, Reason: "Lakera flagged content"}, nil
		case "detect_only":
			combined.Reason = "Lakera detected content without blocking"
		case "redact":
			result := lakeraFindings(c, selected, position, response)
			if result.Blocked {
				return result, nil
			}
			combined.Findings = append(combined.Findings, result.Findings...)
			combined.Reason = "Lakera returned validated redaction spans"
		}
	}
	if calls == 0 {
		return Result{}, fmt.Errorf("%w: Lakera requires mapped text messages", ErrInvalidInput)
	}
	if len(combined.Findings) > 0 && !safeFindings(combined.Findings) {
		return Result{Blocked: true, Reason: "Lakera returned ambiguous redaction spans"}, nil
	}
	return combined, nil
}

// lakeraFindings 只有命中内容和坐标均可精确映射且覆盖检测项时才交给父引擎脱敏。
func lakeraFindings(c LakeraConfig, messages []Message, target int, response lakeraResponse) Result {
	block := Result{Blocked: true, Reason: "Lakera flagged content without safely mappable redaction spans"}
	if len(response.Payload) == 0 || len(response.Breakdown) == 0 {
		return block
	}
	covered := make(map[string]bool)
	var findings []Finding
	for _, span := range response.Payload {
		if span.MessageID == nil || span.Start == nil || span.End == nil ||
			*span.MessageID != target || !strings.HasPrefix(span.DetectorType, "pii/") {
			return block
		}
		message := messages[target]
		if message.TextIndex == nil || len(message.ToolCalls) != 0 || message.Role == "tool" {
			return block
		}
		start, end, ok := runeSpan(message.Content, *span.Start, *span.End, span.Text)
		if !ok {
			return block
		}
		entity := strings.TrimPrefix(span.DetectorType, "pii/")
		if entity == "" || len(entity) > 128 || strings.IndexFunc(entity, func(r rune) bool {
			return !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '_')
		}) != -1 {
			return block
		}
		findings = append(findings, Finding{
			TextIndex: *message.TextIndex, Start: start, End: end, Entity: entity,
			Action: "redact", Strategy: c.RedactionStrategy, Mode: c.RedactionMode,
		})
		covered[span.DetectorType] = true
	}
	detected := false
	for _, detector := range response.Breakdown {
		if detector.Detected == nil {
			return block
		}
		if *detector.Detected {
			detected = true
			if !covered[detector.DetectorType] {
				return block
			}
		}
	}
	if !detected || !safeFindings(findings) {
		return block
	}
	return Result{Findings: findings}
}
