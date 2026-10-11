# Media Extensions

Base URL: `https://api.mooo.si/v1`

Use the Bifrost virtual key as `Authorization: Bearer ...`. Models retain the
provider prefix, for example `grok2api/grok-imagine-image-2.0-web`.

## Precise Image Editing

`POST /images/edits` accepts the standard multipart image editing request.
Additional multipart fields `selection_regions` and `multi_region_edits` contain
JSON arrays. They are mutually exclusive and each accepts 1 to 8 entries.
These extensions require `stream=false`.
Multipart `stream` is parsed as a boolean; `stream=true` is rejected for region
editing.

JSON requests accept `image` or `images` with objects containing `url`. A base64
data URI can be supplied as the URL. Region editing can also reference an image
URL. An existing Bifrost `input` object with `images` and `prompt` remains valid.
The top-level prompt may be omitted when every `multi_region_edits` group supplies
a prompt. Group prompts are joined with `; ` for the gateway input; the original
region JSON and reference images are forwarded intact. Regions accept only
`outer.points`; holes and unknown region or polygon fields return HTTP 400.

`resolution`, `aspect_ratio`, and `storage_options` are accepted in both JSON and
multipart requests. Unknown top-level fields are rejected. To explicitly forward
provider parameters, send `extra_params` as a JSON object and set
`x-bf-passthrough-extra-params: true`. This works for JSON and multipart bodies.
Extra parameters cannot replace a populated request field or supply image input,
mask, region arrays, stream, or fallbacks; use the corresponding top-level field.

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

`POST /videos/extensions` accepts JSON or multipart.

For OpenAI and standard OpenAI-compatible providers, the required fields are
`prompt`, `seconds`, and `video`. `seconds` accepts 4, 8, 12, 16, or 20.
`video` is either an uploaded multipart file or a completed video reference.
Official SDK multipart references use `video[id]`; JSON uses `{"id":"..."}`.
`model` may be omitted for ID sources and is not forwarded in the standard
extension request. The gateway retrieves the completed source through the normal
governance path, verifies its provider and ID, and uses its metadata model for
extension model allowlists. An explicit model must match the source model.
Direct provider keys are rejected for all extensions. Routing must preserve the
source provider, actual source model, and registered key; rules that change this
binding or add fallbacks are rejected before provider execution.
The extension pins the registered key used for retrieval and applies the normal
model and key restrictions. Retrieval uses an isolated context, trace, and grant
limits. Uploaded sources require an explicit model; missing or uninferable models
return HTTP 400 with `model required on gateway for uploaded sources`.
Provider routing uses a model prefix, `provider` query,
`x-model-provider` header, or a provider-scoped source ID; otherwise it defaults
to OpenAI. `duration`, source URLs/file IDs, and `video_extension_start_time` are
rejected for the standard protocol.

The official SDK wire definitions are available in
`openai/openai-python/src/openai/types/video_extend_params.py` and its
`src/openai/resources/videos.py` `extend` method.

For `grok2api`, send the model and Grok fields:

```json
{
  "model": "grok2api/grok-imagine-video-1.5",
  "prompt": "The red ball continues rolling",
  "video": {"id": "video_SOURCE:grok2api"},
  "duration": 6,
  "video_extension_start_time": 5
}
```

`video` contains exactly one of `id`, `url` or `file_id`; uploaded source files are
rejected for Grok. A scoped source task ID must belong to the target provider.
For Grok, the gateway reads the completed source task with the selected upstream
key, checks the provider's `video_retrieve` permission, and uses `video.url` or
`content_url`. Source retrieval honors the provider's retrieve path override
independently of the extension path. Alternatively, pass the source URL directly.

For Grok only, `seconds` is accepted as an alias for `duration`. If both are
provided, they must agree. Grok Web extensions require duration 6 to 10 seconds
and a positive `video_extension_start_time`; upstream validates these limits.
Fallback providers and `stream=true` are not accepted for extensions.
Unknown extension fields are rejected rather than silently omitted.

Grok's `request_id` is mapped to a video task `id` with a provider suffix and
initial `queued` status. Continue with
`GET /videos/{id}` and `GET /videos/{id}/content` using the same Bifrost key.
Source-task responses retain `content_url` and the original `video` object,
including `duration` and `respect_moderation`, when supplied upstream.
Extension responses preserve the upstream total `seconds`; the requested
extension length does not overwrite it.

## Verification Boundary

Source review and compilation cover routing, request encoding, permission checks,
and response structures. They do not establish deployed API behavior. Deployment
acceptance must verify extension creation, source retrieval, task polling, and
download through the official endpoints with the selected provider key.
True OpenAI API execution remains unverified unless a real upstream request and
its media output are observed.
Source ownership, key restrictions, and model allowlists require real endpoint
verification after deployment, including allowed retrieval followed by a denied
extension for a disallowed source model.
