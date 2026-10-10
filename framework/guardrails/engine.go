package guardrails

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash/fnv"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/cel-go/common/types"
	"github.com/maximhq/bifrost/core/schemas"
)

const maxTextBytes = 8 * 1024 * 1024
const maxFindings = 512
const maxMappingBytes = 64 * 1024

// activation 使用可信 scope，不从任意客户端身份 header 推导 ACL 身份。
func activation(scope Scope, target string) map[string]any {
	headers := scope.Headers
	params := scope.Params
	if headers == nil {
		headers = map[string]string{}
	}
	if params == nil {
		params = map[string]any{}
	}
	a := map[string]any{"headers": headers, "virtual_key": scope.VirtualKey, "customer": scope.Customer, "team": scope.Team, "user": scope.User}
	if target == "mcp" {
		args := scope.MCPArguments
		if args == nil {
			args = map[string]any{}
		}
		a["mcp_client"], a["mcp_tool"], a["mcp_arguments"] = scope.MCPClient, scope.MCPTool, args
	} else {
		a["provider"], a["model"], a["params"] = scope.Provider, scope.Model, params
	}
	return a
}

// matchingRules 同一 request ID 的输入输出使用一致采样，CEL 运行失败不得静默跳过。
func matchingRules(ctx context.Context, s *snapshot, evaluation Evaluation) ([]compiledRule, error) {
	if !s.config.Enabled {
		return nil, nil
	}
	var rules []compiledRule
	for _, r := range s.rules {
		if !r.rule.Enabled || r.rule.Target != evaluation.Target || r.rule.ApplyTo != evaluation.Phase && r.rule.ApplyTo != "both" {
			continue
		}
		h := fnv.New64a()
		fmt.Fprintf(h, "%s:%d", evaluation.RequestID, r.rule.ID)
		if int(h.Sum64()%100) >= *r.rule.SamplingRate {
			continue
		}
		out, _, err := r.program.ContextEval(ctx, activation(evaluation.Scope, evaluation.Target))
		if err != nil || types.IsError(out) || types.IsUnknown(out) {
			return nil, errors.New("规则条件执行失败")
		}
		if out == types.True {
			rules = append(rules, r)
		}
	}
	return rules, nil
}

// Evaluate 是正式的文本评估入口，仅执行显式启用且匹配的配置。
func (p *Plugin) Evaluate(ctx context.Context, evaluation Evaluation) (Result, error) {
	if evaluation.Phase != "input" && evaluation.Phase != "output" || evaluation.Target != "llm" && evaluation.Target != "mcp" {
		return Result{}, errors.New("phase 或 target 无效")
	}
	s := p.current.Load()
	rules, err := matchingRules(ctx, s, evaluation)
	if err != nil {
		return Result{}, err
	}
	rows := make([]textRow, len(evaluation.Texts))
	for i, text := range evaluation.Texts {
		rows[i] = textRow{original: text, turn: i}
	}
	return p.evaluate(ctx, s, rules, evaluation, rows, schemas.RedactionData{})
}

// EvaluateLocal 禁止执行 judge 和外部服务，供无费用的正式管理评估入口使用。
func (p *Plugin) EvaluateLocal(ctx context.Context, evaluation Evaluation) (Result, error) {
	if evaluation.Phase != "input" && evaluation.Phase != "output" || evaluation.Target != "llm" && evaluation.Target != "mcp" {
		return Result{}, errors.New("phase 或 target 无效")
	}
	s := p.current.Load()
	rules, err := matchingRules(ctx, s, evaluation)
	if err != nil {
		return Result{}, err
	}
	for _, rule := range rules {
		for _, id := range rule.rule.ProviderConfigIDs {
			cp := s.profiles[id]
			if cp.profile.Enabled && (cp.prompt != nil || cp.adapter != nil) {
				return Result{}, errors.New("本地评估不允许 judge 或外部 provider")
			}
		}
	}
	rows := make([]textRow, len(evaluation.Texts))
	for i, text := range evaluation.Texts {
		rows[i] = textRow{original: text, turn: i}
	}
	return p.evaluate(ctx, s, rules, evaluation, rows, schemas.RedactionData{})
}

// evaluate 在原始文本上统一收集跨度后一次替换，禁止不同 provider 重写结果互相覆盖。
func (p *Plugin) evaluate(ctx context.Context, s *snapshot, rules []compiledRule, evaluation Evaluation, rows []textRow, previous schemas.RedactionData) (Result, error) {
	result := Result{Texts: append([]string(nil), evaluation.Texts...), Metadata: &schemas.BifrostGuardrailMetadata{}}
	existingCalls := 0
	if bifrostCtx, ok := ctx.(*schemas.BifrostContext); ok {
		if metadata, present := schemas.GuardrailMetadataFromContext(bifrostCtx); present {
			existingCalls = len(metadata.JudgeCalls)
		}
	}
	total := 0
	for _, text := range evaluation.Texts {
		if !utf8.ValidString(text) {
			return result, errors.New("文本不是有效 UTF-8")
		}
		total += len(text)
	}
	if total > maxTextBytes {
		return result, errors.New("文本超过护栏安全上限")
	}
	var findings []Finding
	var transformations []schemas.TextRewrite
	for _, r := range rules {
		indices := selectedRows(r.rule, rows, evaluation.Phase, evaluation.Target)
		if len(indices) == 0 && len(evaluation.Tools) == 0 && !evaluation.HasToolCalls {
			continue
		}
		groups := [][]int{indices}
		if r.rule.EvaluationMode == "per_turn" && evaluation.Target == "llm" {
			groups = nil
			for _, index := range indices {
				if len(groups) == 0 || rows[groups[len(groups)-1][0]].turn != rows[index].turn {
					groups = append(groups, []int{index})
				} else {
					groups[len(groups)-1] = append(groups[len(groups)-1], index)
				}
			}
		}
		ruleCtx, cancel := context.WithTimeout(ctx, time.Duration(r.rule.Timeout)*time.Second)
		for _, id := range r.rule.ProviderConfigIDs {
			cp := s.profiles[id]
			if !cp.profile.Enabled {
				continue
			}
			for _, group := range groups {
				if cp.prompt != nil && existingCalls+len(result.Metadata.JudgeCalls) >= 512 {
					cancel()
					return result, errors.New("judge 调用次数超过安全上限")
				}
				ev := evaluation
				ev.Texts = make([]string, len(group))
				for i, index := range group {
					ev.Texts[i] = evaluation.Texts[index]
				}
				ev.Messages = selectExternalMessages(evaluation.Messages, group)
				ar, judge, err := p.evaluateProfile(ruleCtx, cp, ev)
				if judge != nil {
					judge.Phase, judge.RuleID, judge.RuleName = ev.Phase, schemas.Ptr(r.rule.ID), r.rule.Name
					result.Metadata.JudgeCalls = append(result.Metadata.JudgeCalls, *judge)
				}
				if err != nil {
					cancel()
					return result, err
				}
				if ar.Skipped {
					continue
				}
				detection := schemas.BifrostGuardrailDetection{
					Phase: evaluation.Phase, RuleID: schemas.Ptr(r.rule.ID), RuleName: r.rule.Name,
					GuardrailName: cp.profile.PolicyName, GuardrailProvider: cp.profile.ProviderName,
					Reason: "guardrail_policy_decision",
				}
				if ar.Blocked {
					detection.Assessments = []string{"block"}
					result.Metadata.Detections = append(result.Metadata.Detections, detection)
					cancel()
					result.Blocked, result.Reason, result.Texts = true, "护栏策略阻止了该内容", nil
					return result, nil
				}
				entities := make(map[string]bool)
				for _, f := range ar.Findings {
					if f.TextIndex < 0 || f.TextIndex >= len(group) {
						cancel()
						return result, errors.New("provider 返回无效文本索引")
					}
					f.TextIndex = group[f.TextIndex]
					if err := validateFinding(f, evaluation.Texts); err != nil {
						cancel()
						return result, err
					}
					if f.Action == "block" {
						detection.Assessments = []string{"block"}
						result.Metadata.Detections = append(result.Metadata.Detections, detection)
						cancel()
						result.Blocked, result.Reason, result.Texts = true, "护栏策略阻止了该内容", nil
						return result, nil
					}
					entities[f.Action] = true
					if f.Action == "redact" {
						findings = append(findings, f)
					}
				}
				if len(entities) > 0 {
					categories := make([]string, 0, len(entities))
					for entity := range entities {
						categories = append(categories, entity)
					}
					sort.Strings(categories)
					result.Metadata.Detections = append(result.Metadata.Detections, schemas.BifrostGuardrailDetection{
						Phase: evaluation.Phase, RuleID: schemas.Ptr(r.rule.ID), RuleName: r.rule.Name,
						GuardrailName: cp.profile.PolicyName, GuardrailProvider: cp.profile.ProviderName,
						Reason: "guardrail_policy_decision", Assessments: categories,
					})
				}
				for _, rewrite := range ar.Rewrites {
					var local int
					if _, err := fmt.Sscan(string(rewrite.TargetID), &local); err != nil || local < 0 || local >= len(group) || rewrite.Original != ev.Texts[local] {
						cancel()
						return result, errors.New("provider 返回不安全的文本重写")
					}
					rewrite.TargetID = schemas.TextTargetIDForIndex(group[local])
					transformations = append(transformations, rewrite)
				}
				if len(ar.Rewrites) > 0 {
					detection.Assessments = []string{"redact"}
					result.Metadata.Detections = append(result.Metadata.Detections, detection)
				}
				if len(findings) > maxFindings {
					cancel()
					return result, errors.New("脱敏命中超过安全上限")
				}
			}
		}
		cancel()
	}
	if len(transformations) > 0 {
		if len(findings) > 0 {
			return result, errors.New("同一阶段存在多个文本重写所有者")
		}
		seen := make(map[schemas.TextTargetID]bool)
		for _, rewrite := range transformations {
			if seen[rewrite.TargetID] {
				return result, errors.New("同一文本存在多个 provider 重写")
			}
			seen[rewrite.TargetID] = true
			var index int
			fmt.Sscan(string(rewrite.TargetID), &index)
			result.Texts[index] = rewrite.Replacement
		}
		result.Rewrites = transformations
		return result, nil
	}
	return applyFindings(result, evaluation, findings, previous)
}

// evaluateProfile 使用本地检测器或真实注入 adapter；仅 judge 错误按公开契约放行。
func (p *Plugin) evaluateProfile(ctx context.Context, cp *compiledProfile, ev Evaluation) (AdapterResult, *schemas.BifrostGuardrailJudgeCall, error) {
	timeout := cp.profile.Timeout
	if timeout == 0 {
		timeout = 30
	}
	child, cancel := context.WithTimeout(ctx, time.Duration(timeout)*time.Second)
	defer cancel()
	if cp.prompt != nil {
		return p.judge(child, cp, ev)
	}
	if cp.secrets != nil {
		findings, err := detectSecrets(child, cp, ev.Texts)
		return AdapterResult{Findings: findings}, nil, err
	}
	if cp.adapter != nil {
		result, err := cp.adapter.Evaluate(child, cp.profile.Config, ev)
		if err != nil {
			return AdapterResult{}, nil, errors.New("外部护栏评估失败")
		}
		return result, nil, nil
	}
	result := AdapterResult{}
	for index, text := range ev.Texts {
		for _, pattern := range cp.patterns {
			if child.Err() != nil {
				return AdapterResult{}, nil, errors.New("护栏评估超时")
			}
			for _, span := range pattern.re.FindAllStringIndex(text, maxFindings+1) {
				if span[0] == span[1] {
					return AdapterResult{}, nil, errors.New("表达式产生空跨度")
				}
				result.Findings = append(result.Findings, Finding{TextIndex: index, Start: span[0], End: span[1], Entity: pattern.pattern.EntityType, Action: pattern.pattern.Action, Mode: pattern.pattern.RedactionMode, Strategy: pattern.pattern.RedactionStrategy})
				if len(result.Findings) > maxFindings {
					return AdapterResult{}, nil, errors.New("命中超过安全上限")
				}
			}
		}
	}
	return result, nil, nil
}

// judge 将内容作为独立 JSON 消息，失联和解析错误只记录固定类别，不记录原文或模型理由。
func (p *Plugin) judge(ctx context.Context, cp *compiledProfile, ev Evaluation) (AdapterResult, *schemas.BifrostGuardrailJudgeCall, error) {
	cfg := *cp.prompt
	if strings.TrimSpace(strings.Join(ev.Texts, "")) == "" {
		return AdapterResult{}, nil, nil
	}
	call := &schemas.BifrostGuardrailJudgeCall{
		GuardrailName: cp.profile.PolicyName, GuardrailProvider: "prompt-guardrail",
		JudgeProvider: schemas.ModelProvider(cfg.JudgeProvider), JudgeModel: cfg.JudgeModel,
		JudgeRequestType: schemas.ChatCompletionRequest, Action: "ALLOW",
	}
	if err := p.deps.ChatExecutor.ValidateJudge(ctx, cfg); err != nil {
		call.Reason = "judge_validation_failed"
		return AdapterResult{}, call, nil
	}
	child, cancel := context.WithTimeout(ctx, time.Duration(cfg.Timeout)*time.Second)
	defer cancel()
	content, _ := schemas.MarshalSorted(struct {
		Content []string `json:"content"`
	}{ev.Texts})
	system := strings.ReplaceAll(cfg.PromptTemplate, "{{rule}}", cfg.Rule)
	user := string(content)
	request := &schemas.BifrostChatRequest{Provider: schemas.ModelProvider(cfg.JudgeProvider), Model: cfg.JudgeModel,
		Input: []schemas.ChatMessage{
			{Role: schemas.ChatMessageRoleSystem, Content: &schemas.ChatMessageContent{ContentStr: &system}},
			{Role: schemas.ChatMessageRoleUser, Content: &schemas.ChatMessageContent{ContentStr: &user}},
		},
		Params: &schemas.ChatParameters{MaxCompletionTokens: schemas.Ptr(cfg.MaxOutputTokens)},
	}
	response, err := p.deps.ChatExecutor.ExecuteChat(child, request)
	if response != nil && response.Usage != nil {
		call.PromptTokens, call.CompletionTokens, call.TotalTokens = response.Usage.PromptTokens, response.Usage.CompletionTokens, response.Usage.TotalTokens
		call.PromptTokensDetails, call.CompletionTokensDetails = response.Usage.PromptTokensDetails, response.Usage.CompletionTokensDetails
	}
	var text string
	if err != nil && judgeNeedsResponses(err) {
		if executor, ok := p.deps.ChatExecutor.(ResponsesExecutor); ok {
			call.JudgeRequestType = schemas.ResponsesRequest
			next, responsesErr := executor.ExecuteResponses(child, &schemas.BifrostResponsesRequest{
				Provider: request.Provider, Model: request.Model,
				Input: []schemas.ResponsesMessage{{Role: schemas.Ptr(schemas.ResponsesInputMessageRoleUser),
					Content: &schemas.ResponsesMessageContent{ContentStr: &user}}},
				Params: &schemas.ResponsesParameters{Instructions: &system, MaxOutputTokens: schemas.Ptr(cfg.MaxOutputTokens)},
			})
			err = responsesErr
			if next != nil {
				if next.Usage != nil {
					call.PromptTokens, call.CompletionTokens, call.TotalTokens = next.Usage.InputTokens, next.Usage.OutputTokens, next.Usage.TotalTokens
				}
				for _, message := range next.Output {
					if message.Content == nil {
						continue
					}
					if message.Content.ContentStr != nil {
						text += *message.Content.ContentStr
					}
					for _, block := range message.Content.ContentBlocks {
						if block.Type == schemas.ResponsesOutputMessageContentTypeText && block.Text != nil {
							text += *block.Text
						}
					}
				}
			}
		}
	}
	if err != nil {
		call.Reason = "judge_request_failed"
		return AdapterResult{}, call, nil
	}
	if call.JudgeRequestType == schemas.ChatCompletionRequest && response != nil &&
		len(response.Choices) == 1 && response.Choices[0].ChatNonStreamResponseChoice != nil &&
		response.Choices[0].Message != nil && response.Choices[0].Message.Content != nil && response.Choices[0].Message.Content.ContentStr != nil {
		text = *response.Choices[0].Message.Content.ContentStr
	}
	if text == "" {
		call.Reason = "judge_response_invalid"
		return AdapterResult{}, call, nil
	}
	var decision struct {
		Action string  `json:"action"`
		Reason *string `json:"reason"`
	}
	if err := decodeStrict([]byte(text), &decision); err != nil || decision.Action != "ALLOW" && decision.Action != "BLOCK" || decision.Reason == nil {
		call.Reason = "judge_response_invalid"
		return AdapterResult{}, call, nil
	}
	call.Action, call.Reason = decision.Action, "judge_policy_decision"
	return AdapterResult{Blocked: decision.Action == "BLOCK"}, call, nil
}

// validateFinding 拒绝越界、半字符跨度和未知动作，防止不安全 provider 结果放行。
func validateFinding(f Finding, texts []string) error {
	if f.TextIndex < 0 || f.TextIndex >= len(texts) || f.Start < 0 || f.End <= f.Start || f.End > len(texts[f.TextIndex]) || !utf8.ValidString(texts[f.TextIndex][:f.Start]) || !utf8.ValidString(texts[f.TextIndex][:f.End]) {
		return errors.New("护栏返回不安全跨度")
	}
	if f.Entity == "" || len(f.Entity) > 128 || strings.ContainsAny(f.Entity, "[]\r\n") || f.Action != "block" && f.Action != "redact" && f.Action != "detect_only" {
		return errors.New("护栏返回无效动作或类别")
	}
	if f.Action == "redact" && (f.Mode != "runtime" && f.Mode != "logs_only" && f.Mode != "runtime_reversible" || f.Strategy != "replace" && f.Strategy != "mask" && f.Strategy != "hash") {
		return errors.New("护栏返回无效脱敏配置")
	}
	return nil
}

// applyFindings 合并重叠区间并生成受限日志映射，运行态仅替换命中的文本字段。
func applyFindings(result Result, ev Evaluation, findings []Finding, previous schemas.RedactionData) (Result, error) {
	sort.SliceStable(findings, func(i, j int) bool {
		if findings[i].TextIndex != findings[j].TextIndex {
			return findings[i].TextIndex < findings[j].TextIndex
		}
		if findings[i].Start != findings[j].Start {
			return findings[i].Start < findings[j].Start
		}
		return findings[i].End > findings[j].End
	})
	literals, reversible := map[string]string{}, map[string]string{}
	result.RuntimeReplacements = map[string]string{}
	counts := make(map[string]int)
	prior := previous.ReversibleMappings.Input
	if ev.Phase == "output" {
		prior = previous.ReversibleMappings.Output
	}
	for key, value := range prior {
		reversible[key] = value
	}
	mappingBytes := 0
	for key, value := range reversible {
		mappingBytes += len(key) + len(value)
	}
	for index, text := range ev.Texts {
		var spans []Finding
		for _, f := range findings {
			if f.TextIndex != index {
				continue
			}
			if len(spans) > 0 && f.Start < spans[len(spans)-1].End {
				last := &spans[len(spans)-1]
				if last.Mode != f.Mode || last.Strategy != f.Strategy {
					return result, errors.New("重叠跨度的脱敏所有者冲突")
				}
				if f.End > last.End {
					last.End = f.End
				}
				continue
			}
			spans = append(spans, f)
		}
		var out strings.Builder
		offset := 0
		for _, f := range spans {
			out.WriteString(text[offset:f.Start])
			secret := text[f.Start:f.End]
			replacement := "[" + f.Entity + "]"
			if f.Mode != "runtime" {
				found := ""
				for key, value := range reversible {
					if value == secret && strings.HasPrefix(key, f.Entity+"-") {
						found = key
						break
					}
				}
				if found == "" {
					for {
						counts[f.Entity]++
						found = fmt.Sprintf("%s-%d", f.Entity, counts[f.Entity])
						if _, exists := reversible[found]; !exists {
							break
						}
					}
					reversible[found] = secret
					mappingBytes += len(found) + len(secret)
				}
				replacement = "[" + found + "]"
			} else if f.Strategy == "mask" {
				replacement = "[" + f.Entity + ":" + strings.Repeat("*", utf8.RuneCountInString(secret)) + "]"
			} else if f.Strategy == "hash" {
				sum := sha256.Sum256([]byte(secret))
				replacement = "[" + f.Entity + ":" + hex.EncodeToString(sum[:8]) + "]"
			}
			if previousValue, ok := literals[secret]; ok && previousValue != replacement {
				return result, errors.New("同一值存在冲突脱敏映射")
			}
			literals[secret] = replacement
			mappingBytes += len(secret) + len(replacement)
			if len(literals)+len(reversible) > maxFindings || mappingBytes > maxMappingBytes {
				return result, errors.New("日志脱敏映射超过安全上限")
			}
			if f.Mode == "logs_only" {
				out.WriteString(secret)
			} else {
				result.RuntimeReplacements[secret] = replacement
				out.WriteString(replacement)
			}
			offset = f.End
		}
		out.WriteString(text[offset:])
		result.Texts[index] = out.String()
		if result.Texts[index] != text {
			result.Rewrites = append(result.Rewrites, schemas.TextRewrite{TargetID: schemas.TextTargetIDForIndex(index), Original: text, Replacement: result.Texts[index]})
		}
	}
	phase := schemas.RedactionPhase(ev.Phase)
	result.Redaction.LiteralReplacements.MergePhase(phase, literals)
	result.Redaction.ReversibleMappings.MergePhase(phase, reversible)
	return result, nil
}

// selectedRows 按会话轮次选取检测对象，输出和 MCP 不应用历史裁剪。
func selectedRows(rule Rule, rows []textRow, phase, target string) []int {
	last := 0
	for _, row := range rows {
		if row.turn > last {
			last = row.turn
		}
	}
	start := 0
	if phase == "input" && target == "llm" {
		if rule.SendAllConversationTurns != nil && !*rule.SendAllConversationTurns {
			start = last - rule.MaxTurnsToSend
		} else if rule.SendAllConversationTurns == nil && rule.MaxTurnsToSend > 0 {
			start = last - rule.MaxTurnsToSend + 1
		}
	}
	var indices []int
	for index, row := range rows {
		if row.turn >= start {
			indices = append(indices, index)
		}
	}
	return indices
}

// MarshalConfigForStorage 使用相同严格边界，插件管理入口不能存入未知字段或原始凭据。
func (p *Plugin) MarshalConfigForStorage(config map[string]any) (map[string]any, error) {
	cfg, err := DecodeConfig(config)
	if err != nil {
		return nil, err
	}
	s, err := p.compile(*cfg)
	if err != nil {
		return nil, err
	}
	raw, _ := json.Marshal(s.config)
	var stored map[string]any
	_ = json.Unmarshal(raw, &stored)
	return stored, nil
}

func (p *Plugin) RedactConfig(config map[string]any) (map[string]any, error) {
	return p.MarshalConfigForStorage(config)
}
