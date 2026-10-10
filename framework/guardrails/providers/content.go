package providers

import (
	"bytes"
	"encoding/json"
	"fmt"
	"reflect"
	"sort"
	"strings"
	"unicode/utf8"
)

// prepare 保留调用方的只读上下文，并要求每个可保护文本都有唯一、精确的消息映射。
func prepare(in Input, caps Capabilities) ([]Message, error) {
	if in.Phase != "input" && in.Phase != "output" {
		return nil, fmt.Errorf("%w: phase must be input or output", ErrInvalidInput)
	}
	hasCalls := in.HasToolCalls
	for _, m := range in.Messages {
		hasCalls = hasCalls || len(m.ToolCalls) > 0
	}
	if in.PlainText && (len(in.Tools) != 0 || hasCalls) {
		return nil, fmt.Errorf("%w: plain text cannot carry tool context", ErrInvalidInput)
	}
	if len(in.Tools) != 0 && !caps.ToolContext {
		return nil, fmt.Errorf("%w: this text adapter cannot inspect tool definitions", ErrInvalidInput)
	}
	if hasCalls && !caps.ToolContext {
		return nil, fmt.Errorf("%w: this adapter requires extracted text, not structured tool calls", ErrInvalidInput)
	}
	if in.Phase == "output" && in.Streaming {
		if caps.SkipTextOnlyOutputStream && !hasCalls {
			return nil, ErrSkipped
		}
		if !in.Complete {
			return nil, ErrUnsupportedStream
		}
	}
	if len(in.Texts) == 0 && !hasCalls {
		return nil, fmt.Errorf("%w: no content to evaluate", ErrInvalidInput)
	}
	total := 0
	account := func(text string) bool {
		if !utf8.ValidString(text) || len(text) > maxContentBytes-total {
			return false
		}
		total += len(text)
		return true
	}
	for _, text := range in.Texts {
		if !account(text) {
			return nil, fmt.Errorf("%w: invalid or oversized text", ErrInvalidInput)
		}
	}
	for _, metadata := range []string{in.Scope.Model, in.Scope.Provider, in.Scope.RequestID} {
		if len(metadata) > 4096 || !account(metadata) {
			return nil, fmt.Errorf("%w: invalid or oversized scope metadata", ErrInvalidInput)
		}
	}
	if len(in.Messages) == 0 {
		if !in.PlainText {
			return nil, fmt.Errorf("%w: chat content requires structured messages", ErrInvalidInput)
		}
		if hasCalls {
			return nil, fmt.Errorf("%w: tool calls require structured messages", ErrInvalidInput)
		}
		role := "user"
		if in.Phase == "output" {
			role = "assistant"
		}
		messages := make([]Message, len(in.Texts))
		for i, text := range in.Texts {
			index := i
			messages[i] = Message{Role: role, Content: text, TextIndex: &index}
		}
		return messages, nil
	}
	for _, tool := range in.Tools {
		if tool.Type != "function" || tool.Function.Name == "" ||
			!account(tool.Function.Name) || !account(tool.Function.Description) ||
			!account(string(tool.Function.Parameters)) ||
			(len(tool.Function.Parameters) > 0 && !validObject(tool.Function.Parameters)) {
			return nil, fmt.Errorf("%w: unsupported tool definition", ErrInvalidInput)
		}
	}
	seen := make(map[int]bool)
	for _, m := range in.Messages {
		switch m.Role {
		case "system", "developer", "user", "assistant", "tool":
		default:
			return nil, fmt.Errorf("%w: unsupported message role", ErrInvalidInput)
		}
		if !account(m.Content) {
			return nil, ErrInvalidInput
		}
		for _, tc := range m.ToolCalls {
			if tc.Type != "function" || tc.ID == "" || tc.Function.Name == "" ||
				!account(tc.ID) || !account(tc.Function.Name) || !account(tc.Function.Arguments) {
				return nil, fmt.Errorf("%w: unsupported tool call", ErrInvalidInput)
			}
		}
		if m.TextIndex == nil {
			continue
		}
		i := *m.TextIndex
		if i < 0 || i >= len(in.Texts) || seen[i] || m.Content != in.Texts[i] {
			return nil, fmt.Errorf("%w: ambiguous message-to-text mapping", ErrInvalidInput)
		}
		seen[i] = true
	}
	if len(seen) != len(in.Texts) {
		return nil, fmt.Errorf("%w: unmapped text", ErrInvalidInput)
	}
	return in.Messages, nil
}

// transformedMessages 只接受内容层面的精确变换，工具结构和历史上下文不能被静默丢弃。
func transformedMessages(in Input, original []Message, raw json.RawMessage) Result {
	block := Result{Blocked: true, Reason: "provider transformation cannot be mapped safely"}
	if !validObject(raw) {
		return block
	}
	var out struct {
		Messages []Message `json:"messages"`
		Tools    []Tool    `json:"tools,omitempty"`
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if d.Decode(&out) != nil || len(out.Messages) != len(original) ||
		!reflect.DeepEqual(out.Tools, in.Tools) {
		return block
	}
	var rewrites []Rewrite
	for i, before := range original {
		after := out.Messages[i]
		if after.Role != before.Role || after.ToolCallID != before.ToolCallID ||
			!reflect.DeepEqual(after.ToolCalls, before.ToolCalls) || !utf8.ValidString(after.Content) {
			return block
		}
		if before.Content == after.Content {
			continue
		}
		if before.TextIndex == nil {
			return block
		}
		rewrites = append(rewrites, Rewrite{Index: *before.TextIndex, Original: before.Content, Replacement: after.Content})
	}
	if len(rewrites) == 0 {
		return block
	}
	return Result{Rewrites: rewrites, Reason: "provider transformed content"}
}

// runeSpan 将厂商字符下标转换为 UTF-8 字节下标，并用返回的命中文本校验坐标单位。
func runeSpan(text string, start, end int, matched string) (int, int, bool) {
	if start < 0 || end <= start || matched == "" {
		return 0, 0, false
	}
	offsets := make([]int, 0, utf8.RuneCountInString(text)+1)
	for index := range text {
		offsets = append(offsets, index)
	}
	offsets = append(offsets, len(text))
	if end >= len(offsets) {
		return 0, 0, false
	}
	a, b := offsets[start], offsets[end]
	return a, b, text[a:b] == matched
}

// safeFindings 拒绝重叠跨度，保证父引擎可按原始文本执行一次性脱敏。
func safeFindings(findings []Finding) bool {
	sort.Slice(findings, func(i, j int) bool {
		if findings[i].TextIndex != findings[j].TextIndex {
			return findings[i].TextIndex < findings[j].TextIndex
		}
		return findings[i].Start < findings[j].Start
	})
	for i := 1; i < len(findings); i++ {
		if findings[i].TextIndex == findings[i-1].TextIndex && findings[i].Start < findings[i-1].End {
			return false
		}
	}
	return len(findings) > 0
}

// metadataHeaders 只复制已列出的非凭据元数据，防止自定义秘密头泄漏到厂商 JSON。
func metadataHeaders(headers map[string]string) map[string]string {
	out := make(map[string]string)
	for k, v := range headers {
		key := strings.ToLower(k)
		switch key {
		case "x-request-id", "x-correlation-id", "traceparent", "x-tenant-id", "x-org-id", "content-type", "content-length":
			if len(v) <= 4096 && !strings.ContainsAny(v, "\r\n") {
				out[key] = v
			}
		}
	}
	return out
}
