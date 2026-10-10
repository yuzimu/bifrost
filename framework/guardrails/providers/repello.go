package providers

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
)

type RepelloConfig struct {
	connection
	AssetID string `json:"asset_id"`
}

// loadRepello 只接受文档中的 Argus asset 配置，不增加网关 action。
func loadRepello(raw json.RawMessage) (RepelloConfig, string, string, error) {
	var c RepelloConfig
	if err := decodeConfig(raw, &c); err != nil {
		return c, "", "", err
	}
	if strings.TrimSpace(c.AssetID) == "" {
		return c, "", "", fmt.Errorf("%w: asset_id required", ErrInvalidConfig)
	}
	key, err := secret(c.APIKey)
	if err != nil {
		return c, "", "", err
	}
	target, err := endpoint(c.BaseURL, "https://argusapi.repello.ai/sdk/v1", "/analyze/prompt", false)
	if err != nil {
		return c, "", "", err
	}
	_, err = timeoutSeconds(c.Timeout)
	return c, key, target, err
}

func validateRepello(raw json.RawMessage) error {
	_, _, _, err := loadRepello(raw)
	return err
}

// evaluateRepello 区分 passed、flagged 和 blocked；未知 verdict 是协议错误。
func evaluateRepello(ctx context.Context, raw json.RawMessage, in Input) (Result, error) {
	c, key, target, err := loadRepello(raw)
	if err != nil {
		return Result{}, err
	}
	if _, err := prepare(in, textCapabilities()); err != nil {
		return Result{}, err
	}
	stage := "prompt"
	if in.Phase == "output" {
		stage = "response"
		target = strings.TrimSuffix(target, "/analyze/prompt") + "/analyze/response"
	}
	body := struct {
		AssetID  string            `json:"asset_id"`
		ScanData map[string]string `json:"scan_data"`
	}{c.AssetID, map[string]string{stage: strings.Join(in.Texts, "\n")}}
	var response struct {
		Verdict string `json:"verdict"`
	}
	if err := postJSON(ctx, target, c.Timeout, map[string]string{"X-API-Key": key}, body, &response); err != nil {
		return Result{}, err
	}
	switch response.Verdict {
	case "passed":
		return Result{Reason: "Repello Argus passed content"}, nil
	case "flagged":
		return Result{Reason: "Repello Argus flagged content without blocking"}, nil
	case "blocked":
		return Result{Blocked: true, Reason: "Repello Argus blocked content"}, nil
	default:
		return Result{}, fmt.Errorf("%w: unknown Argus verdict", ErrInvalidResponse)
	}
}
