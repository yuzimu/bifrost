package providers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
)

type AzurePIIConfig struct {
	cloudAzureAuth
	APIVersion        string   `json:"api_version,omitempty"`
	Language          string   `json:"language,omitempty"`
	ModelVersion      string   `json:"model_version,omitempty"`
	Domain            string   `json:"domain,omitempty"`
	PIICategories     []string `json:"pii_categories,omitempty"`
	Action            string   `json:"action,omitempty"`
	RedactionStrategy string   `json:"redaction_strategy,omitempty"`
	RedactionMode     string   `json:"redaction_mode,omitempty"`
	LoggingOptOut     *bool    `json:"logging_opt_out,omitempty"`
	StringIndexType   string   `json:"string_index_type,omitempty"`
}

// loadAzurePII 验证公开配置和 Unicode 坐标模式，默认只检测不拦截。
func loadAzurePII(raw json.RawMessage) (AzurePIIConfig, string, error) {
	var c AzurePIIConfig
	if err := decodeConfig(raw, &c); err != nil {
		return c, "", err
	}
	if c.APIVersion == "" {
		c.APIVersion = "2026-05-01"
	}
	if c.Language == "" {
		c.Language = "en"
	}
	if c.ModelVersion == "" {
		c.ModelVersion = "latest"
	}
	if c.Domain == "" {
		c.Domain = "none"
	}
	if c.Action == "" {
		c.Action = "detect_only"
	}
	if c.RedactionStrategy == "" {
		c.RedactionStrategy = "replace"
	}
	if c.RedactionMode == "" {
		c.RedactionMode = "runtime"
	}
	if c.StringIndexType == "" {
		c.StringIndexType = "UnicodeCodePoint"
	}
	if c.Domain != "none" && c.Domain != "phi" ||
		c.StringIndexType != "UnicodeCodePoint" ||
		c.Action != "detect_only" && c.Action != "block" && c.Action != "redact" ||
		c.RedactionStrategy != "replace" && c.RedactionStrategy != "mask" && c.RedactionStrategy != "hash" ||
		c.RedactionMode != "runtime" && c.RedactionMode != "logs_only" && c.RedactionMode != "runtime_reversible" {
		return c, "", ErrInvalidConfig
	}
	for _, value := range append([]string{c.APIVersion, c.Language, c.ModelVersion}, c.PIICategories...) {
		if !cloudResourceSegment.MatchString(value) {
			return c, "", ErrInvalidConfig
		}
	}
	if err := validateCloudAzureAuth(&c.cloudAzureAuth); err != nil {
		return c, "", err
	}
	target, err := cloudEndpoint(c.Endpoint, "", "/language/:analyze-text", true)
	return c, target + "?api-version=" + url.QueryEscape(c.APIVersion), err
}

func validateAzurePII(raw json.RawMessage) error {
	_, _, err := loadAzurePII(raw)
	return err
}

type azurePIIResponse struct {
	Kind    string `json:"kind"`
	Results *struct {
		Documents []struct {
			ID       string `json:"id"`
			Entities *[]struct {
				Text     string `json:"text"`
				Category string `json:"category"`
				Offset   *int   `json:"offset"`
				Length   *int   `json:"length"`
			} `json:"entities"`
		} `json:"documents"`
		Errors []json.RawMessage `json:"errors"`
	} `json:"results"`
}

// evaluateAzurePII 每份原文独立提交，并严格校验实体文本和 Unicode 到字节的映射。
func evaluateAzurePII(ctx context.Context, raw json.RawMessage, in Input) (Result, error) {
	c, target, err := loadAzurePII(raw)
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
	headers, err := cloudAzureHeaders(ctx, c.cloudAzureAuth)
	if err != nil {
		return Result{}, err
	}
	result := Result{Reason: "Azure PII allowed content"}
	for _, item := range items {
		body := struct {
			Kind       string `json:"kind"`
			Parameters struct {
				ModelVersion    string   `json:"modelVersion"`
				Domain          string   `json:"domain"`
				PIICategories   []string `json:"piiCategories,omitempty"`
				LoggingOptOut   *bool    `json:"loggingOptOut,omitempty"`
				StringIndexType string   `json:"stringIndexType"`
			} `json:"parameters"`
			AnalysisInput struct {
				Documents []map[string]string `json:"documents"`
			} `json:"analysisInput"`
		}{Kind: "PiiEntityRecognition"}
		body.Parameters.ModelVersion, body.Parameters.Domain = c.ModelVersion, c.Domain
		body.Parameters.PIICategories, body.Parameters.LoggingOptOut = c.PIICategories, c.LoggingOptOut
		body.Parameters.StringIndexType = c.StringIndexType
		body.AnalysisInput.Documents = []map[string]string{{"id": "0", "language": c.Language, "text": item.Text}}
		var response azurePIIResponse
		if err := postJSON(ctx, target, c.Timeout, headers, body, &response); err != nil {
			return Result{}, err
		}
		if response.Kind != "PiiEntityRecognitionResults" || response.Results == nil ||
			len(response.Results.Errors) != 0 || len(response.Results.Documents) != 1 ||
			response.Results.Documents[0].ID != "0" || response.Results.Documents[0].Entities == nil {
			return Result{}, fmt.Errorf("%w: incomplete Azure PII analysis", ErrInvalidResponse)
		}
		for _, entity := range *response.Results.Documents[0].Entities {
			if entity.Offset == nil || entity.Length == nil || *entity.Offset < 0 || *entity.Length <= 0 ||
				*entity.Offset > len(item.Text) || *entity.Length > len(item.Text)-*entity.Offset ||
				!cloudResourceSegment.MatchString(entity.Category) {
				return Result{}, ErrInvalidResponse
			}
			start, end, ok := runeSpan(item.Text, *entity.Offset, *entity.Offset+*entity.Length, entity.Text)
			if !ok {
				return Result{}, ErrInvalidResponse
			}
			switch c.Action {
			case "block":
				result.Blocked = true
				result.Reason = "Azure PII detected sensitive information"
			case "detect_only":
				result.Reason = "Azure PII detected sensitive information without blocking"
			case "redact":
				if item.Index < 0 {
					return Result{Blocked: true, Reason: "Azure PII cannot safely redact read-only content"}, nil
				}
				result.Findings = append(result.Findings, Finding{TextIndex: item.Index, Start: start, End: end,
					Entity: entity.Category, Action: "redact", Strategy: c.RedactionStrategy, Mode: c.RedactionMode})
				result.Reason = "Azure PII returned validated redaction spans"
			}
		}
	}
	if len(result.Findings) > 0 && !safeFindings(result.Findings) {
		return Result{Blocked: true, Reason: "Azure PII returned ambiguous redaction spans"}, nil
	}
	return result, nil
}
