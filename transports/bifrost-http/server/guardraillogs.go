package server

import (
	"context"

	"github.com/maximhq/bifrost/core/schemas"
	"github.com/maximhq/bifrost/framework/guardrails"
	"github.com/maximhq/bifrost/framework/logstore"
	"github.com/maximhq/bifrost/transports/bifrost-http/handlers"
	"github.com/valyala/fasthttp"
)

type guardrailLogStore struct {
	logstore.LogStore
	reveal *guardrails.RevealManager
}

// authorizeGuardrailReveal 独立验证管理身份与当前日志路径，不接收推理密钥或 setup 认证。
func authorizeGuardrailReveal(ctx *fasthttp.RequestCtx, kind, id string) bool {
	if !authorizeGuardrails(ctx, "reveal") {
		return false
	}
	session, _ := ctx.UserValue(schemas.BifrostContextKeySessionToken).(string)
	apiKey, _ := ctx.UserValue(schemas.IsAPIKeyAuthContextKey).(bool)
	if session == "" && !apiKey {
		return false
	}
	requested, _ := ctx.UserValue("id").(string)
	prefix := "/api/logs/"
	if kind == "mcp" {
		prefix = "/api/mcp-logs/"
	} else if kind != "llm" {
		return false
	}
	return id != "" && requested == id && ctx.IsGet() && string(ctx.Path()) == prefix+id
}

func (s *BifrostHTTPServer) GetLogRedactionMappingResolver() handlers.LogRedactionMappingResolver {
	if s.ossPluginManager == nil {
		return nil
	}
	return s.ossPluginManager.reveal
}

func (s *BifrostHTTPServer) GetMCPLogRedactionMappingResolver() handlers.MCPLogRedactionMappingResolver {
	if s.ossPluginManager == nil {
		return nil
	}
	return s.ossPluginManager.reveal
}

// Create 在底层持久化或对象存储接收正文前完成脱敏及加密。
func (s *guardrailLogStore) Create(ctx context.Context, entry *logstore.Log) error {
	prepared, err := s.reveal.PrepareLog(entry, entry != nil && entry.RedactionData != nil)
	if err != nil {
		return err
	}
	if entry != nil {
		*entry = *prepared
	}
	return s.LogStore.Create(ctx, entry)
}

// CreateIfNotExists 保留底层幂等协议，不将明文映射交给存储。
func (s *guardrailLogStore) CreateIfNotExists(ctx context.Context, entry *logstore.Log) error {
	prepared, err := s.reveal.PrepareLog(entry, entry != nil && entry.RedactionData != nil)
	if err != nil {
		return err
	}
	if entry != nil {
		*entry = *prepared
	}
	return s.LogStore.CreateIfNotExists(ctx, entry)
}

// BatchCreateIfNotExists 先完整准备整批独立副本，失败时不写入任何未脱敏行。
func (s *guardrailLogStore) BatchCreateIfNotExists(ctx context.Context, entries []*logstore.Log) error {
	prepared := make([]*logstore.Log, len(entries))
	for i, entry := range entries {
		var err error
		prepared[i], err = s.reveal.PrepareLog(entry, entry != nil && entry.RedactionData != nil)
		if err != nil {
			return err
		}
	}
	// 队列持有 entry 并交给持久化后回调；同步替换后回调只能取得安全正文。
	for i, entry := range entries {
		if entry != nil {
			*entry = *prepared[i]
		}
	}
	return s.LogStore.BatchCreateIfNotExists(ctx, entries)
}

// CreateMCPToolLog 对工具日志使用独立身份信封。
func (s *guardrailLogStore) CreateMCPToolLog(ctx context.Context, entry *logstore.MCPToolLog) error {
	prepared, err := s.reveal.PrepareMCPLog(entry, entry != nil && entry.RedactionData != nil)
	if err != nil {
		return err
	}
	if entry != nil {
		*entry = *prepared
	}
	return s.LogStore.CreateMCPToolLog(ctx, entry)
}

// BatchCreateMCPToolLogsIfNotExists 在任何下游写入前准备工具参数和结果。
func (s *guardrailLogStore) BatchCreateMCPToolLogsIfNotExists(ctx context.Context, entries []*logstore.MCPToolLog) error {
	prepared := make([]*logstore.MCPToolLog, len(entries))
	for i, entry := range entries {
		var err error
		prepared[i], err = s.reveal.PrepareMCPLog(entry, entry != nil && entry.RedactionData != nil)
		if err != nil {
			return err
		}
	}
	for i, entry := range entries {
		if entry != nil {
			*entry = *prepared[i]
		}
	}
	return s.LogStore.BatchCreateMCPToolLogsIfNotExists(ctx, entries)
}
