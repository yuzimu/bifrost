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
	"strconv"
	"strings"

	bifrost "github.com/maximhq/bifrost/core"
	"github.com/maximhq/bifrost/core/providers/openai"
	"github.com/maximhq/bifrost/core/schemas"
	"github.com/valyala/fasthttp"
)

// parseOpenAIRegionEditJSON 接收选区编辑的 JSON 图片引用，数据 URI 直接解码而不额外请求网络。
func parseOpenAIRegionEditJSON(raw []byte, request *openai.OpenAIImageEditRequest) error {
	wire := struct {
		*openai.OpenAIImageEditRequest
		Prompt string               `json:"prompt"`
		Image  *schemas.ImageInput  `json:"image"`
		Images []schemas.ImageInput `json:"images"`
	}{OpenAIImageEditRequest: request}
	if err := json.Unmarshal(raw, &wire); err != nil {
		return err
	}
	if request.Input == nil {
		request.Input = &schemas.ImageEditInput{Prompt: wire.Prompt, Images: wire.Images}
		if wire.Image != nil {
			request.Input.Images = append(request.Input.Images, *wire.Image)
		}
	}
	if request.Model == "" || request.Input.Prompt == "" || len(request.Input.Images) == 0 {
		return errors.New("model, prompt and at least one image are required")
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
	if len(request.SelectionRegions) > 0 && len(request.MultiRegionEdits) > 0 {
		return errors.New("selection_regions and multi_region_edits are mutually exclusive")
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
	Model                   string            `json:"model"`
	Prompt                  string            `json:"prompt"`
	Video                   map[string]string `json:"video"`
	Seconds                 json.RawMessage   `json:"seconds"`
	Duration                json.RawMessage   `json:"duration"`
	VideoExtensionStartTime *float64          `json:"video_extension_start_time"`
	Fallbacks               []string          `json:"fallbacks,omitempty"`
	Stream                  *bool             `json:"stream,omitempty"`
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
				provider, model := schemas.ParseModelString(request.Model, "")
				if _, ok := client.GetProviderByKey(provider).(*openai.OpenAIProvider); !ok {
					return nil, errors.New("video extensions require an OpenAI-compatible provider")
				}
				extra := map[string]interface{}{"video": request.Video}
				if len(request.Duration) > 0 {
					var duration interface{}
					if err := json.Unmarshal(request.Duration, &duration); err != nil {
						return nil, err
					}
					extra["duration"] = duration
				}
				if request.VideoExtensionStartTime != nil {
					extra["video_extension_start_time"] = *request.VideoExtensionStartTime
				}
				ctx.SetValue(schemas.BifrostContextKeyURLPath, "/v1/videos/extensions")
				return &schemas.BifrostRequest{VideoGenerationRequest: &schemas.BifrostVideoGenerationRequest{
					Provider: provider, Model: model,
					Input:     &schemas.VideoGenerationInput{Prompt: request.Prompt},
					Params:    &schemas.VideoGenerationParameters{ExtraParams: extra},
					Fallbacks: schemas.ParseFallbacks(request.Fallbacks),
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

// parseOpenAIVideoExtension 接收 JSON 或表单扩展，统一 seconds 与 duration 并拒绝冲突字段。
func parseOpenAIVideoExtension(ctx *fasthttp.RequestCtx, value interface{}) error {
	request := value.(*openAIVideoExtensionRequest)
	var rawBody []byte
	if strings.HasPrefix(string(ctx.Request.Header.ContentType()), "multipart/form-data") {
		form, err := ctx.MultipartForm()
		if err != nil {
			return err
		}
		if len(form.File) > 0 {
			return errors.New("video extensions require a video reference, not an uploaded file")
		}
		fields := map[string]json.RawMessage{}
		for name, values := range form.Value {
			if len(values) != 1 {
				return fmt.Errorf("%s must occur once", name)
			}
			raw := []byte(values[0])
			switch name {
			case "video", "seconds", "duration", "video_extension_start_time", "fallbacks":
				if !json.Valid(raw) {
					return fmt.Errorf("%s must be valid JSON", name)
				}
			default:
				raw, _ = json.Marshal(values[0])
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
	if request.Model == "" || request.Prompt == "" {
		return errors.New("model and prompt are required")
	}
	if len(request.Fallbacks) > 0 {
		return errors.New("video extensions do not support fallbacks")
	}
	if request.Stream != nil && *request.Stream {
		return errors.New("video extensions do not support stream=true")
	}
	if len(request.Video) != 1 {
		return errors.New("video requires exactly one of id, url or file_id")
	}
	for field, source := range request.Video {
		if (field != "id" && field != "url" && field != "file_id") || strings.TrimSpace(source) == "" {
			return errors.New("video requires exactly one of id, url or file_id")
		}
		if field == "id" && strings.Contains(source, ":") {
			sourceProvider, rawID, err := ParseProviderScopedVideoID(source)
			provider, _ := schemas.ParseModelString(request.Model, "")
			if err != nil || sourceProvider != provider {
				return errors.New("source video provider must match model provider")
			}
			request.Video[field] = rawID
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
	if duration > 0 {
		request.Duration = json.RawMessage(strconv.Itoa(duration))
	}
	if start := request.VideoExtensionStartTime; start != nil && (*start < 0 || math.IsNaN(*start) || math.IsInf(*start, 0)) {
		return errors.New("video_extension_start_time must be a non-negative number")
	}
	return nil
}
