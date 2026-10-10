package providers

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"unicode/utf8"

	"golang.org/x/oauth2"
	"golang.org/x/oauth2/google"
)

type ModelArmorConfig struct {
	ProjectID          string `json:"project_id"`
	Location           string `json:"location"`
	TemplateID         string `json:"template_id"`
	AuthType           string `json:"auth_type,omitempty"`
	ServiceAccountJSON string `json:"service_account_json,omitempty"`
	BaseURL            string `json:"base_url,omitempty"`
	ImagesEnabled      bool   `json:"images_enabled,omitempty"`
	Timeout            int    `json:"timeout,omitempty"`
}

// modelArmorServiceKey 只接收环境引用，允许格式化 JSON，但不允许自定义凭据交换目标。
func modelArmorServiceKey(ref string) ([]byte, error) {
	if !envName.MatchString(ref) {
		return nil, ErrInvalidConfig
	}
	raw := []byte(os.Getenv(strings.TrimPrefix(ref, "env.")))
	if len(raw) > maxConfigBytes || !utf8.Valid(raw) || !validObject(raw) {
		return nil, ErrInvalidConfig
	}
	var key struct {
		Type        string `json:"type"`
		TokenURI    string `json:"token_uri"`
		ClientEmail string `json:"client_email"`
		PrivateKey  string `json:"private_key"`
	}
	if json.Unmarshal(raw, &key) != nil || key.Type != "service_account" ||
		key.TokenURI != "https://oauth2.googleapis.com/token" || key.ClientEmail == "" || key.PrivateKey == "" {
		return nil, fmt.Errorf("%w: invalid Google service account credentials", ErrInvalidConfig)
	}
	if _, err := google.JWTConfigFromJSON(raw, "https://www.googleapis.com/auth/cloud-platform"); err != nil {
		return nil, ErrInvalidConfig
	}
	return raw, nil
}

// loadModelArmor 展开资源标识并明确认证模式，图像开关不能冒充宿主尚未提供的能力。
func loadModelArmor(raw json.RawMessage) (ModelArmorConfig, string, error) {
	var c ModelArmorConfig
	if err := decodeConfig(raw, &c); err != nil {
		return c, "", err
	}
	if c.ImagesEnabled {
		return c, "", fmt.Errorf("%w: host image input is unavailable", ErrInvalidConfig)
	}
	for _, field := range []*string{&c.ProjectID, &c.Location, &c.TemplateID} {
		value, err := cloudValue(*field)
		if err != nil || !cloudResourceSegment.MatchString(value) {
			return c, "", ErrInvalidConfig
		}
		*field = value
	}
	if c.AuthType == "" {
		c.AuthType = "default_credential"
	} else {
		value, err := cloudValue(c.AuthType)
		if err != nil {
			return c, "", err
		}
		c.AuthType = value
	}
	switch c.AuthType {
	case "default_credential":
		if c.ServiceAccountJSON != "" {
			return c, "", ErrInvalidConfig
		}
	case "service_account_json":
		if _, err := modelArmorServiceKey(c.ServiceAccountJSON); err != nil {
			return c, "", err
		}
	default:
		return c, "", fmt.Errorf("%w: unsupported Google auth_type", ErrInvalidConfig)
	}
	if _, err := timeoutSeconds(c.Timeout); err != nil {
		return c, "", err
	}
	target, err := cloudEndpoint(c.BaseURL, "https://modelarmor."+c.Location+".rep.googleapis.com",
		"/v1/projects/"+c.ProjectID+"/locations/"+c.Location+"/templates/"+c.TemplateID, false)
	return c, target, err
}

func validateModelArmor(raw json.RawMessage) error {
	_, _, err := loadModelArmor(raw)
	return err
}

// modelArmorHeaders 用现有 Google OAuth 实现获取访问令牌，凭据与 SDK 错误不进入结果。
func modelArmorHeaders(ctx context.Context, c ModelArmorConfig) (map[string]string, error) {
	ctx = context.WithValue(ctx, oauth2.HTTPClient, cloudIdentityHTTP)
	var source oauth2.TokenSource
	if c.AuthType == "service_account_json" {
		raw, err := modelArmorServiceKey(c.ServiceAccountJSON)
		if err != nil {
			return nil, err
		}
		key, err := google.JWTConfigFromJSON(raw, "https://www.googleapis.com/auth/cloud-platform")
		if err != nil {
			return nil, ErrInvalidConfig
		}
		source = key.TokenSource(ctx)
	} else {
		credential, err := google.FindDefaultCredentials(ctx, "https://www.googleapis.com/auth/cloud-platform")
		if err != nil {
			return nil, fmt.Errorf("%w: Google default credentials unavailable", ErrProvider)
		}
		source = credential.TokenSource
	}
	if source == nil {
		return nil, ErrProvider
	}
	token, err := source.Token()
	if err != nil || token == nil || token.AccessToken == "" || strings.ContainsAny(token.AccessToken, "\r\n") {
		return nil, fmt.Errorf("%w: Google authentication failed", ErrProvider)
	}
	return map[string]string{"Authorization": "Bearer " + token.AccessToken}, nil
}

type modelArmorResponse struct {
	SanitizationResult *struct {
		InvocationResult string                                `json:"invocationResult"`
		FilterMatchState string                                `json:"filterMatchState"`
		FilterResults    map[string]map[string]json.RawMessage `json:"filterResults"`
	} `json:"sanitizationResult"`
}

type modelArmorFilter struct {
	ExecutionState string `json:"executionState"`
	MatchState     string `json:"matchState"`
}

// modelArmorFilterMatch 明确检查执行状态，跳过或缺失判定不能作为安全放行。
func modelArmorFilterMatch(raw json.RawMessage) (bool, error) {
	var f modelArmorFilter
	if err := cloudJSONField(raw, &f); err != nil {
		return false, err
	}
	if f.ExecutionState != "EXECUTION_SUCCESS" {
		return false, ErrInvalidResponse
	}
	switch f.MatchState {
	case "NO_MATCH_FOUND":
		return false, nil
	case "MATCH_FOUND":
		return true, nil
	default:
		return false, ErrInvalidResponse
	}
}

// modelArmorDecision 只有 SDP 的成功文本脱敏可变，其余匹配和不可安全映射的变换均阻断。
func modelArmorDecision(response modelArmorResponse, item cloudItem) (Result, error) {
	s := response.SanitizationResult
	if s == nil || s.InvocationResult != "SUCCESS" || len(s.FilterResults) == 0 ||
		s.FilterMatchState != "NO_MATCH_FOUND" && s.FilterMatchState != "MATCH_FOUND" {
		return Result{}, ErrInvalidResponse
	}
	matched, blocked, transformed := false, false, false
	replacement := ""
	known := map[string]string{
		"rai": "raiFilterResult", "pi_and_jailbreak": "piAndJailbreakFilterResult",
		"csam": "csamFilterFilterResult", "malicious_uris": "maliciousUriFilterResult",
		"virus_scan": "virusScanFilterResult",
	}
	for name, result := range s.FilterResults {
		if name != "sdp" {
			field, ok := known[name]
			if !ok || len(result) != 1 {
				return Result{}, ErrInvalidResponse
			}
			match, err := modelArmorFilterMatch(result[field])
			if err != nil {
				return Result{}, err
			}
			matched, blocked = matched || match, blocked || match
			continue
		}
		if len(result) != 1 {
			return Result{}, ErrInvalidResponse
		}
		var sdp map[string]json.RawMessage
		if err := cloudJSONField(result["sdpFilterResult"], &sdp); err != nil {
			return Result{}, err
		}
		if len(sdp) == 0 {
			return Result{}, ErrInvalidResponse
		}
		inspectMatch, deidentifyMatch := false, false
		for field, value := range sdp {
			switch field {
			case "inspectResult":
				match, err := modelArmorFilterMatch(value)
				if err != nil {
					return Result{}, err
				}
				inspectMatch = match
			case "deidentifyResult":
				match, err := modelArmorFilterMatch(value)
				if err != nil {
					return Result{}, err
				}
				deidentifyMatch = match
				if match {
					var deidentified struct {
						Data *struct {
							Text     *string         `json:"text"`
							ByteItem json.RawMessage `json:"byteItem"`
						} `json:"data"`
					}
					if err := cloudJSONField(value, &deidentified); err != nil {
						return Result{}, err
					}
					if deidentified.Data == nil || deidentified.Data.Text == nil ||
						len(deidentified.Data.ByteItem) != 0 {
						return Result{Blocked: true, Reason: "Model Armor transformation cannot be mapped safely"}, nil
					}
					replacement, transformed = *deidentified.Data.Text, true
				}
			default:
				return Result{}, ErrInvalidResponse
			}
		}
		matched = matched || inspectMatch || deidentifyMatch
		blocked = blocked || inspectMatch && !deidentifyMatch
	}
	if s.FilterMatchState == "NO_MATCH_FOUND" {
		if matched || transformed {
			return Result{}, ErrInvalidResponse
		}
		return Result{Reason: "Model Armor allowed content"}, nil
	}
	if blocked || !matched || !transformed {
		return Result{Blocked: true, Reason: "Model Armor blocked content"}, nil
	}
	return cloudRewrite(item, replacement), nil
}

// evaluateModelArmor 按阶段使用官方 sanitize 方法，每个 data item 独立对应自己的原文索引。
func evaluateModelArmor(ctx context.Context, raw json.RawMessage, in Input) (Result, error) {
	c, target, err := loadModelArmor(raw)
	if err != nil {
		return Result{}, err
	}
	items, err := cloudItems(in)
	if err != nil {
		return Result{}, err
	}
	ctx, cancel, err := cloudContext(ctx, c.Timeout)
	if err != nil {
		return Result{}, err
	}
	defer cancel()
	headers, err := modelArmorHeaders(ctx, c)
	if err != nil {
		return Result{}, err
	}
	method, field := ":sanitizeUserPrompt", "userPromptData"
	if in.Phase == "output" {
		method, field = ":sanitizeModelResponse", "modelResponseData"
	}
	result := Result{Reason: "Model Armor allowed content"}
	for _, item := range items {
		var response modelArmorResponse
		body := map[string]any{field: struct {
			Text string `json:"text"`
		}{item.Text}}
		if err := postJSON(ctx, target+method, c.Timeout, headers, body, &response); err != nil {
			return Result{}, err
		}
		decision, err := modelArmorDecision(response, item)
		if err != nil {
			return Result{}, err
		}
		if decision.Blocked {
			return decision, nil
		}
		result.Rewrites = append(result.Rewrites, decision.Rewrites...)
		if len(decision.Rewrites) != 0 {
			result.Reason = decision.Reason
		}
	}
	return result, nil
}
