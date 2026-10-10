package handlers

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"

	"github.com/fasthttp/router"
	"github.com/maximhq/bifrost/core/schemas"
	"github.com/maximhq/bifrost/framework/guardrails"
	"github.com/maximhq/bifrost/transports/bifrost-http/lib"
	"github.com/valyala/fasthttp"
)

// GuardrailsAuthorizer 必须验证服务端身份与具体操作权限，不能信任客户端声称的角色。
type GuardrailsAuthorizer func(*fasthttp.RequestCtx, string) bool

type GuardrailsHandler struct {
	plugin    *guardrails.Plugin
	authorize GuardrailsAuthorizer
}

func NewGuardrailsHandler(plugin *guardrails.Plugin, authorize GuardrailsAuthorizer) *GuardrailsHandler {
	return &GuardrailsHandler{plugin: plugin, authorize: authorize}
}

// RegisterRoutes 要求宿主接入认证中间件，授权回调缺失时所有管理入口均拒绝。
func (h *GuardrailsHandler) RegisterRoutes(r *router.Router, middlewares ...schemas.BifrostHTTPMiddleware) {
	r.GET("/api/guardrails", lib.ChainMiddlewares(h.guarded("read", h.listProfiles), middlewares...))
	r.GET("/api/guardrails/rules", lib.ChainMiddlewares(h.guarded("read", h.listRules), middlewares...))
	r.POST("/api/guardrails/rules", lib.ChainMiddlewares(h.guarded("write", h.createRule), middlewares...))
	r.PUT("/api/guardrails/rules/{id}", lib.ChainMiddlewares(h.guarded("write", h.updateRule), middlewares...))
	r.DELETE("/api/guardrails/rules/{id}", lib.ChainMiddlewares(h.guarded("write", h.deleteRule), middlewares...))
	r.POST("/api/guardrails/evaluate", lib.ChainMiddlewares(h.guarded("evaluate", h.evaluate), middlewares...))
	r.POST("/api/guardrails/prompt-guardrail/verify", lib.ChainMiddlewares(h.guarded("verify", h.verifyPrompt), middlewares...))
	r.GET("/api/guardrails/{provider}", lib.ChainMiddlewares(h.guarded("read", h.listProfiles), middlewares...))
	r.POST("/api/guardrails/{provider}", lib.ChainMiddlewares(h.guarded("write", h.createProfile), middlewares...))
	r.PUT("/api/guardrails/{provider}", lib.ChainMiddlewares(h.guarded("write", h.updateProfile), middlewares...))
	r.DELETE("/api/guardrails/{provider}", lib.ChainMiddlewares(h.guarded("write", h.deleteProfile), middlewares...))
}

// guarded 在读写策略和手动评估之前强制授权，不依赖路径是否受一般认证保护。
func (h *GuardrailsHandler) guarded(operation string, next fasthttp.RequestHandler) fasthttp.RequestHandler {
	return func(ctx *fasthttp.RequestCtx) {
		ctx.Response.Header.Set("Cache-Control", "no-store")
		if h.authorize == nil || !h.authorize(ctx, operation) {
			guardrailsJSON(ctx, 403, map[string]string{"error": "无权访问护栏管理"})
			return
		}
		if h.plugin == nil {
			guardrailsJSON(ctx, 503, map[string]string{"error": "护栏模块未初始化"})
			return
		}
		next(ctx)
	}
}

// guardrailsDecode 拒绝未知字段、过大请求和尾随 JSON，不回显可能含凭据的原文。
func guardrailsDecode(ctx *fasthttp.RequestCtx, value any) error {
	if len(ctx.PostBody()) > 1024*1024 {
		return errors.New("请求体超过上限")
	}
	return guardrails.DecodeJSON(ctx.PostBody(), value)
}

func guardrailsJSON(ctx *fasthttp.RequestCtx, status int, value any) {
	body, err := schemas.MarshalSorted(value)
	if err != nil {
		status, body = 500, []byte(`{"error":"响应序列化失败"}`)
	}
	ctx.SetStatusCode(status)
	ctx.SetContentType("application/json")
	ctx.SetBody(body)
}

func guardrailsError(ctx *fasthttp.RequestCtx, err error) {
	status := 400
	if err.Error() == "读取护栏配置失败" || err.Error() == "保存护栏配置失败" || err.Error() == "未配置持久化存储" {
		status = 503
	}
	guardrailsJSON(ctx, status, map[string]string{"error": err.Error()})
}

type guardrailRuleBody struct {
	ID                          uint     `json:"id,omitempty"`
	Name                        string   `json:"name"`
	Description                 string   `json:"description,omitempty"`
	Enabled                     *bool    `json:"enabled"`
	Target                      string   `json:"target,omitempty"`
	CELExpression               string   `json:"celExpression"`
	ApplyTo                     string   `json:"applyTo"`
	SamplingRate                *int     `json:"samplingRate,omitempty"`
	Timeout                     int      `json:"timeout,omitempty"`
	SendAllConversationTurns    *bool    `json:"sendAllConversationTurns,omitempty"`
	MaxTurnsToSend              int      `json:"maxTurnsToSend,omitempty"`
	EvaluationMode              string   `json:"evaluationMode,omitempty"`
	StreamReplayEventIntervalMS int      `json:"streamReplayEventIntervalMs,omitempty"`
	SelectedGuardrailProfiles   []string `json:"selectedGuardrailProfiles"`
}

// toRule 验证 provider:id 绑定后转换到配置格式，不混淆两套字段协议。
func (body guardrailRuleBody) toRule(cfg guardrails.Config, id uint) (guardrails.Rule, error) {
	if body.Enabled == nil {
		return guardrails.Rule{}, errors.New("enabled 为必填字段")
	}
	rule := guardrails.Rule{ID: id, Name: body.Name, Description: body.Description, Enabled: *body.Enabled,
		Target: body.Target, CELExpression: body.CELExpression, ApplyTo: body.ApplyTo,
		SamplingRate: body.SamplingRate, Timeout: body.Timeout, SendAllConversationTurns: body.SendAllConversationTurns,
		MaxTurnsToSend: body.MaxTurnsToSend, EvaluationMode: body.EvaluationMode, StreamReplayEventIntervalMS: body.StreamReplayEventIntervalMS}
	for _, ref := range body.SelectedGuardrailProfiles {
		parts := strings.Split(ref, ":")
		if len(parts) != 2 {
			return rule, errors.New("selectedGuardrailProfiles 格式无效")
		}
		value, err := strconv.ParseUint(parts[1], 10, 32)
		if err != nil || value == 0 {
			return rule, errors.New("配置引用 ID 无效")
		}
		found := false
		for _, profile := range cfg.Providers {
			if profile.ID == uint(value) && profile.ProviderName == parts[0] {
				found = true
				break
			}
		}
		if !found {
			return rule, errors.New("关联配置不存在或 provider 不匹配")
		}
		rule.ProviderConfigIDs = append(rule.ProviderConfigIDs, uint(value))
	}
	return rule, nil
}

func guardrailRuleResponse(rule guardrails.Rule, cfg guardrails.Config) guardrailRuleBody {
	body := guardrailRuleBody{ID: rule.ID, Name: rule.Name, Description: rule.Description, Enabled: schemas.Ptr(rule.Enabled), Target: rule.Target,
		CELExpression: rule.CELExpression, ApplyTo: rule.ApplyTo, SamplingRate: rule.SamplingRate, Timeout: rule.Timeout,
		SendAllConversationTurns: rule.SendAllConversationTurns, MaxTurnsToSend: rule.MaxTurnsToSend, EvaluationMode: rule.EvaluationMode,
		StreamReplayEventIntervalMS: rule.StreamReplayEventIntervalMS, SelectedGuardrailProfiles: []string{}}
	for _, id := range rule.ProviderConfigIDs {
		for _, profile := range cfg.Providers {
			if profile.ID == id {
				body.SelectedGuardrailProfiles = append(body.SelectedGuardrailProfiles, profile.ProviderName+":"+strconv.FormatUint(uint64(id), 10))
				break
			}
		}
	}
	return body
}

// listRules 返回公开分页 envelope；无参数时返回全部已配置规则。
func (h *GuardrailsHandler) listRules(ctx *fasthttp.RequestCtx) {
	cfg := h.plugin.Config()
	offset, limit := 0, len(cfg.Rules)
	for name, dst := range map[string]*int{"offset": &offset, "limit": &limit} {
		if value := string(ctx.QueryArgs().Peek(name)); value != "" {
			number, err := strconv.Atoi(value)
			if err != nil || number < 0 {
				guardrailsError(ctx, errors.New("分页参数无效"))
				return
			}
			*dst = number
		}
	}
	start := min(offset, len(cfg.Rules))
	end := start + min(limit, len(cfg.Rules)-start)
	rules := make([]guardrailRuleBody, 0, end-start)
	for _, rule := range cfg.Rules[start:end] {
		rules = append(rules, guardrailRuleResponse(rule, cfg))
	}
	guardrailsJSON(ctx, 200, map[string]any{"count": len(cfg.Rules), "limit": limit, "offset": offset, "rules": rules})
}

// createRule 在同一临界区分配 ID 并保存完整配置，失败不会切换运行态。
func (h *GuardrailsHandler) createRule(ctx *fasthttp.RequestCtx) {
	var body guardrailRuleBody
	if err := guardrailsDecode(ctx, &body); err != nil {
		guardrailsError(ctx, err)
		return
	}
	if body.ID != 0 {
		guardrailsError(ctx, errors.New("新规则 ID 由服务端分配"))
		return
	}
	var id uint
	err := h.plugin.ChangeConfig(ctx, func(cfg *guardrails.Config) error {
		id = 1
		for _, rule := range cfg.Rules {
			if rule.ID >= id {
				id = rule.ID + 1
			}
		}
		rule, err := body.toRule(*cfg, id)
		if err != nil {
			return err
		}
		cfg.Rules = append(cfg.Rules, rule)
		return nil
	})
	if err != nil {
		guardrailsError(ctx, err)
		return
	}
	cfg := h.plugin.Config()
	for _, rule := range cfg.Rules {
		if rule.ID == id {
			guardrailsJSON(ctx, 201, guardrailRuleResponse(rule, cfg))
			return
		}
	}
}

func guardrailPathID(ctx *fasthttp.RequestCtx) (uint, error) {
	value, _ := ctx.UserValue("id").(string)
	id, err := strconv.ParseUint(value, 10, 32)
	if err != nil || id == 0 {
		return 0, errors.New("规则 ID 无效")
	}
	return uint(id), nil
}

// updateRule 按公开 PUT 契约要求完整规则正文。
func (h *GuardrailsHandler) updateRule(ctx *fasthttp.RequestCtx) {
	id, err := guardrailPathID(ctx)
	if err != nil {
		guardrailsError(ctx, err)
		return
	}
	var body guardrailRuleBody
	if err := guardrailsDecode(ctx, &body); err != nil {
		guardrailsError(ctx, err)
		return
	}
	if body.ID != 0 && body.ID != id {
		guardrailsError(ctx, errors.New("规则 ID 不匹配"))
		return
	}
	err = h.plugin.ChangeConfig(ctx, func(cfg *guardrails.Config) error {
		for i, rule := range cfg.Rules {
			if rule.ID == id {
				next, err := body.toRule(*cfg, id)
				if err != nil {
					return err
				}
				cfg.Rules[i] = next
				return nil
			}
		}
		return errors.New("规则不存在")
	})
	if err != nil {
		guardrailsError(ctx, err)
		return
	}
	cfg := h.plugin.Config()
	for _, rule := range cfg.Rules {
		if rule.ID == id {
			guardrailsJSON(ctx, 200, guardrailRuleResponse(rule, cfg))
			return
		}
	}
}

// deleteRule 只删除指定规则，不触碰日志或其它持久数据。
func (h *GuardrailsHandler) deleteRule(ctx *fasthttp.RequestCtx) {
	id, err := guardrailPathID(ctx)
	if err != nil {
		guardrailsError(ctx, err)
		return
	}
	err = h.plugin.ChangeConfig(ctx, func(cfg *guardrails.Config) error {
		for i, rule := range cfg.Rules {
			if rule.ID == id {
				cfg.Rules = append(cfg.Rules[:i], cfg.Rules[i+1:]...)
				return nil
			}
		}
		return errors.New("规则不存在")
	})
	if err != nil {
		guardrailsError(ctx, err)
		return
	}
	guardrailsJSON(ctx, 200, map[string]string{"message": "规则已删除"})
}

type guardrailProfileBody struct {
	ID      uint            `json:"id,omitempty"`
	Name    *string         `json:"name,omitempty"`
	Enabled *bool           `json:"enabled,omitempty"`
	Config  json.RawMessage `json:"config,omitempty"`
}

func (h *GuardrailsHandler) provider(ctx *fasthttp.RequestCtx) (string, error) {
	provider, _ := ctx.UserValue("provider").(string)
	for _, name := range h.plugin.ProviderNames() {
		if provider == name {
			return provider, nil
		}
	}
	return "", errors.New("未知或尚未实现的 guardrail provider")
}

// profileJSON 生成文档要求的扁平配置行，只含环境引用而非解析后的凭据。
func profileJSON(profile guardrails.Profile) map[string]any {
	var row map[string]any
	_ = json.Unmarshal(profile.Config, &row)
	if row == nil {
		row = map[string]any{}
	}
	row["id"], row["name"], row["enabled"] = profile.ID, profile.PolicyName, profile.Enabled
	return row
}

// listProfiles 无 provider 路径时返回分组列表，单 provider 返回其配置列表。
func (h *GuardrailsHandler) listProfiles(ctx *fasthttp.RequestCtx) {
	cfg := h.plugin.Config()
	if ctx.UserValue("provider") != nil {
		provider, err := h.provider(ctx)
		if err != nil {
			guardrailsError(ctx, err)
			return
		}
		rows := []map[string]any{}
		for _, profile := range cfg.Providers {
			if profile.ProviderName == provider {
				rows = append(rows, profileJSON(profile))
			}
		}
		guardrailsJSON(ctx, 200, rows)
		return
	}
	groups := []map[string]any{}
	for _, provider := range h.plugin.ProviderNames() {
		rows := []map[string]any{}
		for _, profile := range cfg.Providers {
			if profile.ProviderName == provider {
				rows = append(rows, profileJSON(profile))
			}
		}
		capabilities, _ := h.plugin.ProviderCapabilities(provider)
		groups = append(groups, map[string]any{"name": provider, "configs": rows, "capabilities": capabilities})
	}
	guardrailsJSON(ctx, 200, groups)
}

// createProfile 不执行付费 Verify，配置校验与正式评估分离。
func (h *GuardrailsHandler) createProfile(ctx *fasthttp.RequestCtx) {
	provider, err := h.provider(ctx)
	if err != nil {
		guardrailsError(ctx, err)
		return
	}
	var body guardrailProfileBody
	if err := guardrailsDecode(ctx, &body); err != nil {
		guardrailsError(ctx, err)
		return
	}
	if body.ID != 0 || body.Name == nil || body.Enabled == nil || len(body.Config) == 0 {
		guardrailsError(ctx, errors.New("需要 name、enabled、config，ID 由服务端分配"))
		return
	}
	var saved guardrails.Profile
	err = h.plugin.ChangeConfig(ctx, func(cfg *guardrails.Config) error {
		id := uint(1)
		for _, profile := range cfg.Providers {
			if profile.ID >= id {
				id = profile.ID + 1
			}
		}
		saved = guardrails.Profile{ID: id, ProviderName: provider, PolicyName: *body.Name, Enabled: *body.Enabled, Config: body.Config}
		cfg.Providers = append(cfg.Providers, saved)
		return nil
	})
	if err != nil {
		guardrailsError(ctx, err)
		return
	}
	guardrailsJSON(ctx, 201, profileJSON(saved))
}

// updateProfile 支持公开 API 的 enabled/name 部分更新，config 提交时必须完整有效。
func (h *GuardrailsHandler) updateProfile(ctx *fasthttp.RequestCtx) {
	provider, err := h.provider(ctx)
	if err != nil {
		guardrailsError(ctx, err)
		return
	}
	var body guardrailProfileBody
	if err := guardrailsDecode(ctx, &body); err != nil {
		guardrailsError(ctx, err)
		return
	}
	if body.ID == 0 {
		guardrailsError(ctx, errors.New("配置 ID 为必填字段"))
		return
	}
	var saved guardrails.Profile
	err = h.plugin.ChangeConfig(ctx, func(cfg *guardrails.Config) error {
		for i, profile := range cfg.Providers {
			if profile.ID != body.ID || profile.ProviderName != provider {
				continue
			}
			if body.Name != nil {
				profile.PolicyName = *body.Name
			}
			if body.Enabled != nil {
				profile.Enabled = *body.Enabled
			}
			if len(body.Config) > 0 {
				profile.Config = body.Config
			}
			cfg.Providers[i], saved = profile, profile
			return nil
		}
		return errors.New("配置不存在")
	})
	if err != nil {
		guardrailsError(ctx, err)
		return
	}
	guardrailsJSON(ctx, 200, profileJSON(saved))
}

// deleteProfile 拒绝删除仍被规则引用的配置，避免运行策略失效。
func (h *GuardrailsHandler) deleteProfile(ctx *fasthttp.RequestCtx) {
	provider, err := h.provider(ctx)
	if err != nil {
		guardrailsError(ctx, err)
		return
	}
	var body struct {
		ID uint `json:"id"`
	}
	if err := guardrailsDecode(ctx, &body); err != nil {
		guardrailsError(ctx, err)
		return
	}
	err = h.plugin.ChangeConfig(ctx, func(cfg *guardrails.Config) error {
		for _, rule := range cfg.Rules {
			for _, id := range rule.ProviderConfigIDs {
				if id == body.ID {
					return errors.New("配置仍被规则引用")
				}
			}
		}
		for i, profile := range cfg.Providers {
			if profile.ID == body.ID && profile.ProviderName == provider {
				cfg.Providers = append(cfg.Providers[:i], cfg.Providers[i+1:]...)
				return nil
			}
		}
		return errors.New("配置不存在")
	})
	if err != nil {
		guardrailsError(ctx, err)
		return
	}
	guardrailsJSON(ctx, 200, map[string]string{"message": "配置已删除"})
}

// evaluate 使用认证后上下文与本地检测器，客户端不能传入 team 或 user 声称身份。
func (h *GuardrailsHandler) evaluate(ctx *fasthttp.RequestCtx) {
	var body struct {
		Text   string `json:"text"`
		Phase  string `json:"phase"`
		Target string `json:"target"`
	}
	if err := guardrailsDecode(ctx, &body); err != nil {
		guardrailsError(ctx, err)
		return
	}
	if body.Phase == "" {
		body.Phase = "input"
	}
	if body.Target == "" {
		body.Target = "llm"
	}
	bifrostCtx := getBifrostContextFromFastHTTP(ctx)
	defer bifrostCtx.Cancel()
	scope, err := h.plugin.ResolveScope(bifrostCtx)
	if err != nil {
		guardrailsError(ctx, err)
		return
	}
	result, err := h.plugin.EvaluateLocal(context.Context(bifrostCtx), guardrails.Evaluation{Target: body.Target, Phase: body.Phase, Texts: []string{body.Text}, Scope: scope})
	if err != nil {
		guardrailsError(ctx, err)
		return
	}
	guardrailsJSON(ctx, 200, result)
}

// verifyPrompt 仅由显式管理操作触发真实模型调用，CRUD 与本地评估不会隐式收费。
func (h *GuardrailsHandler) verifyPrompt(ctx *fasthttp.RequestCtx) {
	var body guardrailProfileBody
	if err := guardrailsDecode(ctx, &body); err != nil {
		guardrailsError(ctx, err)
		return
	}
	if len(body.Config) == 0 {
		guardrailsError(ctx, errors.New("需要 config"))
		return
	}
	bifrostCtx := getBifrostContextFromFastHTTP(ctx)
	defer bifrostCtx.Cancel()
	if err := h.plugin.VerifyPrompt(bifrostCtx, body.Config); err != nil {
		guardrailsError(ctx, err)
		return
	}
	guardrailsJSON(ctx, 200, map[string]any{"verified": true})
}
