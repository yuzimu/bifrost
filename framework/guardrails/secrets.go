package guardrails

import (
	"context"
	"errors"
	"strings"
	"sync"

	"github.com/rs/zerolog"
	"github.com/spf13/viper"
	gitleaksconfig "github.com/zricethezav/gitleaks/v8/config"
	"github.com/zricethezav/gitleaks/v8/detect"
	gitleakslogging "github.com/zricethezav/gitleaks/v8/logging"
)

var secretsOnce sync.Once
var secretsDefault *gitleaksconfig.Config
var secretsError error

// defaultSecretsConfig 读取官方嵌入规则，隔离 Viper 并关闭可能输出秘密的库日志。
func defaultSecretsConfig() (*gitleaksconfig.Config, error) {
	secretsOnce.Do(func() {
		gitleakslogging.Logger = zerolog.Nop()
		v := viper.New()
		v.SetConfigType("toml")
		if err := v.ReadConfig(strings.NewReader(gitleaksconfig.DefaultConfig)); err != nil {
			secretsError = errors.New("Gitleaks 默认规则加载失败")
			return
		}
		var raw gitleaksconfig.ViperConfig
		if err := v.Unmarshal(&raw); err != nil {
			secretsError = errors.New("Gitleaks 默认规则解析失败")
			return
		}
		cfg, err := raw.Translate()
		if err != nil {
			secretsError = errors.New("Gitleaks 默认规则编译失败")
			return
		}
		secretsDefault = &cfg
	})
	return secretsDefault, secretsError
}

// detectSecrets 每次使用独立检测器，不允许用户通过 gitleaks:allow 注释绕过检查。
func detectSecrets(ctx context.Context, cp *compiledProfile, texts []string) ([]Finding, error) {
	detector := detect.NewDetectorContext(ctx, *cp.secrets)
	detector.IgnoreGitleaksAllow = true
	var findings []Finding
	for index, text := range texts {
		if ctx.Err() != nil {
			return nil, errors.New("Secrets 检测超时")
		}
		for _, found := range detector.DetectContext(ctx, detect.Fragment{Raw: text}) {
			skip := false
			for _, keyword := range cp.ignored {
				if strings.Contains(strings.ToLower(found.Secret), keyword) {
					skip = true
					break
				}
			}
			if skip {
				continue
			}
			if found.Secret == "" {
				return nil, errors.New("Secrets 返回无法安全映射的命中")
			}
			entity := strings.ToUpper(strings.ReplaceAll(found.RuleID, "-", "_"))
			offset := 0
			mapped := false
			for {
				pos := strings.Index(text[offset:], found.Secret)
				if pos < 0 {
					break
				}
				start := offset + pos
				end := start + len(found.Secret)
				findings = append(findings, Finding{TextIndex: index, Start: start, End: end, Entity: entity, Action: cp.secretOptions.Action, Mode: cp.secretOptions.RedactionMode, Strategy: cp.secretOptions.RedactionStrategy})
				mapped, offset = true, end
				if len(findings) > maxFindings {
					return nil, errors.New("Secrets 命中数超过安全上限")
				}
			}
			if !mapped {
				return nil, errors.New("Secrets 命中无法安全映射")
			}
		}
	}
	return findings, nil
}
