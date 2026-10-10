# Media Extensions

Base URL: `https://api.mooo.si/v1`

Use the Bifrost virtual key as `Authorization: Bearer ...`. Models retain the
provider prefix, for example `grok2api/grok-imagine-image-2.0-web`.

## Precise Image Editing

`POST /images/edits` accepts the standard multipart image editing request.
Additional multipart fields `selection_regions` and `multi_region_edits` contain
JSON arrays. They are mutually exclusive and each accepts 1 to 8 entries.
These extensions require `stream=false`.

JSON requests accept `image` or `images` with objects containing `url`. A base64
data URI can be supplied as the URL. Region editing can also reference an image
URL. An existing Bifrost `input` object with `images` and `prompt` remains valid.

Example selection:

```json
{
  "selection_regions": [
    {"outer": {"points": [0.2, 0.2, 0.8, 0.2, 0.8, 0.8, 0.2, 0.8]}}
  ]
}
```

Example grouped edit:

```json
{
  "multi_region_edits": [
    {
      "regions": [{"outer": {"points": [0.2, 0.2, 0.8, 0.2, 0.8, 0.8, 0.2, 0.8]}}],
      "prompt": "Change the circle to blue",
      "reference_images": []
    }
  ]
}
```

The model must expose image editing upstream. Standard requests without region
fields retain the standard multipart encoding and response shape.

## Video Extension

`POST /videos/extensions` accepts JSON or multipart fields:

```json
{
  "model": "grok2api/grok-imagine-video-1.5",
  "prompt": "The red ball continues rolling",
  "video": {"id": "video_SOURCE:grok2api"},
  "seconds": "6",
  "video_extension_start_time": 5
}
```

`video` contains exactly one of `id`, `url` or `file_id`. A scoped source task ID
must belong to the model's provider. For custom OpenAI-compatible providers, the
gateway reads the completed source task with the selected upstream key and uses
its reusable video URL. Alternatively, pass the source URL directly.

`seconds` is normalized to the upstream extension field `duration`. If both are
provided, they must agree. Grok Web extensions require duration 6 to 10 seconds
and a positive `video_extension_start_time`; upstream validates these limits.
Fallback providers and `stream=true` are not accepted for extensions.
Unknown extension fields are rejected rather than silently omitted.

The response is a video task with a provider-scoped ID. Continue with
`GET /videos/{id}` and `GET /videos/{id}/content` using the same Bifrost key.
Source-task responses also retain `content_url` and `video` when supplied by
the upstream provider.
