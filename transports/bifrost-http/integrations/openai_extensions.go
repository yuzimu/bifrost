package integrations

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"mime/multipart"
	"strconv"
	"strings"

	"github.com/google/uuid"
	bifrost "github.com/maximhq/bifrost/core"
	"github.com/maximhq/bifrost/core/providers/openai"
	"github.com/maximhq/bifrost/core/schemas"
	"github.com/maximhq/bifrost/framework/grant"
	"github.com/valyala/fasthttp"
)

// parseOpenAIRegionEditJSON 接收选区编辑的 JSON 图片引用，数据 URI 直接解码而不额外请求网络。
func parseOpenAIRegionEditJSON(raw []byte, request *openai.OpenAIImageEditRequest, allowExtra bool) error {
	wire := struct {
		*openai.OpenAIImageEditRequest
		Prompt      string                 `json:"prompt"`
		Image       *schemas.ImageInput    `json:"image"`
		Images      []schemas.ImageInput   `json:"images"`
		ExtraParams map[string]interface{} `json:"extra_params"`
	}{OpenAIImageEditRequest: request}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&wire); err != nil {
		return err
	}
	if err := decoder.Decode(new(interface{})); err != io.EOF {
		return errors.New("expected a single JSON object")
	}
	if len(wire.ExtraParams) > 0 {
		if !allowExtra {
			return errors.New("extra_params requires x-bf-passthrough-extra-params: true")
		}
		request.SetExtraParams(wire.ExtraParams)
	}
	if request.Input == nil {
		request.Input = &schemas.ImageEditInput{Prompt: wire.Prompt, Images: wire.Images}
		if wire.Image != nil {
			request.Input.Images = append(request.Input.Images, *wire.Image)
		}
	}
	if request.Model == "" || len(request.Input.Images) == 0 {
		return errors.New("model and at least one image are required")
	}
	for index := range request.Input.Images {
		image := &request.Input.Images[index]
		if strings.HasPrefix(image.URL, "data:") {
			_, encoded, found := strings.Cut(image.URL, ";base64,")
			if !found {
				return errors.New("image data URI must contain base64")
			}
			data, err := base64.StdEncoding.DecodeString(encoded)
			if err != nil {
				return err
			}
			image.Image, image.URL = data, ""
		}
		if image.URL != "" && len(request.SelectionRegions) == 0 && len(request.MultiRegionEdits) == 0 {
			return errors.New("JSON image URLs require selection_regions or multi_region_edits")
		}
	}
	return validateOpenAIRegionEdit(request)
}

type openAIImageSelectionRegion struct {
	Outer struct {
		Points []float64 `json:"points"`
	} `json:"outer"`
}

// validateOpenAIRegionEdit 合并各组提示词，拒绝上游不支持的孔洞和未知选区字段。
func validateOpenAIRegionEdit(request *openai.OpenAIImageEditRequest) error {
	if len(request.SelectionRegions) > 0 && len(request.MultiRegionEdits) > 0 {
		return errors.New("selection_regions and multi_region_edits are mutually exclusive")
	}
	if len(request.MultiRegionEdits) > 0 {
		var edits []struct {
			Prompt          string                       `json:"prompt"`
			Regions         []openAIImageSelectionRegion `json:"regions"`
			ReferenceImages []schemas.ImageInput         `json:"reference_images"`
		}
		decoder := json.NewDecoder(bytes.NewReader(request.MultiRegionEdits))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&edits); err != nil {
			return err
		}
		var prompts []string
		for _, edit := range edits {
			if len(edit.Regions) == 0 || len(edit.Regions) > 8 {
				return errors.New("each multi_region_edits entry requires 1 to 8 regions")
			}
			prompt := strings.TrimSpace(edit.Prompt)
			if prompt == "" {
				prompt = strings.TrimSpace(request.Input.Prompt)
			}
			if prompt == "" {
				return errors.New("each multi_region_edits entry requires a prompt")
			}
			prompts = append(prompts, prompt)
		}
		if strings.TrimSpace(request.Input.Prompt) == "" {
			request.Input.Prompt = strings.Join(prompts, "; ")
		}
	}
	if len(request.SelectionRegions) > 0 {
		var regions []openAIImageSelectionRegion
		decoder := json.NewDecoder(bytes.NewReader(request.SelectionRegions))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&regions); err != nil {
			return err
		}
	}
	if strings.TrimSpace(request.Input.Prompt) == "" {
		return errors.New("prompt is required")
	}
	for _, field := range []json.RawMessage{request.SelectionRegions, request.MultiRegionEdits} {
		if len(field) == 0 {
			continue
		}
		var items []json.RawMessage
		if err := json.Unmarshal(field, &items); err != nil || len(items) == 0 || len(items) > 8 {
			return errors.New("region edits must contain 1 to 8 entries")
		}
	}
	if request.Stream != nil && *request.Stream && (len(request.SelectionRegions) > 0 || len(request.MultiRegionEdits) > 0) {
		return errors.New("region edits do not support stream=true")
	}
	return nil
}

type openAIVideoExtensionRequest struct {
	Model  string `json:"model"`
	Prompt string `json:"prompt"`
	Video  struct {
		openai.OpenAIVideoEditVideoInput
		URL    string `json:"url,omitempty"`
		FileID string `json:"file_id,omitempty"`
	} `json:"video"`
	Seconds                 json.RawMessage       `json:"seconds"`
	Duration                json.RawMessage       `json:"duration"`
	VideoExtensionStartTime *float64              `json:"video_extension_start_time"`
	Fallbacks               []string              `json:"fallbacks,omitempty"`
	Stream                  *bool                 `json:"stream,omitempty"`
	Provider                schemas.ModelProvider `json:"-"`
}

// openAIVideoExtensionRoutes 复用视频生成鉴权和任务生命周期，仅固定延长操作的上游路径。
func openAIVideoExtensionRoutes(prefix string, client *bifrost.Bifrost) []RouteConfig {
	var routes []RouteConfig
	for _, path := range []string{"/v1/videos/extensions", "/videos/extensions"} {
		routes = append(routes, RouteConfig{
			Type: RouteConfigTypeOpenAI, Path: prefix + path, Method: fasthttp.MethodPost,
			GetHTTPRequestType: func(*fasthttp.RequestCtx) schemas.RequestType {
				return schemas.VideoGenerationRequest
			},
			GetRequestTypeInstance: func(context.Context) interface{} { return &openAIVideoExtensionRequest{} },
			RequestParser:          parseOpenAIVideoExtension,
			RequestConverter: func(ctx *schemas.BifrostContext, value interface{}) (*schemas.BifrostRequest, error) {
				request := value.(*openAIVideoExtensionRequest)
				if ctx.Value(schemas.BifrostContextKeyDirectKey) != nil {
					return nil, &bifrostConverterError{bifrostError: newBifrostErrorWithCode(
						nil, "video extensions do not support direct keys", fasthttp.StatusForbidden)}
				}
				provider, model := schemas.ParseModelString(request.Model, request.Provider)
				if _, ok := client.GetProviderByKey(provider).(*openai.OpenAIProvider); !ok {
					return nil, errors.New("video extensions require an OpenAI-compatible provider")
				}
				binding := &schemas.VideoExtensionSourceBinding{Provider: provider, Model: model}
				if request.Video.ID != "" {
					var err error
					binding, err = resolveOpenAIExtensionSource(ctx, client, provider, model, request.Video.ID)
					if err != nil {
						return nil, err
					}
					model = binding.Model
				}
				if model == "" {
					return nil, &bifrostConverterError{bifrostError: newBifrostErrorWithCode(
						nil, "model required on gateway for uploaded sources", fasthttp.StatusBadRequest)}
				}
				extension := &schemas.VideoExtensionInput{Video: schemas.VideoInput{
					ID: request.Video.ID, URL: request.Video.URL, FileID: request.Video.FileID, Video: request.Video.Bytes,
				}}
				params := &schemas.VideoGenerationParameters{}
				if len(request.Duration) > 0 {
					var duration int
					if err := json.Unmarshal(request.Duration, &duration); err != nil {
						return nil, err
					}
					extension.Duration = &duration
				}
				if len(request.Seconds) > 0 {
					var seconds string
					if err := json.Unmarshal(request.Seconds, &seconds); err != nil {
						return nil, err
					}
					params.Seconds = &seconds
				}
				extension.VideoExtensionStartTime = request.VideoExtensionStartTime
				ctx.SetValue(schemas.BifrostContextKeyURLPath, "/v1/videos/extensions")
				return &schemas.BifrostRequest{VideoGenerationRequest: &schemas.BifrostVideoGenerationRequest{
					Provider: provider, Model: model,
					Input:         &schemas.VideoGenerationInput{Prompt: request.Prompt, Extension: extension},
					Params:        params,
					SourceBinding: binding,
					Fallbacks:     schemas.ParseFallbacks(request.Fallbacks),
				}}, nil
			},
			VideoGenerationResponseConverter: func(_ *schemas.BifrostContext, response *schemas.BifrostVideoGenerationResponse) (interface{}, error) {
				return openAIWireCostResponse(response), nil
			},
			ErrorConverter: func(_ *schemas.BifrostContext, err *schemas.BifrostError) interface{} { return err },
		})
	}
	return routes
}

// resolveOpenAIExtensionSource 经正式读取鉴权核对源任务，隔离 trace 与限额并固定生成账号。
func resolveOpenAIExtensionSource(ctx *schemas.BifrostContext, client *bifrost.Bifrost, provider schemas.ModelProvider, model, sourceID string) (*schemas.VideoExtensionSourceBinding, error) {
	if ctx.Value(schemas.BifrostContextKeyDirectKey) != nil {
		return nil, &bifrostConverterError{bifrostError: newBifrostErrorWithCode(
			nil, "video extensions do not support direct keys", fasthttp.StatusForbidden)}
	}
	sourceCtx := schemas.NewBifrostContext(ctx, schemas.NoDeadline)
	defer sourceCtx.Cancel()
	if parentGrant := ctx.Grant(); parentGrant != nil {
		sourceGrant := grant.New()
		sourceGrant.SetIdentity(parentGrant.Identity())
		sourceGrant.SetAccess(parentGrant.Access())
		sourceCtx.SetGrant(sourceGrant)
	}
	for _, key := range []schemas.BifrostContextKey{
		schemas.BifrostContextKeyURLPath, schemas.BifrostContextKeyTraceID,
		schemas.BifrostContextKeyExportTraceID, schemas.BifrostContextKeySpanID,
		schemas.BifrostContextKeyParentSpanID, schemas.BifrostContextKeyTraceCompleter,
		schemas.BifrostContextKeySelectedKeyID, schemas.BifrostContextKeySelectedKeyName,
		schemas.BifrostContextKeyFallbackRequestID, schemas.BifrostContextKeyAttemptTrail,
	} {
		sourceCtx.SetValue(key, nil)
	}
	sourceCtx.SetValue(schemas.BifrostContextKeyParentRequestID, ctx.Value(schemas.BifrostContextKeyRequestID))
	sourceCtx.SetValue(schemas.BifrostContextKeyRequestID, uuid.NewString())
	sourceCtx.SetValue(schemas.BifrostContextKeyBillingNonce, uuid.NewString())
	sourceCtx.SetValue(schemas.BifrostContextKeyHTTPRequestType, schemas.VideoRetrieveRequest)
	sourceCtx.SetValue(schemas.BifrostContextKeyVideoOutputRequested, false)
	sourceCtx.SetValue(schemas.BifrostContextKeyUseRawRequestBody, false)
	sourceCtx.SetValue(schemas.BifrostContextKeyDeferTraceCompletion, false)
	source, sourceErr := client.VideoRetrieveRequest(sourceCtx, &schemas.BifrostVideoRetrieveRequest{
		Provider: provider, ID: sourceID,
	})
	if sourceErr != nil {
		return nil, &bifrostConverterError{bifrostError: sourceErr}
	}
	badRequest := func(message string) (*schemas.VideoExtensionSourceBinding, error) {
		return nil, &bifrostConverterError{bifrostError: newBifrostErrorWithCode(nil, message, fasthttp.StatusBadRequest)}
	}
	if source == nil {
		return badRequest("source video metadata is unavailable")
	}
	sourceProvider, returnedID, err := ParseProviderScopedVideoID(source.ID)
	if err != nil || sourceProvider != provider || returnedID != sourceID ||
		source.ExtraFields.Provider != provider || source.Status != schemas.VideoStatusCompleted {
		return badRequest("source video must match the requested provider and id and be completed")
	}
	sourceModel := strings.TrimSpace(source.Model)
	if sourceModel == "" {
		return badRequest("model required on gateway for uploaded sources")
	}
	modelProvider, sourceModel := schemas.ParseModelString(sourceModel, provider)
	if modelProvider != provider || sourceModel == "" {
		return badRequest("source video model must belong to the requested provider")
	}
	if model != "" && model != sourceModel {
		return badRequest("model must match the source video model")
	}
	keyID, _ := sourceCtx.Value(schemas.BifrostContextKeySelectedKeyID).(string)
	if keyID == "" {
		return badRequest("source video retrieval requires a registered provider key")
	}
	ctx.SetValue(schemas.BifrostContextKeyAPIKeyID, keyID)
	return &schemas.VideoExtensionSourceBinding{Provider: provider, Model: sourceModel, KeyID: keyID}, nil
}

// parseOpenAIVideoExtension 解析 SDK 文件及引用结构，按提供方保留 seconds 或 Grok duration。
func parseOpenAIVideoExtension(ctx *fasthttp.RequestCtx, value interface{}) error {
	request := value.(*openAIVideoExtensionRequest)
	var rawBody []byte
	var sourceFile *multipart.FileHeader
	if strings.HasPrefix(string(ctx.Request.Header.ContentType()), "multipart/form-data") {
		form, err := ctx.MultipartForm()
		if err != nil {
			return err
		}
		for name, files := range form.File {
			if name != "video" || len(files) != 1 {
				return errors.New("only one video file is supported")
			}
			sourceFile = files[0]
		}
		fields := map[string]json.RawMessage{}
		for name, values := range form.Value {
			if len(values) != 1 {
				return fmt.Errorf("%s must occur once", name)
			}
			raw := []byte(values[0])
			switch name {
			case "video[id]":
				if _, exists := fields["video"]; exists {
					return errors.New("video and video[id] cannot be combined")
				}
				raw, _ = json.Marshal(map[string]string{"id": values[0]})
				name = "video"
			case "video", "duration", "video_extension_start_time", "fallbacks", "stream":
				if !json.Valid(raw) {
					return fmt.Errorf("%s must be valid JSON", name)
				}
			default:
				raw, _ = json.Marshal(values[0])
			}
			if _, exists := fields[name]; exists {
				return fmt.Errorf("%s must occur once", name)
			}
			fields[name] = raw
		}
		raw, err := json.Marshal(fields)
		if err != nil {
			return err
		}
		rawBody = raw
	} else if strings.HasPrefix(string(ctx.Request.Header.ContentType()), "application/json") {
		rawBody = ctx.Request.Body()
	} else {
		return errors.New("expected application/json or multipart/form-data")
	}
	decoder := json.NewDecoder(bytes.NewReader(rawBody))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(request); err != nil {
		return err
	}
	if err := decoder.Decode(new(interface{})); err != io.EOF {
		return errors.New("expected a single JSON object")
	}
	request.Model = strings.TrimSpace(request.Model)
	request.Prompt = strings.TrimSpace(request.Prompt)
	if request.Prompt == "" {
		return errors.New("prompt is required")
	}
	if len(request.Fallbacks) > 0 {
		return errors.New("video extensions do not support fallbacks")
	}
	if request.Stream != nil && *request.Stream {
		return errors.New("video extensions do not support stream=true")
	}
	sourceCount := 0
	for _, source := range []string{request.Video.ID, request.Video.URL, request.Video.FileID} {
		if strings.TrimSpace(source) != "" {
			sourceCount++
		}
	}
	if sourceFile != nil {
		sourceCount++
	}
	if sourceCount != 1 {
		return errors.New("exactly one video file, id, url or file_id is required")
	}
	request.Provider = resolveOpenAIVideoEditProvider(ctx, request.Video.ID)
	if request.Provider == "" {
		request.Provider = schemas.OpenAI
	}
	provider, _ := schemas.ParseModelString(request.Model, request.Provider)
	if source := request.Video.ID; strings.Contains(source, ":") {
		sourceProvider, rawID, err := ParseProviderScopedVideoID(source)
		if err != nil || sourceProvider != provider {
			return errors.New("source video provider must match target provider")
		}
		request.Video.ID = rawID
	}
	grok := provider == schemas.ModelProvider("grok2api")
	if grok && (request.Model == "" || sourceFile != nil) {
		return errors.New("grok2api extensions require model and do not support uploaded video files")
	}
	if sourceFile != nil && request.Model == "" {
		return errors.New("model required on gateway for uploaded sources")
	}
	if !grok {
		if len(request.Duration) > 0 || request.VideoExtensionStartTime != nil || request.Video.URL != "" || request.Video.FileID != "" {
			return errors.New("OpenAI extensions accept seconds and a video file or id; Grok parameters are not supported")
		}
		if len(request.Seconds) == 0 {
			return errors.New("seconds is required for OpenAI extensions")
		}
	}
	duration := 0
	for _, raw := range []json.RawMessage{request.Duration, request.Seconds} {
		if len(raw) == 0 {
			continue
		}
		var text string
		if err := json.Unmarshal(raw, &text); err != nil {
			text = string(raw)
		}
		n, err := strconv.Atoi(text)
		if err != nil || n < 1 {
			return errors.New("duration and seconds must be positive integers")
		}
		if duration != 0 && duration != n {
			return errors.New("duration and seconds must agree")
		}
		duration = n
	}
	if grok && duration > 0 {
		request.Duration = json.RawMessage(strconv.Itoa(duration))
		request.Seconds = nil
	} else if !grok {
		switch duration {
		case 4, 8, 12, 16, 20:
		default:
			return errors.New("OpenAI extension seconds must be 4, 8, 12, 16 or 20")
		}
		request.Seconds = json.RawMessage(strconv.Quote(strconv.Itoa(duration)))
	}
	if sourceFile != nil {
		file, err := sourceFile.Open()
		if err != nil {
			return err
		}
		defer file.Close()
		request.Video.Bytes, err = io.ReadAll(file)
		if err != nil {
			return err
		}
		if len(request.Video.Bytes) == 0 {
			return errors.New("video file must not be empty")
		}
	}
	if start := request.VideoExtensionStartTime; start != nil && (*start < 0 || math.IsNaN(*start) || math.IsInf(*start, 0)) {
		return errors.New("video_extension_start_time must be a non-negative number")
	}
	return nil
}
