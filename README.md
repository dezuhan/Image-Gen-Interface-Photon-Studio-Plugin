# Image Gen — Photon Studio plugin

Selection-aware generative image / inpainting for Photon Studio, powered by **Replicate** or any
**custom HTTP endpoint**. Make a selection in Photon, describe what belongs there, and the result is
written back **only inside the selection** as one undoable step.

| Generate | History |
| --- | --- |
| ![Generate panel](docs/generate.png) | ![History panel](docs/history.png) |

![Settings panel](docs/settings.png)

## Design system

Panel styling, components and tokens follow [`../design-system`](../design-system/README.md):
24 px controls, 7 px control radius, 12 px floating surfaces, the canonical `select.js`
dropdown and the shared header/footer contract.

## Install

1. Photon Studio → **Preferences → Plug-ins → Install plugin** → select this repository's
   `plugin/` folder.
2. Open the panel with **Plugins → Image Gen…** (`Ctrl+Shift+G`).
3. In **Settings**, store the API key, add the models you use (each entry remembers its provider),
   then **Test connection**.
4. Back in **Generate**, make a selection (optional), write a prompt and press **Generate**, then
   **Apply**.

## Two references per generation

When a selection exists, the plugin exports **two images** and sends both to Replicate:

1. **the whole selected layer** — full context, aspect ratio and surrounding artwork;
2. **the selection crop** — the area that must be regenerated.

They go into `image_input` (nano-banana-2 accepts up to 14 references) and the prompt is prefixed with
*"Image 1 is the full image for context. Image 2 is the selected area that must be regenerated."*
so the model knows which reference is the target.

Because Nano Banana has no mask input, its output follows the first reference (the full layer). The
plugin cuts the selection rectangle out of the returned image, scales it to the capture bounds and
applies it with `applyImage(captureToken)` — Photon still clips it through the real selection
coverage, so only the selected area changes.

Without a selection only the layer is sent, and the result is inserted as a new layer at the
provider's native size (it is not stretched onto the layer's rectangle). Models with a real
mask input (FLUX Fill, Stable Diffusion inpainting) keep their native path: `image` + `mask` of the
crop instead of two references.

## How selection editing works

Photon exposes the current selection to plugins only as a boolean, so the plugin uses the SDK's
capture API:

1. `documents.capture()` snapshots the selected area (pixels + bounds + selection coverage) and
   returns a `token`.
2. The captured pixels become the provider's base image; the coverage becomes the inpainting mask
   (white = generate here).
3. The returned image is sent back with
   `documents.applyImage({ image, captureToken })`, so Photon composites it through the real
   selection coverage — feathered edges included — in one undo step.
4. If the capture API is unavailable, the plugin still generates from the selected layer and writes
   the result as a new layer with the mask applied to its alpha (masked fallback).



## Providers

### Replicate

- **Default: `google/nano-banana-2`** (Gemini 3.1 Flash Image). Its schema takes `prompt`,
  `image_input` (up to 14 reference images), `aspect_ratio`, `match_input_image`, `output_format`
  and `seed`; it has no mask or step controls, so the plugin sends the layer + selection references
  and Photon clips the returned image to the selection.
- The plugin **reads each model's input schema** with the stored token
  (`GET /v1/models/{owner}/{name}`) and only sends fields that model declares: reference images vs
  `image`+`mask`, `num_inference_steps`/`steps`, `guidance`/`guidance_scale`, `strength`,
  `temperature`, `aspect_ratio`, `resolution`, `output_format`, `seed`. When the schema cannot be
  read it falls back to the model-family defaults.
- Model names accept `owner/name` (official models) or `owner/name:version` (pinned community
  version).
- Submit uses `Prefer: wait=60`, then polls `GET /v1/predictions/{id}` every 1.5 s (max 180 s); the
  output URL is downloaded as bytes.
- Other presets: `black-forest-labs/flux-fill-dev` (inpainting with a mask),
  `black-forest-labs/flux-dev` (image to image), `black-forest-labs/flux-schnell` (fast text to
  image).
- The API key is stored in Photon's credential vault and sent as `Authorization: Bearer …`; it is
  never written to plugin settings or logs.

### Custom endpoint

Any JSON endpoint that returns an image URL or base64 payload:

| Field | Meaning |
| --- | --- |
| Submit URL / Method | Where the request goes |
| Mode | `Image in the response` or `Poll until ready` |
| Headers template | Extra JSON headers (the API key can be attached as a credential) |
| Body template | JSON with `{{prompt}}`, `{{image}}`, `{{mask}}`, `{{width}}`, `{{height}}`, `{{seed}}`, `{{model}}` |
| Poll URL | e.g. `https://host/jobs/{{id}}` (poll mode) |
| Output path | Dot path to the image in the response, e.g. `data[0].url` or `output` |
| Status path / Success values | e.g. `status` + `succeeded,completed` |
| Image value | Data URI, bare base64, or URL |

Placeholders are JSON-escaped, so prompts with quotes cannot break the template.

## Controls

| Control | Range | Meaning |
| --- | --- | --- |
| Prompt | up to 2 000 chars | What to generate inside the selection |
| Model | text | `owner/name[:version]` for Replicate, free text for custom |
| Model | saved list | Picks a saved model; the provider follows the entry, so switching does not need a re-paste |
| Work size | Auto / 1K / 2K / 4K | Reference encode size and, when the model declares it, the `resolution` input |
| Aspect ratio | Auto or 1:1 … 21:9 | Sent when the model declares `aspect_ratio`; Auto keeps `match_input_image` |
| Temperature | 0–2 | Sent only to models that declare `temperature` |
| Steps / Guidance | — | Sent only to models that declare them (ignored by Nano Banana) |
| Seed | empty = random | Reproducibility |
| Margin (px) | 0–256 | Grows the capture rectangle around the selection for context |
| Strength | 0.1–1 | Image-to-image strength where supported |

## Tabs

- **Generate** — prompt, model, work size, aspect ratio, temperature, advanced settings, preview,
  Apply/Discard.
- **History** — the last ten generations. *Use* restores the prompt and settings; *Insert* places the
  image into the document again. The full image is cached in memory for the session, so after a
  restart the thumbnails stay but the image has to be generated again (the button explains this).
- **Settings** — provider, model library, API key, custom endpoint template, and the **Logs** section
  (auto-opens on errors). Logs are only shown here; the same layout as the Upscale panel.

## Limits and failure modes

- There is no brush-mask editor in this version: masks come from the Photon selection, or from the
  whole captured rectangle when the host does not expose the coverage.
- Work size is capped by the plugin transfer limits (8 192 px per side, 16 MP); larger work is
  scaled down before sending and the result is scaled back on apply.
- Generation needs network access to the provider's origin; the custom endpoint origin is allowed at
  save time and Replicate origins are declared in the manifest.
- A running generation can be cancelled; the capture token is released on discard.
- If the document changes while a prediction runs, Apply refuses instead of overwriting: generate
  again.
- Provider errors are translated (bad key, quota, rate limit, offline); nothing is retried
  automatically to avoid double billing.

## Verification status

- **Tested headless:** 61 tests (`core`, `providers`, `pipeline`) with a fake Photon SDK covering the
  capture → submit → poll → download → apply sequence, the masked fallback, cancellation, failed
  predictions and template parsing.
- **Not yet exercised against live Photon/Replicate in this repository.** The SDK behaviour above was
  read from Photon 0.1.66's `app.asar` (capture returns bounds/coverage and applyImage composites
  with the capture token), but a real generation round trip still needs a manual check.

```powershell
node tools/core-test.cjs        # 17 tests: masks, bounds, sizes, templates, parsing
node tools/providers-test.cjs   # 22 tests: Replicate, schema parsing, custom adapters
node tools/pipeline-test.cjs    # 22 tests: full flow with a fake SDK, schema-driven payloads
node tools/ui-check.cjs         # every element id / key used by app.js exists
node tools/bench.cjs            # mask/size timings and provider payload sizes
```

## Changelog

### 0.7.3

- Footer follows the shared plugin pattern: version on the left, `Details` and `Check service`
  on the right. Details shows the plugin log; Check service reports document/layer and provider
  readiness in the same log.

### 0.7.2

- Tabs now use the canonical `tabs.js` slider: the active plate moves with a 220 ms standard
  ease instead of popping between tabs. No layout or behaviour change.

### 0.7.1

- Added the missing dropdown tokens (`--ig-radius-card`, `--ig-glass`, `--ig-popup-bg`,
  `--ig-shadow-popup`) so the select menu renders with the design-system plate, radius and
  shadow.

### 0.7.0

- **Three tabs**: Generate, History, Settings.
- **History is its own tab** with *Insert* (place the image into the document again, session cache)
  and *Use* (restore prompt/settings). History keeps ten entries instead of six.
- **Logs live only in Settings** (still auto-open on errors).
- Removed the source chip above the prompt field.
- Tests: 61.

### 0.6.0

- **Preview keeps the image's aspect ratio.** The canvas is sized with a fit box (width and height
  computed from the image) instead of two independent CSS maxima, and it re-fits when the panel is
  resized.
- **Whole-layer results are no longer stretched.** With no selection the generated image keeps the
  provider's native size (e.g. 1536×2752) and is inserted as a new layer; only selection edits are
  mapped back onto the capture rectangle.
- Tests: 61.

### 0.5.1

- **Fixed `init failed: Cannot set properties of undefined (setting 'submitUrl')`** — a leftover
  `el.custom…` assignment from the removed source-mode UI ran before the panel finished loading.
- Added `tools/ui-check.cjs`, a static check that every `getElementById` id exists in `index.html`
  and every `el.<key>` exists in the element table, so this class of crash fails tests instead of the
  panel.
- Tests: 58 + UI check.

### 0.5.0

- **Saved model library.** Settings takes model names and stores them with their provider; the
  Generate tab shows them in a dropdown, so switching model/provider needs no copy-paste.
- **Schema-driven Replicate inputs.** The model's declared input set is fetched once and cached, then
  used to decide every optional field (references vs mask, steps/guidance names, temperature,
  aspect ratio, resolution). Unsupported controls are simply not sent.
- **Work size 1K / 2K / 4K** (plus Auto) and a new **Aspect ratio** control; both map to the model's
  `resolution` / `aspect_ratio` inputs when declared.
- **Temperature** control in the Generate tab.
- **Logs moved to their own collapsible section** below both tabs (auto-opens on failure), matching
  the Upscale panel.
- Removed the long model hint under the model field.
- Tests: 58.

### 0.4.0

- **Both exports are sent together.** A selection now produces two references in one request: the
  full selected layer (context) and the selection crop (target), with a context prefix in the prompt.
- Nano Banana's full-image output is cropped back to the selection rectangle and scaled to the
  capture bounds before `applyImage`, so only the selected area is written.
- The Source dropdown is gone: presence of a selection decides the path (two references vs layer
  only); models with a mask input still use `image` + `mask`.
- Tests: 54.

### 0.3.0

- **Default model is now `google/nano-banana-2`**, built against its published schema:
  `prompt` + `image_input` (array, up to 14 reference images) + `match_input_image` +
  `output_format: png` + `seed`. Mask/steps/guidance/strength are no longer sent to it, so Replicate
  validation passes; selection edits work by sending the selected crop and letting Photon clip the
  result through the capture coverage.
- Model-aware input builder (`modelFamily` / `supportsMask`); the mask is only encoded and uploaded
  for models that accept it.
- Upgrade migration: a stored old default (`black-forest-labs/flux-fill-dev`) becomes Nano Banana 2.
- Tests: 55.

### 0.2.0

- **Two explicit source modes** instead of implicit selection detection: **Selection only** (capture
  the selection, edit inside it) and **Selected layer** (regenerate the whole layer, ignore the
  selection).
- Selection mode now fails with a clear message when nothing is selected instead of silently falling
  back to the layer.
- Tests: 51.

### 0.1.3

- **Root cause of the empty submit body.** Photon's `network.request` already JSON-parses the reply
  unless `response: "bytes"` is requested, so `reply.body` is a **parsed object** — not bytes and not
  text. `readJson` now returns that object directly and still tolerates string/ArrayBuffer/typed-view
  bodies from other builds.
- Error previews show the body shape (`parsed JSON`, `N bytes`, `no body`) plus the raw JSON, so a
  provider response is never described as "empty" when it is actually parsed.
- Tests: 49.

### 0.1.2

- **Body decoding accepts every shape Photon may hand back**: `Uint8Array`, `ArrayBuffer`, a typed
  view, or already-decoded text. A text body was being turned into zero bytes, which is why the
  prediction id came back empty.
- A submit without an id now reports the real response in the message
  (`HTTP <status> <content-type> · <body>` + the parsed JSON), and the panel log records each submit,
  so the next failure is diagnosable without guessing.
- Tests: 47.

### 0.1.1

- **Fixed "Polling failed (HTTP 404)".** Photon's `network.request` answers with
  `{ status, body: Uint8Array, headers }` — there is no `json` field, so the prediction id was read
  as `null` and the poll hit `/v1/predictions/null`. Responses are now decoded from the byte body
  (`readJson`), and a submit that returns no id fails with a clear message instead of polling `null`.
- Non-2xx responses now include a snippet of the provider's body in the error (that is where
  Replicate puts `{"detail": …}`).

### 0.1.0

- First release: Replicate + custom endpoint providers, selection-aware inpainting through
  `documents.capture` / `applyImage(captureToken)`, masked layer fallback, work-size planning,
  recent results, credential-vault API keys.

MIT licensed — see [LICENSE](LICENSE).
