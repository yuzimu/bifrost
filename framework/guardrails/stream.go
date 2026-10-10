package guardrails

import (
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/maximhq/bifrost/core/schemas"
	"github.com/tidwall/gjson"
)

type streamTextRewriter struct{}

func NewStreamTextRewriter() StreamTextRewriter { return streamTextRewriter{} }

// ValidateRequest 要求真实 gate 与原生文本协议，不能在上游执行后才发现无法安全同步。
func (streamTextRewriter) ValidateRequest(ctx *schemas.BifrostContext, req *schemas.BifrostRequest) error {
	if ctx == nil || req == nil {
		return errors.New("缺少流上下文")
	}
	tracer := ctx.Value(schemas.BifrostContextKeyTracer)
	if _, ok := tracer.(interface {
		TransformPausedStreamBuffer(string, schemas.PausedStreamBufferTransform) error
	}); !ok {
		return errors.New("流累积器没有事务重写能力")
	}
	if req.ChatRequest == nil && req.ResponsesRequest == nil && req.TextCompletionRequest == nil {
		return errors.New("不支持该流协议")
	}
	if raw, _ := ctx.Value(schemas.BifrostContextKeyUseRawRequestBody).(bool); raw {
		if _, ok := ctx.Value(schemas.BifrostContextKeyRawStreamTextCodec).(schemas.RawStreamTextCodec); !ok {
			return errors.New("原生流缺少文本 codec")
		}
	}
	return nil
}

type streamField struct {
	key   string
	value *string
	delta bool
}

type streamChange struct{ original, replacement string }

// cloneStreamValue 独立复制交付对象，不修改累积器或 provider 持有的池化对象。
func cloneStreamValue[T any](value *T) (*T, error) {
	if value == nil {
		return nil, nil
	}
	raw, err := schemas.MarshalSorted(value)
	if err != nil {
		return nil, errors.New("流副本无法序列化")
	}
	var out T
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, errors.New("流副本无法解析")
	}
	return &out, nil
}

// completeStreamFields 按 choice/item 身份定位文本和完整参数，不触碰用户键、工具名或媒体 URL。
func completeStreamFields(resp *schemas.BifrostResponse) []streamField {
	var fields []streamField
	if resp == nil {
		return fields
	}
	if resp.ChatResponse != nil {
		for i := range resp.ChatResponse.Choices {
			choice := &resp.ChatResponse.Choices[i]
			if choice.ChatNonStreamResponseChoice == nil || choice.Message == nil {
				continue
			}
			message := choice.Message
			key := fmt.Sprintf("chat:%d", choice.Index)
			if message.Content != nil {
				fields = append(fields, streamField{key + ":text", message.Content.ContentStr, false})
				for j := range message.Content.ContentBlocks {
					block := &message.Content.ContentBlocks[j]
					if block.Type == schemas.ChatContentBlockTypeText {
						fields = append(fields, streamField{fmt.Sprintf("%s:content:%d", key, j), block.Text, false})
					}
				}
			}
			if message.ChatAssistantMessage != nil {
				for j := range message.ToolCalls {
					fields = append(fields, streamField{fmt.Sprintf("%s:tool:%d", key, j), &message.ToolCalls[j].Function.Arguments, false})
				}
			}
		}
	}
	if resp.TextCompletionResponse != nil {
		for i := range resp.TextCompletionResponse.Choices {
			choice := &resp.TextCompletionResponse.Choices[i]
			if choice.TextCompletionResponseChoice != nil {
				fields = append(fields, streamField{fmt.Sprintf("text:%d", choice.Index), choice.Text, false})
			}
		}
	}
	if resp.ResponsesResponse != nil {
		for i := range resp.ResponsesResponse.Output {
			message := &resp.ResponsesResponse.Output[i]
			fields = append(fields, responseItemFields(message, responseItemKey(message, i))...)
		}
	}
	return fields
}

func responseItemKey(message *schemas.ResponsesMessage, index int) string {
	if message != nil && message.ID != nil && *message.ID != "" {
		return "resp:id:" + *message.ID
	}
	return fmt.Sprintf("resp:index:%d", index)
}

// responseItemFields 覆盖 item/part.done 和 completed 中的文本副本。
func responseItemFields(message *schemas.ResponsesMessage, key string) []streamField {
	var fields []streamField
	if message == nil {
		return fields
	}
	if message.Content != nil {
		fields = append(fields, streamField{key + ":text", message.Content.ContentStr, false})
		for j := range message.Content.ContentBlocks {
			block := &message.Content.ContentBlocks[j]
			if block.Type == schemas.ResponsesInputMessageContentBlockTypeText || block.Type == schemas.ResponsesOutputMessageContentTypeText {
				fields = append(fields, streamField{fmt.Sprintf("%s:content:%d", key, j), block.Text, false})
			}
		}
	}
	if message.ResponsesToolMessage != nil {
		fields = append(fields, streamField{key + ":args", message.Arguments, false})
		if message.ResponsesCustomToolCall != nil {
			fields = append(fields, streamField{key + ":custom", &message.ResponsesCustomToolCall.Input, false})
		}
	}
	return fields
}

// chunkStreamFields 只识别协议中的实际文本载体，reasoning/opaque 字段保持原样。
func chunkStreamFields(chunk *schemas.BifrostStreamChunk) []streamField {
	if chunk == nil {
		return nil
	}
	resp := &schemas.BifrostResponse{ChatResponse: chunk.BifrostChatResponse,
		TextCompletionResponse: chunk.BifrostTextCompletionResponse}
	fields := completeStreamFields(resp)
	if chunk.BifrostChatResponse != nil {
		for i := range chunk.BifrostChatResponse.Choices {
			choice := &chunk.BifrostChatResponse.Choices[i]
			if choice.ChatStreamResponseChoice == nil || choice.Delta == nil {
				continue
			}
			key := fmt.Sprintf("chat:%d", choice.Index)
			fields = append(fields, streamField{key + ":text", choice.Delta.Content, true})
			for j := range choice.Delta.ToolCalls {
				call := &choice.Delta.ToolCalls[j]
				index := int(call.Index)
				fields = append(fields, streamField{fmt.Sprintf("%s:tool:%d", key, index), &call.Function.Arguments, true})
			}
		}
	}
	if chunk.BifrostTextCompletionResponse != nil {
		for i := range fields {
			fields[i].delta = true
		}
	}
	if event := chunk.BifrostResponsesStreamResponse; event != nil {
		index := 0
		if event.OutputIndex != nil {
			index = *event.OutputIndex
		}
		key := responseItemKey(event.Item, index)
		if event.ItemID != nil && *event.ItemID != "" {
			key = "resp:id:" + *event.ItemID
		}
		content := 0
		if event.ContentIndex != nil {
			content = *event.ContentIndex
		}
		contentKey := fmt.Sprintf("%s:content:%d", key, content)
		switch string(event.Type) {
		case "response.output_text.delta":
			fields = append(fields, streamField{contentKey, event.Delta, true})
		case "response.output_text.done":
			fields = append(fields, streamField{contentKey, event.Text, false})
		case "response.function_call_arguments.delta":
			fields = append(fields, streamField{key + ":args", event.Delta, true})
		case "response.function_call_arguments.done":
			fields = append(fields, streamField{key + ":args", event.Arguments, false})
		case "response.custom_tool_call_input.delta":
			fields = append(fields, streamField{key + ":custom", event.Delta, true})
		case "response.custom_tool_call_input.done":
			fields = append(fields, streamField{key + ":custom", event.Input, false})
		}
		if event.Part != nil {
			fields = append(fields, streamField{contentKey, event.Part.Text, false})
		}
		fields = append(fields, responseItemFields(event.Item, key)...)
		if event.Response != nil {
			fields = append(fields, completeStreamFields(&schemas.BifrostResponse{ResponsesResponse: event.Response})...)
		}
	}
	return fields
}

func chunkExtra(chunk *schemas.BifrostStreamChunk) *schemas.BifrostResponseExtraFields {
	if chunk == nil {
		return nil
	}
	return (&schemas.BifrostResponse{ChatResponse: chunk.BifrostChatResponse,
		TextCompletionResponse:  chunk.BifrostTextCompletionResponse,
		ResponsesStreamResponse: chunk.BifrostResponsesStreamResponse}).GetExtraFields()
}

func rawString(value any) (string, bool) {
	switch raw := value.(type) {
	case string:
		return raw, true
	case []byte:
		return string(raw), true
	case json.RawMessage:
		return string(raw), true
	case *interface{}:
		if raw != nil {
			return rawString(*raw)
		}
	}
	return "", false
}

// Rewrite 在完整检测后事务重写扣留 delta 和在途终态；任何身份/原文不匹配均保持暂停并拒绝交付。
func (streamTextRewriter) Rewrite(ctx *schemas.BifrostContext, snapshot, terminal *schemas.BifrostResponse, rewrites []schemas.TextRewrite) (*schemas.BifrostResponse, error) {
	changed, err := cloneStreamValue(snapshot)
	if err != nil {
		return nil, err
	}
	rows, err := responseRows(changed)
	if err != nil {
		return nil, err
	}
	result := Result{Texts: rowTexts(rows)}
	seen := make(map[int]bool)
	for _, rewrite := range rewrites {
		index, err := rewriteIndex(rewrite.TargetID)
		if err != nil || index < 0 || index >= len(rows) || seen[index] || rows[index].original != rewrite.Original {
			return nil, errors.New("流文本目标无效")
		}
		seen[index] = true
		result.Texts[index] = rewrite.Replacement
	}
	if err := applyRows(rows, result); err != nil {
		return nil, err
	}
	originalFields, nextFields := completeStreamFields(snapshot), completeStreamFields(changed)
	if len(originalFields) != len(nextFields) {
		return nil, errors.New("流文本结构发生变化")
	}
	changes := make(map[string]streamChange)
	known := make(map[string]bool)
	for i, original := range originalFields {
		next := nextFields[i]
		if original.key != next.key || (original.value == nil) != (next.value == nil) {
			return nil, errors.New("流文本身份发生变化")
		}
		if original.value != nil {
			known[*original.value] = true
		}
		if original.value != nil && *original.value != *next.value {
			changes[original.key] = streamChange{*original.value, *next.value}
		}
	}
	finalCopy, err := cloneStreamValue(terminal)
	if err != nil {
		return nil, err
	}
	finalChunk := &schemas.BifrostStreamChunk{}
	if finalCopy != nil {
		finalChunk.BifrostChatResponse, finalChunk.BifrostTextCompletionResponse = finalCopy.ChatResponse, finalCopy.TextCompletionResponse
		finalChunk.BifrostResponsesStreamResponse = finalCopy.ResponsesStreamResponse
	}
	codec, _ := ctx.Value(schemas.BifrostContextKeyRawStreamTextCodec).(schemas.RawStreamTextCodec)
	err = ctx.TransformPausedStreamBuffer(func(buffered []*schemas.BifrostStreamChunk) (schemas.PausedStreamBufferTransformResult, error) {
		copies := make([]*schemas.BifrostStreamChunk, len(buffered))
		for i, chunk := range buffered {
			var copyErr error
			copies[i], copyErr = cloneStreamValue(chunk)
			if copyErr != nil {
				return schemas.PausedStreamBufferTransformResult{}, copyErr
			}
		}
		all := append(append([]*schemas.BifrostStreamChunk(nil), copies...), finalChunk)
		if err := rewriteStreamCopies(all, changes, known, codec); err != nil {
			return schemas.PausedStreamBufferTransformResult{}, err
		}
		return schemas.PausedStreamBufferTransformResult{Chunks: copies}, nil
	})
	if err != nil {
		return nil, err
	}
	return finalCopy, nil
}

// rewriteStreamCopies 按完整字段校验所有 delta 的拼接值，再一次分配替换值，跨 chunk 模式不会漏出原文。
func rewriteStreamCopies(chunks []*schemas.BifrostStreamChunk, changes map[string]streamChange, known map[string]bool, codec schemas.RawStreamTextCodec) error {
	deltas := make(map[string][]*string)
	var terminals []streamField
	type rawField struct {
		extra *schemas.BifrostResponseExtraFields
		raw   string
		event schemas.RawStreamTextEvent
	}
	rawGroups := make(map[string][]rawField)
	for _, chunk := range chunks {
		for _, field := range chunkStreamFields(chunk) {
			if field.value == nil {
				continue
			}
			if _, changed := changes[field.key]; !changed {
				continue
			}
			if field.delta {
				deltas[field.key] = append(deltas[field.key], field.value)
			} else {
				terminals = append(terminals, field)
			}
		}
		clearRedactedLogProbs(chunk, changes)
		extra := chunkExtra(chunk)
		if extra == nil || extra.RawResponse == nil {
			continue
		}
		raw, ok := rawString(extra.RawResponse)
		if !ok || codec == nil {
			return errors.New("原生流无法安全重写")
		}
		event, eligible, err := codec.Inspect(raw)
		if err != nil {
			return errors.New("原生流文本识别失败")
		}
		if eligible {
			rawGroups[event.TargetID] = append(rawGroups[event.TargetID], rawField{extra, raw, event})
		} else {
			// 未被 codec 管理的工具参数或终态文本不能按原始协议绕过重写。
			for _, path := range []string{"delta.partial_json", "content_block.text", "content_block.input", "text", "arguments", "output", "response.output", "logprobs"} {
				value := gjson.Get(raw, path)
				if value.Exists() && value.Raw != `""` && value.Raw != "{}" && value.Raw != "[]" && value.Raw != "null" {
					return errors.New("原生流包含 codec 未管理的文本载体")
				}
			}
		}
	}
	for key, values := range deltas {
		change := changes[key]
		var original strings.Builder
		for _, value := range values {
			original.WriteString(*value)
		}
		if original.String() != change.original {
			return errors.New("流 delta 与检测全文不一致")
		}
		for i, value := range values {
			*value = ""
			if i == 0 {
				*value = change.replacement
			}
		}
	}
	for _, field := range terminals {
		change := changes[field.key]
		if *field.value == "" {
			continue
		}
		if *field.value != change.original {
			return errors.New("流终态文本与检测全文不一致")
		}
		*field.value = change.replacement
	}
	for _, fields := range rawGroups {
		var original strings.Builder
		for _, field := range fields {
			original.WriteString(field.event.Text)
		}
		var match *streamChange
		for _, change := range changes {
			if change.original == original.String() {
				if match != nil && match.replacement != change.replacement {
					return errors.New("原生流文本目标歧义")
				}
				copy := change
				match = &copy
			}
		}
		if match == nil {
			if !known[original.String()] {
				return errors.New("原生流与检测文本无法精确同步")
			}
			continue
		}
		for i, field := range fields {
			text := ""
			if i == 0 {
				text = match.replacement
			}
			rewritten, err := codec.Rewrite(field.raw, text)
			if err != nil {
				return errors.New("原生流文本同步失败")
			}
			field.extra.RawResponse = rewritten
		}
	}
	for key := range changes {
		if len(deltas[key]) == 0 {
			found := false
			for _, field := range terminals {
				found = found || field.key == key
			}
			if !found {
				return errors.New("流重写未覆盖文本目标 " + strconv.Quote(key))
			}
		}
	}
	return nil
}

// clearRedactedLogProbs 清除已改写字段的原始 token 副本，避免概率载体重新泄露原文。
func clearRedactedLogProbs(chunk *schemas.BifrostStreamChunk, changes map[string]streamChange) {
	if chunk == nil {
		return
	}
	if chunk.BifrostChatResponse != nil {
		for i := range chunk.BifrostChatResponse.Choices {
			choice := &chunk.BifrostChatResponse.Choices[i]
			prefix := fmt.Sprintf("chat:%d:", choice.Index)
			for key := range changes {
				if strings.HasPrefix(key, prefix) {
					choice.LogProbs = nil
					break
				}
			}
		}
	}
	if chunk.BifrostTextCompletionResponse != nil {
		for i := range chunk.BifrostTextCompletionResponse.Choices {
			choice := &chunk.BifrostTextCompletionResponse.Choices[i]
			if _, changed := changes[fmt.Sprintf("text:%d", choice.Index)]; changed {
				choice.LogProbs = nil
			}
		}
	}
	if event := chunk.BifrostResponsesStreamResponse; event != nil {
		event.LogProbs = nil
		if event.Part != nil && event.Part.ResponsesOutputMessageContentText != nil {
			event.Part.LogProbs = nil
		}
		clearMessage := func(message *schemas.ResponsesMessage) {
			if message == nil || message.Content == nil {
				return
			}
			for i := range message.Content.ContentBlocks {
				block := &message.Content.ContentBlocks[i]
				if block.ResponsesOutputMessageContentText != nil {
					block.LogProbs = nil
				}
			}
		}
		clearMessage(event.Item)
		if event.Response != nil {
			for i := range event.Response.Output {
				clearMessage(&event.Response.Output[i])
			}
		}
	}
}
