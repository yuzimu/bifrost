package openai

import (
	"fmt"
	"mime/multipart"
	"net/http"
	"strconv"

	providerUtils "github.com/maximhq/bifrost/core/providers/utils"
	"github.com/maximhq/bifrost/core/schemas"
)

// encodeRegionImageEdit 保留选区及参考图信息，避免 JSON 扩展被标准表单转换丢弃。
func encodeRegionImageEdit(ctx *schemas.BifrostContext, request *OpenAIImageEditRequest) ([]byte, error) {
	images := make([]map[string]string, 0, len(request.Input.Images))
	for _, image := range request.Input.Images {
		source := image.URL
		if len(image.Image) > 0 {
			source = providerUtils.FileBytesToBase64DataURL(image.Image)
		}
		if source == "" {
			return nil, fmt.Errorf("image must contain bytes or a URL")
		}
		images = append(images, map[string]string{"url": source})
	}
	body, err := providerUtils.MarshalSorted(struct {
		Model  string              `json:"model"`
		Prompt string              `json:"prompt"`
		Images []map[string]string `json:"images"`
		schemas.ImageEditParameters
	}{
		Model: request.Model, Prompt: request.Input.Prompt, Images: images,
		ImageEditParameters: request.ImageEditParameters,
	})
	if err != nil {
		return nil, err
	}
	if ctx.Value(schemas.BifrostContextKeyPassthroughExtraParams) == true {
		for name := range request.ExtraParams {
			if name == "input" || name == "image" || name == "stream" || name == "fallbacks" ||
				name == "selection_regions" || name == "multi_region_edits" || name == "mask" || providerUtils.JSONFieldExists(body, name) {
				return nil, fmt.Errorf("extra_params.%s conflicts with an image edit field", name)
			}
		}
		return providerUtils.MergeExtraParamsIntoJSON(body, request.ExtraParams)
	}
	return body, nil
}

// ToOpenAIImageGenerationRequest converts a Bifrost Image Request to OpenAI format
func ToOpenAIImageGenerationRequest(bifrostReq *schemas.BifrostImageGenerationRequest) *OpenAIImageGenerationRequest {
	if bifrostReq == nil || bifrostReq.Input == nil || bifrostReq.Input.Prompt == "" {
		return nil
	}

	req := &OpenAIImageGenerationRequest{
		Model:  bifrostReq.Model,
		Prompt: bifrostReq.Input.Prompt,
	}

	if bifrostReq.Params != nil {
		req.ImageGenerationParameters = *bifrostReq.Params
	}

	switch bifrostReq.Provider {
	case schemas.XAI:
		filterXAISpecificParameters(req)
	case schemas.OpenAI, schemas.Azure:
		filterOpenAISpecificParameters(req)
	}
	if bifrostReq.Params != nil {
		req.ExtraParams = bifrostReq.Params.ExtraParams
	}
	return req
}

func filterXAISpecificParameters(req *OpenAIImageGenerationRequest) {
	req.ImageGenerationParameters.Quality = nil
	req.ImageGenerationParameters.Style = nil
	req.ImageGenerationParameters.Size = nil
	req.ImageGenerationParameters.OutputCompression = nil
}

func filterOpenAISpecificParameters(req *OpenAIImageGenerationRequest) {
	req.ImageGenerationParameters.Seed = nil
	req.NumInferenceSteps = nil
	req.NegativePrompt = nil
}

// ToBifrostImageGenerationRequest converts an OpenAI image generation request to Bifrost format
func (request *OpenAIImageGenerationRequest) ToBifrostImageGenerationRequest(ctx *schemas.BifrostContext) *schemas.BifrostImageGenerationRequest {
	if request == nil {
		return nil
	}

	provider, model := schemas.ParseModelString(request.Model, "")

	return &schemas.BifrostImageGenerationRequest{
		Provider: provider,
		Model:    model,
		Input: &schemas.ImageGenerationInput{
			Prompt: request.Prompt,
		},
		Params:    &request.ImageGenerationParameters,
		Fallbacks: schemas.ParseFallbacks(request.Fallbacks),
	}
}

func (request *OpenAIImageEditRequest) ToBifrostImageEditRequest(ctx *schemas.BifrostContext) *schemas.BifrostImageEditRequest {
	if request == nil {
		return nil
	}

	provider, model := schemas.ParseModelString(request.Model, "")

	return &schemas.BifrostImageEditRequest{
		Provider:  provider,
		Model:     model,
		Input:     request.Input,
		Params:    &request.ImageEditParameters,
		Fallbacks: schemas.ParseFallbacks(request.Fallbacks),
	}
}

func (request *OpenAIImageVariationRequest) ToBifrostImageVariationRequest(ctx *schemas.BifrostContext) *schemas.BifrostImageVariationRequest {
	if request == nil {
		return nil
	}

	provider, model := schemas.ParseModelString(request.Model, "")

	return &schemas.BifrostImageVariationRequest{
		Provider:  provider,
		Model:     model,
		Input:     request.Input,
		Params:    &request.ImageVariationParameters,
		Fallbacks: schemas.ParseFallbacks(request.Fallbacks),
	}
}

func ToOpenAIImageEditRequest(bifrostReq *schemas.BifrostImageEditRequest) *OpenAIImageEditRequest {
	if bifrostReq == nil || bifrostReq.Input == nil || bifrostReq.Input.Images == nil || bifrostReq.Input.Prompt == "" {
		return nil
	}

	req := &OpenAIImageEditRequest{
		Model: bifrostReq.Model,
		Input: bifrostReq.Input,
	}

	if bifrostReq.Params != nil {
		req.ImageEditParameters = *bifrostReq.Params
	}

	if bifrostReq.Params != nil {
		req.ExtraParams = bifrostReq.Params.ExtraParams
	}

	return req
}

// parseImageEditFormDataBodyFromRequest 保留标准编辑字段并透传显式选区扩展。
func parseImageEditFormDataBodyFromRequest(writer *multipart.Writer, openaiReq *OpenAIImageEditRequest, providerName schemas.ModelProvider, contexts ...*schemas.BifrostContext) *schemas.BifrostError {
	// Add model field (required)
	if err := writer.WriteField("model", openaiReq.Model); err != nil {
		return providerUtils.NewBifrostOperationError("failed to write model field", err)
	}

	// Add prompt field (required)
	if err := writer.WriteField("prompt", openaiReq.Input.Prompt); err != nil {
		return providerUtils.NewBifrostOperationError("failed to write prompt field", err)
	}
	for _, field := range []struct {
		name  string
		value []byte
	}{
		{"selection_regions", openaiReq.SelectionRegions},
		{"multi_region_edits", openaiReq.MultiRegionEdits},
	} {
		if len(field.value) > 0 {
			if err := writer.WriteField(field.name, string(field.value)); err != nil {
				return providerUtils.NewBifrostOperationError("failed to write "+field.name, err)
			}
		}
	}

	// Add stream field when requesting streaming
	if openaiReq.Stream != nil && *openaiReq.Stream {
		if err := writer.WriteField("stream", "true"); err != nil {
			return providerUtils.NewBifrostOperationError("failed to write stream field", err)
		}
	}

	// Add optional parameters before file parts so routing metadata arrives first upstream.
	if openaiReq.N != nil {
		if err := writer.WriteField("n", strconv.Itoa(*openaiReq.N)); err != nil {
			return providerUtils.NewBifrostOperationError("failed to write n field", err)
		}
	}

	if openaiReq.Size != nil {
		if err := writer.WriteField("size", *openaiReq.Size); err != nil {
			return providerUtils.NewBifrostOperationError("failed to write size field", err)
		}
	}

	if openaiReq.ResponseFormat != nil {
		if err := writer.WriteField("response_format", *openaiReq.ResponseFormat); err != nil {
			return providerUtils.NewBifrostOperationError("failed to write response_format field", err)
		}
	}

	if openaiReq.Quality != nil {
		if err := writer.WriteField("quality", *openaiReq.Quality); err != nil {
			return providerUtils.NewBifrostOperationError("failed to write quality field", err)
		}
	}

	if openaiReq.Background != nil {
		if err := writer.WriteField("background", *openaiReq.Background); err != nil {
			return providerUtils.NewBifrostOperationError("failed to write background field", err)
		}
	}

	if openaiReq.InputFidelity != nil {
		if err := writer.WriteField("input_fidelity", *openaiReq.InputFidelity); err != nil {
			return providerUtils.NewBifrostOperationError("failed to write input_fidelity field", err)
		}
	}

	if openaiReq.PartialImages != nil {
		if err := writer.WriteField("partial_images", strconv.Itoa(*openaiReq.PartialImages)); err != nil {
			return providerUtils.NewBifrostOperationError("failed to write partial_images field", err)
		}
	}

	if openaiReq.OutputFormat != nil {
		if err := writer.WriteField("output_format", *openaiReq.OutputFormat); err != nil {
			return providerUtils.NewBifrostOperationError("failed to write output_format field", err)
		}
	}

	if openaiReq.OutputCompression != nil {
		if err := writer.WriteField("output_compression", strconv.Itoa(*openaiReq.OutputCompression)); err != nil {
			return providerUtils.NewBifrostOperationError("failed to write output_compression field", err)
		}
	}

	if openaiReq.User != nil {
		if err := writer.WriteField("user", *openaiReq.User); err != nil {
			return providerUtils.NewBifrostOperationError("failed to write user field", err)
		}
	}
	if openaiReq.Resolution != nil {
		if err := writer.WriteField("resolution", *openaiReq.Resolution); err != nil {
			return providerUtils.NewBifrostOperationError("failed to write resolution", err)
		}
	}
	if openaiReq.AspectRatio != nil {
		if err := writer.WriteField("aspect_ratio", *openaiReq.AspectRatio); err != nil {
			return providerUtils.NewBifrostOperationError("failed to write aspect_ratio", err)
		}
	}
	if len(openaiReq.StorageOptions) > 0 {
		if err := writer.WriteField("storage_options", string(openaiReq.StorageOptions)); err != nil {
			return providerUtils.NewBifrostOperationError("failed to write storage_options", err)
		}
	}
	if len(contexts) > 0 && contexts[0].Value(schemas.BifrostContextKeyPassthroughExtraParams) == true {
		if _, err := encodeRegionImageEdit(contexts[0], openaiReq); err != nil {
			return providerUtils.NewBifrostOperationError("invalid image edit extra_params", err)
		}
		for name, value := range openaiReq.ExtraParams {
			text, ok := value.(string)
			if !ok {
				raw, err := providerUtils.MarshalSorted(value)
				if err != nil {
					return providerUtils.NewBifrostOperationError("invalid extra_params."+name, err)
				}
				text = string(raw)
			}
			if err := writer.WriteField(name, text); err != nil {
				return providerUtils.NewBifrostOperationError("failed to write "+name, err)
			}
		}
	}

	// Add image[] fields (one for each image)
	for i, imageInput := range openaiReq.Input.Images {
		fieldName := "image[]"

		// Detect and validate MIME type
		mimeType := http.DetectContentType(imageInput.Image)
		// Fallback to PNG if content type is undetectable or generic
		if mimeType == "" || mimeType == "application/octet-stream" {
			mimeType = "image/png"
		}

		// Determine filename based on MIME type
		var filename string
		switch mimeType {
		case "image/jpeg":
			filename = fmt.Sprintf("image%d.jpg", i)
		case "image/webp":
			filename = fmt.Sprintf("image%d.webp", i)
		default:
			filename = fmt.Sprintf("image%d.png", i)
		}

		// Create form part with proper Content-Type header (not CreateFormFile which defaults to application/octet-stream)
		part, err := writer.CreatePart(map[string][]string{
			"Content-Disposition": {fmt.Sprintf(`form-data; name="%s"; filename="%s"`, fieldName, filename)},
			"Content-Type":        {mimeType},
		})
		if err != nil {
			return providerUtils.NewBifrostOperationError(fmt.Sprintf("failed to create form part for image %d", i), err)
		}
		if _, err := part.Write(imageInput.Image); err != nil {
			return providerUtils.NewBifrostOperationError(fmt.Sprintf("failed to write image %d data", i), err)
		}
	}

	// Add mask if present
	if len(openaiReq.Mask) > 0 {
		// Detect MIME type for mask
		maskMimeType := http.DetectContentType(openaiReq.Mask)
		if maskMimeType != "image/png" && maskMimeType != "image/jpeg" && maskMimeType != "image/webp" {
			maskMimeType = "image/png"
		}

		var maskFilename string
		switch maskMimeType {
		case "image/jpeg":
			maskFilename = "mask.jpg"
		case "image/webp":
			maskFilename = "mask.webp"
		default:
			maskFilename = "mask.png"
		}

		// Create form part with proper Content-Type header
		maskPart, err := writer.CreatePart(map[string][]string{
			"Content-Disposition": {`form-data; name="mask"; filename="` + maskFilename + `"`},
			"Content-Type":        {maskMimeType},
		})
		if err != nil {
			return providerUtils.NewBifrostOperationError("failed to create mask form part", err)
		}
		if _, err := maskPart.Write(openaiReq.Mask); err != nil {
			return providerUtils.NewBifrostOperationError("failed to write mask data", err)
		}
	}

	// Close the multipart writer
	if err := writer.Close(); err != nil {
		return providerUtils.NewBifrostOperationError("failed to close multipart writer", err)
	}

	return nil
}

func ToOpenAIImageVariationRequest(bifrostReq *schemas.BifrostImageVariationRequest) *OpenAIImageVariationRequest {
	if bifrostReq == nil || bifrostReq.Input == nil || bifrostReq.Input.Image.Image == nil || len(bifrostReq.Input.Image.Image) == 0 {
		return nil
	}

	req := &OpenAIImageVariationRequest{
		Model: bifrostReq.Model,
		Input: bifrostReq.Input,
	}

	if bifrostReq.Params != nil {
		req.ImageVariationParameters = *bifrostReq.Params
	}

	if bifrostReq.Params != nil {
		req.ExtraParams = bifrostReq.Params.ExtraParams
	}

	return req
}

func parseImageVariationFormDataBodyFromRequest(writer *multipart.Writer, openaiReq *OpenAIImageVariationRequest, providerName schemas.ModelProvider) *schemas.BifrostError {
	// Add model field (required)
	if err := writer.WriteField("model", openaiReq.Model); err != nil {
		return providerUtils.NewBifrostOperationError("failed to write model field", err)
	}

	// Add image file (required)
	if openaiReq.Input == nil || openaiReq.Input.Image.Image == nil || len(openaiReq.Input.Image.Image) == 0 {
		return providerUtils.NewBifrostOperationError("image is required", nil)
	}

	// Add optional parameters before the image part so metadata arrives first upstream.
	if openaiReq.N != nil {
		if err := writer.WriteField("n", strconv.Itoa(*openaiReq.N)); err != nil {
			return providerUtils.NewBifrostOperationError("failed to write n field", err)
		}
	}

	if openaiReq.ResponseFormat != nil {
		if err := writer.WriteField("response_format", *openaiReq.ResponseFormat); err != nil {
			return providerUtils.NewBifrostOperationError("failed to write response_format field", err)
		}
	}

	if openaiReq.Size != nil {
		if err := writer.WriteField("size", *openaiReq.Size); err != nil {
			return providerUtils.NewBifrostOperationError("failed to write size field", err)
		}
	}

	if openaiReq.User != nil {
		if err := writer.WriteField("user", *openaiReq.User); err != nil {
			return providerUtils.NewBifrostOperationError("failed to write user field", err)
		}
	}

	// Detect MIME type
	mimeType := http.DetectContentType(openaiReq.Input.Image.Image)
	// If still not detected, default to PNG
	if mimeType == "application/octet-stream" || mimeType == "" {
		mimeType = "image/png"
	}

	filename := "image"
	part, err := writer.CreatePart(map[string][]string{
		"Content-Disposition": {fmt.Sprintf(`form-data; name="image"; filename="%s"`, filename)},
		"Content-Type":        {mimeType},
	})
	if err != nil {
		return providerUtils.NewBifrostOperationError("failed to create image part", err)
	}

	if _, err := part.Write(openaiReq.Input.Image.Image); err != nil {
		return providerUtils.NewBifrostOperationError("failed to write image data", err)
	}

	// Close the multipart writer
	if err := writer.Close(); err != nil {
		return providerUtils.NewBifrostOperationError("failed to close multipart writer", err)
	}

	return nil
}
