package providers

import (
	"context"
	"encoding/json"
	"fmt"
	"unicode/utf8"
)

type AzureContentSafetyConfig struct {
	cloudAzureAuth
	AnalyzeEnabled              *bool    `json:"analyze_enabled,omitempty"`
	AnalyzeSeverityThreshold    string   `json:"analyze_severity_threshold,omitempty"`
	JailbreakShieldEnabled      bool     `json:"jailbreak_shield_enabled,omitempty"`
	IndirectAttackShieldEnabled bool     `json:"indirect_attack_shield_enabled,omitempty"`
	CopyrightEnabled            bool     `json:"copyright_enabled,omitempty"`
	TextBlocklistEnabled        bool     `json:"text_blocklist_enabled,omitempty"`
	BlocklistNames              []string `json:"blocklist_names,omitempty"`
}

// loadAzureContentSafety 拒绝空策略与无名称的 blocklist，认证字段复用云端校验。
func loadAzureContentSafety(raw json.RawMessage) (AzureContentSafetyConfig, int, error) {
	var c AzureContentSafetyConfig
	if err := decodeConfig(raw, &c); err != nil {
		return c, 0, err
	}
	if c.AnalyzeEnabled == nil {
		enabled := true
		c.AnalyzeEnabled = &enabled
	}
	if c.AnalyzeSeverityThreshold == "" {
		c.AnalyzeSeverityThreshold = "medium"
	}
	threshold := map[string]int{"low": 2, "medium": 4, "high": 6}[c.AnalyzeSeverityThreshold]
	if threshold == 0 || !*c.AnalyzeEnabled && !c.JailbreakShieldEnabled &&
		!c.IndirectAttackShieldEnabled && !c.CopyrightEnabled && !c.TextBlocklistEnabled ||
		c.TextBlocklistEnabled && len(c.BlocklistNames) == 0 ||
		!c.TextBlocklistEnabled && len(c.BlocklistNames) != 0 {
		return c, 0, ErrInvalidConfig
	}
	seen := make(map[string]bool)
	for _, name := range c.BlocklistNames {
		if !cloudResourceSegment.MatchString(name) || seen[name] {
			return c, 0, ErrInvalidConfig
		}
		seen[name] = true
	}
	return c, threshold, validateCloudAzureAuth(&c.cloudAzureAuth)
}

func validateAzureContentSafety(raw json.RawMessage) error {
	_, _, err := loadAzureContentSafety(raw)
	return err
}

type azureSafetyAnalysis struct {
	CategoriesAnalysis *[]struct {
		Category string `json:"category"`
		Severity *int   `json:"severity"`
	} `json:"categoriesAnalysis"`
	BlocklistsMatch []struct {
		BlocklistName   string `json:"blocklistName"`
		BlocklistItemID string `json:"blocklistItemId"`
	} `json:"blocklistsMatch"`
}

// azureSafetyAnalyze 使用四级严重程度和真实 blocklist 返回值，不伪造本地脱敏跨度。
func azureSafetyAnalyze(ctx context.Context, c AzureContentSafetyConfig, headers map[string]string,
	text string, threshold int, blocklist bool) (bool, error) {
	target, err := cloudEndpoint(c.Endpoint, "", "/contentsafety/text:analyze", true)
	if err != nil {
		return false, err
	}
	body := struct {
		Text               string   `json:"text"`
		Categories         []string `json:"categories,omitempty"`
		OutputType         string   `json:"outputType"`
		BlocklistNames     []string `json:"blocklistNames,omitempty"`
		HaltOnBlocklistHit bool     `json:"haltOnBlocklistHit"`
	}{Text: text, OutputType: "FourSeverityLevels"}
	if blocklist {
		body.BlocklistNames, body.HaltOnBlocklistHit = c.BlocklistNames, true
	} else {
		body.Categories = []string{"Hate", "Sexual", "Violence", "SelfHarm"}
	}
	var response azureSafetyAnalysis
	if err := postJSON(ctx, target+"?api-version=2024-09-01", c.Timeout, headers, body, &response); err != nil {
		return false, err
	}
	if response.CategoriesAnalysis == nil {
		return false, ErrInvalidResponse
	}
	for _, match := range response.BlocklistsMatch {
		found := false
		for _, name := range c.BlocklistNames {
			found = found || match.BlocklistName == name
		}
		if !blocklist || !found || match.BlocklistItemID == "" {
			return false, ErrInvalidResponse
		}
	}
	if blocklist {
		return len(response.BlocklistsMatch) > 0, nil
	}
	seen := make(map[string]bool)
	blocked := false
	for _, category := range *response.CategoriesAnalysis {
		if category.Severity == nil || seen[category.Category] {
			return false, ErrInvalidResponse
		}
		switch category.Category {
		case "Hate", "Sexual", "Violence", "SelfHarm":
		default:
			return false, ErrInvalidResponse
		}
		switch *category.Severity {
		case 0, 2, 4, 6:
		default:
			return false, ErrInvalidResponse
		}
		seen[category.Category] = true
		blocked = blocked || *category.Severity >= threshold
	}
	if len(seen) != 4 {
		return false, ErrInvalidResponse
	}
	return blocked, nil
}

// azureSafetyShield 分别使用 userPrompt 和 documents，校验所请求操作的判定字段。
func azureSafetyShield(ctx context.Context, c AzureContentSafetyConfig, headers map[string]string,
	text string, indirect bool) (bool, error) {
	target, err := cloudEndpoint(c.Endpoint, "", "/contentsafety/text:shieldPrompt", true)
	if err != nil {
		return false, err
	}
	body := struct {
		UserPrompt string   `json:"userPrompt,omitempty"`
		Documents  []string `json:"documents,omitempty"`
	}{}
	if indirect {
		body.Documents = []string{text}
	} else {
		body.UserPrompt = text
	}
	var response struct {
		UserPromptAnalysis *struct {
			AttackDetected *bool `json:"attackDetected"`
		} `json:"userPromptAnalysis"`
		DocumentsAnalysis []struct {
			AttackDetected *bool `json:"attackDetected"`
		} `json:"documentsAnalysis"`
	}
	if err := postJSON(ctx, target+"?api-version=2024-09-01", c.Timeout, headers, body, &response); err != nil {
		return false, err
	}
	if indirect {
		if len(response.DocumentsAnalysis) != 1 || response.DocumentsAnalysis[0].AttackDetected == nil {
			return false, ErrInvalidResponse
		}
		return *response.DocumentsAnalysis[0].AttackDetected, nil
	}
	if response.UserPromptAnalysis == nil || response.UserPromptAnalysis.AttackDetected == nil {
		return false, ErrInvalidResponse
	}
	return *response.UserPromptAnalysis.AttackDetected, nil
}

// azureSafetyCopyright 只用于完整输出文本，按 protectedMaterialAnalysis.detected 执行拦截。
func azureSafetyCopyright(ctx context.Context, c AzureContentSafetyConfig, headers map[string]string, text string) (bool, error) {
	target, err := cloudEndpoint(c.Endpoint, "", "/contentsafety/text:detectProtectedMaterial", true)
	if err != nil {
		return false, err
	}
	var response struct {
		ProtectedMaterialAnalysis *struct {
			Detected *bool `json:"detected"`
		} `json:"protectedMaterialAnalysis"`
	}
	if err := postJSON(ctx, target+"?api-version=2024-09-01", c.Timeout, headers,
		struct {
			Text string `json:"text"`
		}{text}, &response); err != nil {
		return false, err
	}
	if response.ProtectedMaterialAnalysis == nil || response.ProtectedMaterialAnalysis.Detected == nil {
		return false, ErrInvalidResponse
	}
	return *response.ProtectedMaterialAnalysis.Detected, nil
}

// evaluateAzureContentSafety 逐个启用项执行真实云协议，单项失败交由父层失败策略决定。
func evaluateAzureContentSafety(ctx context.Context, raw json.RawMessage, in Input) (Result, error) {
	c, threshold, err := loadAzureContentSafety(raw)
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
	result := Result{Reason: "Azure Content Safety allowed content"}
	for _, item := range items {
		if utf8.RuneCountInString(item.Text) > 10000 {
			return Result{}, ErrInvalidInput
		}
		calls := 0
		apply := func(blocked bool, err error) error {
			calls++
			if err != nil {
				return err
			}
			result.Blocked = result.Blocked || blocked
			return nil
		}
		if *c.AnalyzeEnabled {
			if err := apply(azureSafetyAnalyze(ctx, c, headers, item.Text, threshold, false)); err != nil {
				return Result{}, err
			}
		}
		if c.TextBlocklistEnabled {
			if err := apply(azureSafetyAnalyze(ctx, c, headers, item.Text, threshold, true)); err != nil {
				return Result{}, err
			}
		}
		if in.Phase == "input" && c.JailbreakShieldEnabled {
			if err := apply(azureSafetyShield(ctx, c, headers, item.Text, false)); err != nil {
				return Result{}, err
			}
		}
		if in.Phase == "input" && c.IndirectAttackShieldEnabled {
			if err := apply(azureSafetyShield(ctx, c, headers, item.Text, true)); err != nil {
				return Result{}, err
			}
		}
		if in.Phase == "output" && c.CopyrightEnabled {
			if err := apply(azureSafetyCopyright(ctx, c, headers, item.Text)); err != nil {
				return Result{}, err
			}
		}
		if calls == 0 {
			return Result{}, fmt.Errorf("%w: no Azure operation enabled for this phase", ErrInvalidConfig)
		}
	}
	if result.Blocked {
		result.Reason = "Azure Content Safety blocked content"
	}
	return result, nil
}
