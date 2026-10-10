package guardrails

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/maximhq/bifrost/core/schemas"
	"github.com/maximhq/bifrost/framework/encrypt"
	"github.com/maximhq/bifrost/framework/logstore"
	"github.com/tidwall/gjson"
	"github.com/tidwall/sjson"
	"github.com/valyala/fasthttp"
)

type redactionDataHandle struct {
	plugin *Plugin
	id     string
}

// ResolveRedactionData 将受限日志快照交给同步日志链路，上下文仅保留小句柄。
func (h redactionDataHandle) ResolveRedactionData() (schemas.RedactionData, bool) {
	if h.plugin == nil {
		return schemas.RedactionData{}, false
	}
	value, ok := h.plugin.redactions.Load(h.id)
	if !ok {
		return schemas.RedactionData{}, false
	}
	return value.(schemas.RedactionData).Clone(), true
}

// RedactionSnapshot 提供宿主日志包装器的显式入口，不导出所有请求的原始映射。
func (p *Plugin) RedactionSnapshot(ctx context.Context) (schemas.RedactionData, bool) {
	value, ok := ctx.Value(schemas.BifrostContextKeyRedactionData).(redactionDataHandle)
	if !ok || value.plugin != p {
		return schemas.RedactionData{}, false
	}
	return value.ResolveRedactionData()
}

// MappingCipher 必须是持久化加密密钥对应的实现；禁用加密时不得返回原文。
type MappingCipher interface {
	Enabled() bool
	Encrypt(string) (string, error)
	Decrypt(string) (string, error)
}

type FrameworkMappingCipher struct{}

func (FrameworkMappingCipher) Enabled() bool { return encrypt.IsEnabled() }
func (FrameworkMappingCipher) Encrypt(value string) (string, error) {
	if !encrypt.IsEnabled() {
		return "", errors.New("脱敏映射加密未启用")
	}
	return encrypt.Encrypt(value)
}
func (FrameworkMappingCipher) Decrypt(value string) (string, error) {
	if !encrypt.IsEnabled() {
		return "", errors.New("脱敏映射加密未启用")
	}
	return encrypt.Decrypt(value)
}

// RevealAuthorizer 每次独立检查已认证身份的日志读取和揭示权限；kind 为 llm 或 mcp。
type RevealAuthorizer func(*fasthttp.RequestCtx, string, string) bool

type RevealManager struct {
	cipher    MappingCipher
	authorize RevealAuthorizer
}

func NewRevealManager(cipher MappingCipher, authorize RevealAuthorizer) *RevealManager {
	return &RevealManager{cipher: cipher, authorize: authorize}
}

type mappingEnvelope struct {
	Version  int                          `json:"version"`
	Kind     string                       `json:"kind"`
	LogID    string                       `json:"log_id"`
	Mappings schemas.RedactionMapsByPhase `json:"mappings"`
}

// sealMapping 绑定日志身份并使用既有加密能力，映射只写日志列而不进入插件配置。
func (m *RevealManager) sealMapping(kind, id string, data *schemas.RedactionData) (string, error) {
	if data == nil || !data.ReversibleMappings.HasReplacements() {
		return "", nil
	}
	if id == "" || m == nil || m.cipher == nil || !m.cipher.Enabled() {
		return "", errors.New("脱敏映射缺少持久加密能力")
	}
	raw, err := schemas.MarshalSorted(mappingEnvelope{Version: 1, Kind: kind, LogID: id, Mappings: data.ReversibleMappings.Clone()})
	if err != nil || len(raw) > 4*maxMappingBytes {
		return "", errors.New("脱敏映射无效或超过上限")
	}
	value, err := m.cipher.Encrypt(string(raw))
	if err != nil || value == "" || value == string(raw) {
		return "", errors.New("脱敏映射加密失败")
	}
	return value, nil
}

// resolve 每次先授权再解密，防止跨日志搬运密文和任何内存缓存权限绕过。
func (m *RevealManager) resolve(ctx *fasthttp.RequestCtx, kind, id, ciphertext string) (*schemas.RedactionMapsByPhase, error) {
	if ctx == nil {
		return nil, nil
	}
	ctx.Response.Header.Set("Cache-Control", "no-store")
	if m == nil || m.authorize == nil || id == "" || !m.authorize(ctx, kind, id) {
		return nil, nil
	}
	if ciphertext == "" || m.cipher == nil || !m.cipher.Enabled() {
		return nil, nil
	}
	raw, err := m.cipher.Decrypt(ciphertext)
	if err != nil || len(raw) > 4*maxMappingBytes {
		return nil, errors.New("脱敏映射解密失败")
	}
	var envelope mappingEnvelope
	if decodeStrict([]byte(raw), &envelope) != nil || envelope.Version != 1 ||
		envelope.Kind != kind || envelope.LogID != id {
		return nil, errors.New("脱敏映射身份无效")
	}
	copy := envelope.Mappings.Clone()
	return &copy, nil
}

func (m *RevealManager) ResolveLogRedactionMapping(ctx *fasthttp.RequestCtx, log *logstore.Log) (*schemas.RedactionMapsByPhase, error) {
	if log == nil {
		return nil, nil
	}
	return m.resolve(ctx, "llm", log.ID, log.RedactionMapping)
}

func (m *RevealManager) ResolveMCPLogRedactionMapping(ctx *fasthttp.RequestCtx, log *logstore.MCPToolLog) (*schemas.RedactionMapsByPhase, error) {
	if log == nil {
		return nil, nil
	}
	return m.resolve(ctx, "mcp", log.ID, log.RedactionMapping)
}

// redactStoredJSON 只替换日志正文中的字符串值，不改 JSON 键或使用 regex 扫描整份 JSON。
func redactStoredJSON(raw string, replacements map[string]string) (string, error) {
	if raw == "" || len(replacements) == 0 {
		return raw, nil
	}
	if validateJSON([]byte(raw)) != nil {
		return "", errors.New("日志正文不是有效 JSON")
	}
	out := raw
	var walk func(gjson.Result, string) error
	walk = func(node gjson.Result, path string) error {
		if node.Type == gjson.String {
			next := schemas.ApplyLiteralReplacements(node.String(), replacements)
			if path == "" {
				encoded, err := schemas.MarshalSorted(next)
				out = string(encoded)
				return err
			}
			var err error
			out, err = sjson.Set(out, path, next)
			return err
		}
		var err error
		node.ForEach(func(key, value gjson.Result) bool {
			segment := key.Raw
			if node.IsObject() {
				segment = strings.NewReplacer(`\`, `\\`, ".", `\.`, ":", `\:`).Replace(key.String())
			}
			if path != "" {
				segment = path + "." + segment
			}
			err = walk(value, segment)
			return err == nil
		})
		return err
	}
	if err := walk(gjson.Parse(raw), ""); err != nil {
		return "", errors.New("日志正文脱敏失败")
	}
	return out, nil
}

// redactStoredValue 返回独立副本，避免异步日志与调用者共享可变内容。
func redactStoredValue[T any](value *T, replacements map[string]string) (*T, error) {
	if value == nil {
		return nil, nil
	}
	raw, err := schemas.MarshalSorted(value)
	if err != nil {
		return nil, err
	}
	redacted, err := redactStoredJSON(string(raw), replacements)
	if err != nil {
		return nil, err
	}
	var out T
	if json.Unmarshal([]byte(redacted), &out) != nil {
		return nil, errors.New("日志脱敏副本解析失败")
	}
	return &out, nil
}

// PrepareLog 供宿主日志写包装器使用，必须在任何数据库、对象存储或导出写入前调用。
func (m *RevealManager) PrepareLog(log *logstore.Log, loggingEnabled bool) (*logstore.Log, error) {
	if log == nil {
		return nil, nil
	}
	out := *log
	out.RevealRedactionMapping = nil
	if !loggingEnabled || log.RedactionData == nil {
		out.RedactionData = nil
		return &out, nil
	}
	data := log.RedactionData.Clone()
	mapping, err := m.sealMapping("llm", log.ID, &data)
	if err != nil {
		return nil, err
	}
	out.RedactionMapping = mapping
	input, output := data.LiteralReplacements.Input, data.LiteralReplacements.Output
	mixed := data.LiteralReplacements.MergedForMixedFields()
	if out.InputHistoryParsed != nil {
		next, err := redactStoredValue(&out.InputHistoryParsed, input)
		if err != nil {
			return nil, err
		}
		out.InputHistoryParsed = *next
	}
	if out.ResponsesInputHistoryParsed != nil {
		next, err := redactStoredValue(&out.ResponsesInputHistoryParsed, input)
		if err != nil {
			return nil, err
		}
		out.ResponsesInputHistoryParsed = *next
	}
	out.OutputMessageParsed, err = redactStoredValue(out.OutputMessageParsed, output)
	if err != nil {
		return nil, err
	}
	params, err := redactStoredValue(&out.ParamsParsed, input)
	if err != nil {
		return nil, err
	}
	out.ParamsParsed = *params
	tools, err := redactStoredValue(&out.ToolsParsed, input)
	if err != nil {
		return nil, err
	}
	out.ToolsParsed = *tools
	calls, err := redactStoredValue(&out.ToolCallsParsed, output)
	if err != nil {
		return nil, err
	}
	out.ToolCallsParsed = *calls
	out.ErrorDetailsParsed, err = redactStoredValue(out.ErrorDetailsParsed, mixed)
	if err != nil {
		return nil, err
	}
	out.ContentSummary = schemas.ApplyLiteralReplacements(out.ContentSummary, mixed)
	if out.ResponsesOutputParsed != nil {
		next, err := redactStoredValue(&out.ResponsesOutputParsed, output)
		if err != nil {
			return nil, err
		}
		out.ResponsesOutputParsed = *next
	}
	for _, field := range []struct {
		value        *string
		replacements map[string]string
	}{
		{&out.InputHistory, input}, {&out.ResponsesInputHistory, input},
		{&out.OutputMessage, output}, {&out.ResponsesOutput, output},
		{&out.RawRequest, input}, {&out.RawResponse, output},
		{&out.Params, input}, {&out.Tools, input}, {&out.ToolCalls, output},
		{&out.ErrorDetails, mixed},
	} {
		*field.value, err = redactStoredJSON(*field.value, field.replacements)
		if err != nil {
			return nil, err
		}
	}
	out.RedactionData = nil
	return &out, nil
}

// PrepareMCPLog 与 LLM 日志分离身份，参数和工具结果分别使用输入/输出映射。
func (m *RevealManager) PrepareMCPLog(log *logstore.MCPToolLog, loggingEnabled bool) (*logstore.MCPToolLog, error) {
	if log == nil {
		return nil, nil
	}
	out := *log
	out.RevealRedactionMapping = nil
	if !loggingEnabled || log.RedactionData == nil {
		out.RedactionData = nil
		return &out, nil
	}
	data := log.RedactionData.Clone()
	mapping, err := m.sealMapping("mcp", log.ID, &data)
	if err != nil {
		return nil, err
	}
	out.RedactionMapping = mapping
	out.Arguments, err = redactStoredJSON(out.Arguments, data.LiteralReplacements.Input)
	if err != nil {
		return nil, err
	}
	out.Result, err = redactStoredJSON(out.Result, data.LiteralReplacements.Output)
	if err != nil {
		return nil, err
	}
	args, err := redactStoredValue(&out.ArgumentsParsed, data.LiteralReplacements.Input)
	if err != nil {
		return nil, err
	}
	out.ArgumentsParsed = *args
	result, err := redactStoredValue(&out.ResultParsed, data.LiteralReplacements.Output)
	if err != nil {
		return nil, err
	}
	out.ResultParsed = *result
	mixed := data.LiteralReplacements.MergedForMixedFields()
	out.ErrorDetailsParsed, err = redactStoredValue(out.ErrorDetailsParsed, mixed)
	if err != nil {
		return nil, err
	}
	out.ErrorDetails, err = redactStoredJSON(out.ErrorDetails, mixed)
	if err != nil {
		return nil, err
	}
	out.RedactionData = nil
	return &out, nil
}
