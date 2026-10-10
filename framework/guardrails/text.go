package guardrails

import (
	"bytes"
	"encoding/json"
	"errors"
	"strconv"
	"strings"

	"github.com/maximhq/bifrost/core/schemas"
	"github.com/tidwall/gjson"
	"github.com/tidwall/sjson"
)

// syncRawRequest 复用 integration 所有的原生文本协议，不能对整份 JSON 做字符串替换。
func syncRawRequest(ctx *schemas.BifrostContext, request *schemas.BifrostRequest, result Result) error {
	var raw []byte
	switch {
	case request.ChatRequest != nil:
		raw = request.ChatRequest.RawRequestBody
	case request.ResponsesRequest != nil:
		raw = request.ResponsesRequest.RawRequestBody
	case request.TextCompletionRequest != nil:
		raw = request.TextCompletionRequest.RawRequestBody
	}
	if len(raw) == 0 {
		return errors.New("原生请求缺少可重写的原始正文")
	}
	owned := append([]byte(nil), raw...)
	var rewritten []byte
	var err error
	if len(result.RuntimeReplacements) > 0 {
		rewrite, ok := ctx.Value(schemas.BifrostContextKeyRawRequestBodyTextRewriter).(schemas.RawRequestBodyTextRewriter)
		if !ok {
			return errors.New("原生请求缺少安全脱敏同步协议")
		}
		rewritten, err = rewrite(owned, result.RuntimeReplacements)
	} else {
		transform, ok := ctx.Value(schemas.BifrostContextKeyRawRequestBodyTextTransformer).(schemas.RawRequestBodyTextTransformer)
		if !ok {
			return errors.New("原生请求缺少安全文本变换协议")
		}
		rewritten, err = transform(owned, result.Rewrites)
	}
	if err != nil || validateJSON(rewritten) != nil {
		return errors.New("原生请求文本同步失败")
	}
	request.SetRawRequestBody(rewritten)
	return nil
}

// typedArguments 保持 JSON 数字、布尔和字符串类型供 MCP CEL 使用。
func typedArguments(raw string) (map[string]any, error) {
	decoder := json.NewDecoder(bytes.NewReader([]byte(raw)))
	decoder.UseNumber()
	var args map[string]any
	if err := decoder.Decode(&args); err != nil {
		return nil, errors.New("MCP 参数无效")
	}
	var normalize func(any) (any, error)
	normalize = func(value any) (any, error) {
		switch v := value.(type) {
		case json.Number:
			if integer, err := strconv.ParseInt(string(v), 10, 64); err == nil {
				return integer, nil
			}
			number, err := strconv.ParseFloat(string(v), 64)
			if err != nil {
				return nil, errors.New("MCP 数字参数无效")
			}
			return number, nil
		case map[string]any:
			for key, child := range v {
				next, err := normalize(child)
				if err != nil {
					return nil, err
				}
				v[key] = next
			}
		case []any:
			for i, child := range v {
				next, err := normalize(child)
				if err != nil {
					return nil, err
				}
				v[i] = next
			}
		}
		return value, nil
	}
	value, err := normalize(args)
	if err != nil {
		return nil, err
	}
	return value.(map[string]any), nil
}

type textRow struct {
	original   string
	turn       int
	set        func(string) error
	role       string
	toolCallID string
}

// stringRow 捕获单个规范化文本字段，二进制、URL、工具 ID 和定义不进入检测器。
func stringRow(rows *[]textRow, value *string, turn int) {
	if value == nil {
		return
	}
	*rows = append(*rows, textRow{original: *value, turn: turn, set: func(text string) error { *value = text; return nil }})
}

// jsonRows 只选择工具参数 JSON 中的字符串值并保留非字符串及字段结构。
func jsonRows(rows *[]textRow, value *string, turn int) error {
	if value == nil || *value == "" {
		return nil
	}
	if !gjson.Valid(*value) {
		return errors.New("工具参数不是有效 JSON")
	}
	var walk func(gjson.Result, string) error
	walk = func(node gjson.Result, path string) error {
		switch {
		case node.Type == gjson.String:
			original := node.String()
			target := path
			*rows = append(*rows, textRow{original: original, turn: turn, set: func(text string) error {
				if target == "" {
					encoded, err := schemas.MarshalSorted(text)
					if err != nil {
						return errors.New("工具参数重写失败")
					}
					*value = string(encoded)
					return nil
				}
				rewritten, err := sjson.Set(*value, target, text)
				if err != nil {
					return errors.New("工具参数重写失败")
				}
				*value = rewritten
				return nil
			}})
		case node.IsObject():
			seen := make(map[string]bool)
			var err error
			node.ForEach(func(key, child gjson.Result) bool {
				if seen[key.String()] {
					err = errors.New("工具参数包含重复 JSON 字段")
					return false
				}
				seen[key.String()] = true
				escaped := strings.NewReplacer(`\`, `\\`, ".", `\.`, ":", `\:`).Replace(key.String())
				childPath := escaped
				if path != "" {
					childPath = path + "." + escaped
				}
				err = walk(child, childPath)
				return err == nil
			})
			return err
		case node.IsArray():
			var err error
			node.ForEach(func(key, child gjson.Result) bool {
				childPath := key.Raw
				if path != "" {
					childPath = path + "." + childPath
				}
				err = walk(child, childPath)
				return err == nil
			})
			return err
		}
		return nil
	}
	return walk(gjson.Parse(*value), "")
}

// chatRows 提取聊天文本及完整工具参数，不检查或重写媒体字段。
func chatRows(rows *[]textRow, message *schemas.ChatMessage, turn int) error {
	if message == nil {
		return nil
	}
	if message.Content != nil {
		start := len(*rows)
		stringRow(rows, message.Content.ContentStr, turn)
		for i := range message.Content.ContentBlocks {
			block := &message.Content.ContentBlocks[i]
			if block.Type == schemas.ChatContentBlockTypeText {
				stringRow(rows, block.Text, turn)
			}
		}
		for i := start; i < len(*rows); i++ {
			(*rows)[i].role = string(message.Role)
			if message.ChatToolMessage != nil && message.ToolCallID != nil {
				(*rows)[i].toolCallID = *message.ToolCallID
			}
		}
	}
	if message.ChatAssistantMessage != nil {
		for i := range message.ToolCalls {
			start := len(*rows)
			if err := jsonRows(rows, &message.ToolCalls[i].Function.Arguments, turn); err != nil {
				return err
			}
			for j := start; j < len(*rows); j++ {
				(*rows)[j].role = "tool"
				if message.ToolCalls[i].ID != nil {
					(*rows)[j].toolCallID = *message.ToolCalls[i].ID
				}
			}
		}
	}
	return nil
}

// responsesRows 只提取公开文本、函数参数和 custom-tool input，保留 opaque native 字段。
func responsesRows(rows *[]textRow, message *schemas.ResponsesMessage, turn int) error {
	if message == nil {
		return nil
	}
	start := len(*rows)
	if message.Content != nil {
		stringRow(rows, message.Content.ContentStr, turn)
		for i := range message.Content.ContentBlocks {
			block := &message.Content.ContentBlocks[i]
			if block.Type == schemas.ResponsesInputMessageContentBlockTypeText || block.Type == schemas.ResponsesOutputMessageContentTypeText {
				stringRow(rows, block.Text, turn)
			}
		}
	}
	if message.ResponsesToolMessage != nil {
		if message.Type != nil && *message.Type == schemas.ResponsesMessageTypeFunctionCall {
			if err := jsonRows(rows, message.Arguments, turn); err != nil {
				return err
			}
		}
		if message.ResponsesCustomToolCall != nil {
			stringRow(rows, &message.ResponsesCustomToolCall.Input, turn)
		}
		if message.Output != nil {
			stringRow(rows, message.Output.ResponsesToolCallOutputStr, turn)
			for i := range message.Output.ResponsesFunctionToolCallOutputBlocks {
				block := &message.Output.ResponsesFunctionToolCallOutputBlocks[i]
				if block.Type == schemas.ResponsesInputMessageContentBlockTypeText || block.Type == schemas.ResponsesOutputMessageContentTypeText {
					stringRow(rows, block.Text, turn)
				}
			}
		}
	}
	for i := start; i < len(*rows); i++ {
		(*rows)[i].role = "assistant"
		if message.Role != nil {
			(*rows)[i].role = string(*message.Role)
		}
		if message.ResponsesToolMessage != nil {
			(*rows)[i].role = "tool"
			if message.CallID != nil {
				(*rows)[i].toolCallID = *message.CallID
			}
		}
	}
	return nil
}

// requestRows 使用具体请求变体，不能用全请求 JSON 序列化作为检测内容。
func requestRows(request *schemas.BifrostRequest) ([]textRow, error) {
	var rows []textRow
	if request.ChatRequest != nil {
		for i := range request.ChatRequest.Input {
			if err := chatRows(&rows, &request.ChatRequest.Input[i], i); err != nil {
				return nil, err
			}
		}
	} else if request.ResponsesRequest != nil {
		if request.ResponsesRequest.Params != nil {
			stringRow(&rows, request.ResponsesRequest.Params.Instructions, 0)
		}
		for i := range request.ResponsesRequest.Input {
			if err := responsesRows(&rows, &request.ResponsesRequest.Input[i], i+1); err != nil {
				return nil, err
			}
		}
	} else if request.TextCompletionRequest != nil && request.TextCompletionRequest.Input != nil {
		input := request.TextCompletionRequest.Input
		stringRow(&rows, input.PromptStr, 0)
		for i := range input.PromptArray {
			stringRow(&rows, &input.PromptArray[i], 0)
		}
	}
	return rows, nil
}

// responseRows 提取完整结果，delta 只由流累积器在终态重组后评估。
func responseRows(response *schemas.BifrostResponse) ([]textRow, error) {
	var rows []textRow
	if response == nil {
		return rows, nil
	}
	if response.ChatResponse != nil {
		for i := range response.ChatResponse.Choices {
			choice := &response.ChatResponse.Choices[i]
			if choice.ChatNonStreamResponseChoice != nil {
				start := len(rows)
				if err := chatRows(&rows, choice.Message, 0); err != nil {
					return nil, err
				}
				onTextRewrite(rows[start:], func() { choice.LogProbs = nil })
			}
		}
	} else if response.TextCompletionResponse != nil {
		for i := range response.TextCompletionResponse.Choices {
			choice := &response.TextCompletionResponse.Choices[i]
			if choice.TextCompletionResponseChoice != nil {
				start := len(rows)
				stringRow(&rows, choice.Text, 0)
				onTextRewrite(rows[start:], func() { choice.LogProbs = nil })
			}
		}
	} else if response.ResponsesResponse != nil {
		for i := range response.ResponsesResponse.Output {
			message := &response.ResponsesResponse.Output[i]
			start := len(rows)
			if err := responsesRows(&rows, message, 0); err != nil {
				return nil, err
			}
			onTextRewrite(rows[start:], func() {
				if message.Content != nil {
					for j := range message.Content.ContentBlocks {
						block := &message.Content.ContentBlocks[j]
						if block.ResponsesOutputMessageContentText != nil {
							block.LogProbs = nil
						}
					}
				}
				if message.ResponsesToolMessage != nil && message.Output != nil {
					for j := range message.Output.ResponsesFunctionToolCallOutputBlocks {
						block := &message.Output.ResponsesFunctionToolCallOutputBlocks[j]
						if block.ResponsesOutputMessageContentText != nil {
							block.LogProbs = nil
						}
					}
				}
			})
		}
	}
	return rows, nil
}

// onTextRewrite 仅在字段实际改写成功后清除所属载体的概率副本，不影响检测或仅日志模式。
func onTextRewrite(rows []textRow, clear func()) {
	for i := range rows {
		set := rows[i].set
		if set == nil {
			continue
		}
		rows[i].set = func(text string) error {
			if err := set(text); err != nil {
				return err
			}
			clear()
			return nil
		}
	}
}

// nativeLogProbsPresent 检查原生 JSON 的概率载体；无法识别或解析时不能证明输出安全。
func nativeLogProbsPresent(raw any) (bool, error) {
	var encoded []byte
	switch value := raw.(type) {
	case string:
		encoded = []byte(value)
	case []byte:
		encoded = value
	case json.RawMessage:
		encoded = value
	default:
		var err error
		encoded, err = schemas.MarshalSorted(raw)
		if err != nil {
			return false, err
		}
	}
	if err := validateJSON(encoded); err != nil {
		return false, err
	}
	var value any
	if err := json.Unmarshal(encoded, &value); err != nil {
		return false, err
	}
	switch value.(type) {
	case map[string]any, []any:
	default:
		return false, errors.New("原生响应不是可检查的结构化载体")
	}
	var contains func(any) bool
	contains = func(node any) bool {
		switch fields := node.(type) {
		case map[string]any:
			for key, child := range fields {
				switch strings.ToLower(strings.ReplaceAll(key, "_", "")) {
				case "logprobs", "logprobsresult", "toplogprobs", "tokenlogprobs", "logprob":
					switch data := child.(type) {
					case nil:
					case []any:
						if len(data) > 0 {
							return true
						}
					case map[string]any:
						if len(data) > 0 {
							return true
						}
					case string:
						if data != "" {
							return true
						}
					default:
						return true
					}
				}
				if contains(child) {
					return true
				}
			}
		case []any:
			for _, child := range fields {
				if contains(child) {
					return true
				}
			}
		}
		return false
	}
	return contains(value), nil
}

func rowTexts(rows []textRow) []string {
	texts := make([]string, len(rows))
	for i, row := range rows {
		texts[i] = row.original
	}
	return texts
}

// requestParams 保留真实采样参数的数值类型，文本、凭据和工具定义不进入 CEL 参数域。
func requestParams(req *schemas.BifrostRequest) (map[string]any, error) {
	var params any
	switch {
	case req.ChatRequest != nil:
		params = req.ChatRequest.Params
	case req.ResponsesRequest != nil:
		params = req.ResponsesRequest.Params
	case req.TextCompletionRequest != nil:
		params = req.TextCompletionRequest.Params
	}
	result := map[string]any{"stream": strings.Contains(string(req.RequestType), "stream")}
	raw, err := schemas.MarshalSorted(params)
	if err != nil {
		return nil, errors.New("请求参数无法解析")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	var fields map[string]any
	if decoder.Decode(&fields) != nil {
		return nil, errors.New("请求参数无效")
	}
	for _, key := range []string{"temperature", "top_p", "top_k", "max_tokens", "max_completion_tokens",
		"max_output_tokens", "frequency_penalty", "presence_penalty", "seed", "n", "parallel_tool_calls",
		"store", "service_tier", "reasoning_effort"} {
		value, exists := fields[key]
		if !exists || value == nil {
			continue
		}
		switch number := value.(type) {
		case json.Number:
			if integer, err := strconv.ParseInt(string(number), 10, 64); err == nil {
				value = integer
			} else {
				value, err = strconv.ParseFloat(string(number), 64)
				if err != nil {
					return nil, errors.New("请求数值参数无效")
				}
			}
		case string, bool:
		default:
			return nil, errors.New("请求参数类型无效")
		}
		result[key] = value
	}
	return result, nil
}

// applyRows 仅提交实际变化字段，不将整个请求结构替换为脱敏 JSON。
func applyRows(rows []textRow, result Result) error {
	if len(rows) != len(result.Texts) {
		return errors.New("文本重写数量不匹配")
	}
	for i, row := range rows {
		if row.original == result.Texts[i] {
			continue
		}
		if row.set == nil {
			return errors.New("缺少安全文本重写路径")
		}
		if err := row.set(result.Texts[i]); err != nil {
			return err
		}
	}
	return nil
}
