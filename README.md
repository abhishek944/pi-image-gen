# pi-image-gen

Pi extension that adds the general-purpose `image_generate` tool and an optional, disabled-by-default `sprite_generate` pipeline. Supported providers:

| Provider                       | Model id (alias)                              | Authentication        |
| ------------------------------ | --------------------------------------------- | --------------------- |
| ChatGPT Codex                  | `gpt-image-2` on route `codex-subscription` (`gpt-image-2-codex`, `codex`, and `openai-codex` remain legacy aliases) | Pi `/login` → ChatGPT Plus/Pro (Codex) |
| OpenAI                         | `gpt-image-2`, `gpt-image-2.5-flare`, `gpt-image-2.5-sunburst` | `OPENAI_API_KEY`      |
| Google Gemini ("Nano Banana")  | `gemini-3-pro-image` (alias `nano-banana-pro`), `gemini-3.1-flash-image` (alias `nano-banana-2`), `gemini-3.1-flash-lite-image` (alias `nano-banana-2-lite`), `gemini-2.5-flash-image` (alias `nano-banana`) | `GEMINI_API_KEY` |
| Alibaba DashScope (Qwen-Image) | `qwen-image-3.0-pro`, `qwen-image-3.0`, `qwen-image-2.0-pro`, `qwen-image-2.0` | `DASHSCOPE_API_KEY`   |
| Volcengine Ark (ByteDance Seedream) | `doubao-seedream-5-0-pro-260628` (alias `seedream-5-pro`, retired id `doubao-seedream-5-0-pro-260128` still resolves), `doubao-seedream-5-0-260128` (aliases `seedream-5`, `seedream`; the same model also answers to `doubao-seedream-5-0-lite-260128` / `seedream-5-lite`), `doubao-seedream-4-5-251128` (alias `seedream-4-5`), `doubao-seedream-4-0-250828` (alias `seedream-4`) | `ARK_API_KEY`         |
| Meta Model API (Muse Image) | `muse-image-1.0` (aliases `muse-image`, `meta-muse`) | Pi `/login meta` via `pi-meta-oauth`, or `META_API_KEY` |
| OpenRouter                     | any (use `openrouter/<vendor>/<id>`)          | `OPENROUTER_API_KEY`  |
| Custom providers               | whatever you declare in settings              | (your choice, via `$VAR`) |

Upstream API docs (handy when debugging gateway behavior or adding new models):

- OpenAI GPT Image — [generation guide](https://developers.openai.com/api/docs/guides/image-generation), [gpt-image-2](https://developers.openai.com/api/docs/models/gpt-image-2), [2.5 Flare](https://developers.openai.com/api/docs/models/gpt-image-2.5-flare), [2.5 Sunburst](https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst)
- Google Gemini image generation — [ai.google.dev/gemini-api/docs/image-generation](https://ai.google.dev/gemini-api/docs/image-generation)
- Alibaba Qwen-Image 3.0 (generation & editing) — [help.aliyun.com/zh/model-studio/qwen-image-generation-and-editing-api-reference](https://help.aliyun.com/zh/model-studio/qwen-image-generation-and-editing-api-reference)
- Alibaba DashScope Qwen-Image 2.0 (text-to-image) — [help.aliyun.com/zh/model-studio/qwen-image-api](https://help.aliyun.com/zh/model-studio/qwen-image-api)
- Alibaba DashScope Qwen-Image-Edit — [help.aliyun.com/zh/model-studio/qwen-image-edit-api](https://help.aliyun.com/zh/model-studio/qwen-image-edit-api)
- Volcengine Ark Seedream — [volcengine.com/docs/82379/1824121](https://www.volcengine.com/docs/82379/1824121)
- Meta Muse Image cookbook — [github.com/meta-models/meta-model-cookbook/tree/main/05_muse_image](https://github.com/meta-models/meta-model-cookbook/tree/main/05_muse_image)
- OpenRouter image API — [openrouter.ai/docs/api/api-reference/images/create-images](https://openrouter.ai/docs/api/api-reference/images/create-images)

Built-in API-key routes read the environment variables shown above (or `providers.<id>.apiKey` in `settings.json`); they do not read keys saved by Pi's general `/login` flow. Subscription routes are separate: Meta can use a Pi credential created by the [`pi-meta-oauth`](https://github.com/BlockedPath/pi-meta-oauth) package, while Codex uses Pi's ChatGPT Plus/Pro login. Meta API billing also accepts `META_API_KEY`; legacy `MODEL_API_KEY` remains accepted.

For subscription-backed generation, first run `/login` in Pi and select **ChatGPT Plus/Pro (Codex)**, then run `/image-gen use codex-subscription gpt-image-2`. No `OPENAI_API_KEY` is required. Codex requests use the ChatGPT-backed image endpoints and count against provider-managed subscription usage and limits. GPT Image 2.5 is intentionally **not** listed on this route: its API model ids have not been verified against the private Codex subscription endpoint.

The active provider route and model are **fixed in settings.json**. The `image_generate` tool intentionally does **not** take a `model` parameter — point your project at one route/model pair for consistent output. Use `/image-gen use <provider> <model>` to switch both safely; the command persists trusted project settings and refreshes the tool schema immediately.

## Install

From npm:

```sh
pi install npm:@abhishek944/pi-image-gen
```

Or directly from GitHub:

```sh
pi install git:github.com/abhishek944/pi-image-gen@v0.2.0
```

The package's `pi.extensions` field auto-registers it with the host pi-coding-agent runtime; no extra wiring needed.

## Configure

Settings are read by `pi-shared`'s `loadPiSettings`, which merges three files (low-to-high priority):

1. `~/.pi/agent/settings.json` (global)
2. `$PI_AGENT_HOME/settings.json` (agent dir, if `PI_AGENT_HOME` is set)
3. `<cwd>/.pi/settings.json` (trusted project)

Project settings are ignored when project trust is declined. `${ENV_VAR}` interpolation is supported in global and agent settings only, so keep environment-backed credentials out of project settings.

All settings live under the `pi-image-gen` key. New configurations should set an authentication-specific `defaultProvider` together with `defaultModel` (the command below writes this for you):

```text
/image-gen use gemini-api nano-banana
```

```json
{
  "pi-image-gen": {
    "defaultProvider": "gemini-api",
    "defaultModel": "nano-banana"
  }
}
```

Model-only configurations remain supported and keep the earlier automatic routing behavior.

…and exports the matching env var:

```sh
export GEMINI_API_KEY=sk-...
```

That's it. From the agent: `image_generate({ prompt: "a cyberpunk cat" })`.

### All settings fields

```json
{
  "pi-image-gen": {
    "defaultProvider": "gemini-api",
    "defaultModel": "nano-banana",
    "outputDir": ".pi/images",
    "requestTimeoutMs": 120000,
    "openRouterDiscovery": true,
    "spriteGeneration": {
      "enabled": false,
      "defaultRows": 2,
      "defaultColumns": 3,
      "defaultFormat": "apng",
      "frameDurationMs": 120,
      "strictValidation": true,
      "outputDir": ".pi/images/sprites",
      "maxFrames": 16
    },

    "providers": {
      "openai":     { "baseUrl": "https://my-proxy.example.com/v1", "apiKey": "${MY_OPENAI_KEY}" },
      "gemini":     { "headers": { "x-goog-trace": "pi-prod" } },
      "dashscope":  { "baseUrl": "https://dashscope-intl.aliyuncs.com/api/v1" },
      "ark":        { "apiKey": "$ARK_API_KEY" },
      "meta":       { "apiKey": "$META_API_KEY" },
      "openrouter": { "apiKey": "$OPENROUTER_API_KEY" }
    },

    "customProviders": {
      "my-stable-diffusion": {
        "api": "openai",
        "baseUrl": "https://api.my-sd.example.com/v1",
        "apiKey": "${MY_SD_KEY}",
        "headers": { "x-tenant": "team-a" },
        "models": [
          { "id": "sd-3-large", "alias": "sd3" },
          "sd-3-medium"
        ]
      }
    }
  }
}
```

| Field             | Purpose                                                                                  |
| ----------------- | ---------------------------------------------------------------------------------------- |
| `defaultProvider` | Authentication-specific route (`openai-api`, `codex-subscription`, `gemini-api`, `dashscope-api`, `openrouter-api`, `ark-api`, `meta-api`, `meta-subscription`, or a custom-provider id). Recommended for new configs. |
| `defaultModel`    | Model id or alias the tool will use. **Required.**                                       |
| `outputDir`       | Where to write generated images. Relative paths resolve against the session cwd. Default `.pi/images`. |
| `requestTimeoutMs` | End-to-end deadline including inputs and downloads. `1000`–`900000`; default `120000`. |
| `openRouterDiscovery` | Best-effort discovery of the selected OpenRouter model's supported parameters. Default `true`; failure falls back safely. |
| `providers`       | Per-built-in-provider override. Set `apiKey`, `baseUrl`, or `headers` to point at a proxy or non-standard env var. |
| `customProviders` | User-defined providers — see below. Built-in route ids such as `openai-api` and `meta-subscription` are reserved and cannot be shadowed. |
| `spriteGeneration` | Optional sprite-sheet processing settings. Disabled by default; see below. Invalid values fail closed to safe defaults. |

In global and agent settings, `apiKey`, `baseUrl`, and `headers` values support `$VAR` and `${VAR}` environment interpolation. Fallbacks require the braced form (for example, `${FOO:-default}`); `$FOO:-default` is not supported. Project settings keep all of these placeholders literal.

## DeepSeek Harness

| Host | `pi-image-gen` status |
| --- | --- |
| [pi2dsh](https://github.com/weijiafu14/pi2dsh) | `@amaster.ai/pi-image-gen@0.1.8` was exercised against a controlled OpenAI-compatible endpoint ([scope and evidence](https://github.com/TGYD-helige/pi/issues/159)). |
| [dsh-pi-host](https://github.com/TGYD-helige/dsh-pi) | Loads `@amaster.ai/pi-image-gen` when selected in its `extensions` list. |

Follow the selected host's documentation for installation and current compatibility details.

## Built-in setup walkthrough

### 1. OpenAI (`gpt-image-2` and GPT Image 2.5)

```sh
export OPENAI_API_KEY=sk-...
```

```json
{ "pi-image-gen": { "defaultProvider": "openai-api", "defaultModel": "gpt-image-2.5-flare" } }
```

Choose `gpt-image-2.5-flare` for fast everyday generation or `gpt-image-2.5-sunburst` when editing precision matters most. Both expose `low`, `medium`, `high`, `xhigh`, `max`, and `auto` quality. Their `-2026-09-08` snapshots are also built in. The older `gpt-image-2` remains available.

### 2. Google Gemini "Nano Banana"

```sh
export GEMINI_API_KEY=...
```

```json
{ "pi-image-gen": { "defaultModel": "nano-banana" } }
```

### 3. Alibaba DashScope (Qwen-Image)

```sh
export DASHSCOPE_API_KEY=...
```

```json
{ "pi-image-gen": { "defaultModel": "qwen-image-2.0" } }
```

For the international DashScope endpoint, override the base URL:

```json
{
  "pi-image-gen": {
    "defaultModel": "qwen-image-2.0",
    "providers": {
      "dashscope": { "baseUrl": "https://dashscope-intl.aliyuncs.com/api/v1" }
    }
  }
}
```

### 4. Volcengine Ark (ByteDance Seedream)

```sh
export ARK_API_KEY=...
```

```json
{ "pi-image-gen": { "defaultModel": "seedream" } }
```

> Supported `size` values are model-dependent, and the tool schema tells the agent the exact form for the active model: a tier token (`1K`/`1.5K`/`2K`/`3K`/`4K` — the list differs per model) or an explicit `"<w>x<h>"` pixel string, never mixed. Seedream 5.0 / 4.5 enforce a 2K pixel floor (`1024x1024` fails with `InvalidParameter`); 5.0 pro accepts `1K`/`1.5K`/`2K` down to 921,600 px; 4.0 accepts 1K. Full sizing matrix in the [official docs](https://www.volcengine.com/docs/82379/1824121). Seedream has **no `n` parameter**, so `n` is hidden. Supported non-Pro models instead expose `seriesMaxImages` for the API's related `sequential_image_generation` mode; Seedream 5.0 Pro does not support that mode. The extension sends `watermark: false` by default to avoid Seedream's upstream "AI 生成" badge, while an explicit `watermark: true` opts in.

The default base URL is `https://ark.cn-beijing.volces.com/api/v3`. To use a different region (e.g. `ap-southeast`), override it:

```json
{
  "pi-image-gen": {
    "defaultModel": "seedream",
    "providers": {
      "ark": { "baseUrl": "https://ark.ap-southeast.bytepluses.com/api/v3" }
    }
  }
}
```

### 5. Meta Muse Image

Meta works with either subscription login or an API key.

**Subscription login:** install [`pi-meta-oauth`](https://github.com/BlockedPath/pi-meta-oauth), then authenticate in Pi. Check that package's current Pi peer-version range first; OAuth support is optional, and `META_API_KEY` remains available on Pi versions outside it.

```sh
pi install npm:pi-meta-oauth
```

```text
/login meta
```

**API key:** create a key in the [Meta Model API dashboard](https://dev.meta.ai/), then configure:

```sh
export META_API_KEY=...
```

Legacy `MODEL_API_KEY` is also accepted. Select the funding route explicitly:

```text
/image-gen use meta-subscription muse-image
/image-gen use meta-api muse-image
```

```json
{ "pi-image-gen": { "defaultProvider": "meta-subscription", "defaultModel": "muse-image" } }
```

With a legacy model-only configuration, an active Meta login still takes precedence and an API key remains the fallback. With an explicit route, `meta-subscription` uses only Pi OAuth and `meta-api` uses only the configured API key.

OAuth credentials are resolved and refreshed through Pi at request time. They are used only for the built-in Meta provider at `api.meta.ai`, never for custom providers or overridden endpoints. Muse Image uses Meta's conversational Responses API. This extension sends `store: false`, so calls do not retain server-side conversation state. Generate from text normally; for editing or composition, pass one or more images through the tool's `image` array. Official cookbook size examples include `1024x1024`, `1536x1024`, and `1024x1536`; these are guidance rather than an exhaustive enum, and Meta validates the requested value. Muse Image produces one output per request, so `n` and `quality` are hidden.

### 6. OpenRouter (one key, many models)

```sh
export OPENROUTER_API_KEY=...
```

```json
{ "pi-image-gen": { "defaultModel": "openrouter/bytedance-seed/seedream-4.5" } }
```

The string after `openrouter/` is the OpenRouter model slug; pass any image model OpenRouter supports (`google/gemini-3.1-flash-image`, `openai/gpt-image-2`, `bytedance-seed/seedream-4.5`, …).

OpenRouter's image API is **not** OpenAI-compatible despite the family name — it lives at `POST /api/v1/images` (no `/generations` suffix) and uses JSON `input_references` for image-to-image. The extension targets the right endpoint automatically; no wire-shape config needed.

## Custom providers

Use `customProviders` for anything not built in: a self-hosted Stable Diffusion, an internal corp gateway, a third-party image API. The shape mirrors [pi.dev's custom-provider docs](https://pi.dev/docs/latest/custom-provider).

Each custom provider declares:

| Field      | Required | Notes                                                                                |
| ---------- | -------- | ------------------------------------------------------------------------------------ |
| `api` | yes      | One of `openai`, `gemini`, `dashscope`, `openrouter`, `ark`, `meta`. Picks the image-API wire shape. |
| `baseUrl`  | yes      | API endpoint URL. `$VAR` syntax supported.                                           |
| `apiKey`   | usually  | Credential string. `$VAR` syntax supported. Required for `bearer` and `header` authentication. |
| `auth`     | no       | `{ "type": "bearer" }`, `{ "type": "header", "header": "x-api-key" }`, or explicit `{ "type": "none" }`. Omission preserves the adapter's legacy default (Gemini uses `x-goog-api-key`; the others use bearer). |
| `name`     | no       | Display name shown in `/image-gen list`.                                             |
| `headers`  | no       | Extra headers merged into every request.                                             |
| `models`   | no       | Optional model id/alias list. Omit to make this a **catch-all** — the provider will accept any unknown model id (passed through as the remote id). Provide a list only when you want aliases or want to route specific ids elsewhere. Each entry is a string or `{ id, alias?, name?, capabilities? }`. |

Requests using a named credential header reject redirects so that a gateway cannot forward that credential to another origin.

A custom model whose `id` names a built-in model **inherits that model's capability contract** (size form, `n` ceiling, reference-image rules) so the tool schema stays accurate when you route a known model through your own gateway. Declare `capabilities` on the entry to override individual fields; anything undeclared falls back to the built-in entry, then to a conservative generic contract. Catch-all routes and unknown ids get no contract — the schema stays fully generic, as before.

```json
{
  "pi-image-gen": {
    "defaultModel": "qwen-image-3.0",
    "customProviders": {
      "corp-gateway": {
        "api": "dashscope",
        "baseUrl": "https://gateway.corp.example/api/v1",
        "apiKey": "$GW_KEY",
        "auth": { "type": "bearer" },
        "models": [
          "qwen-image-3.0",
          { "id": "my-finetune", "capabilities": { "nMax": 4, "maxReferenceImages": 2 } }
        ]
      }
    }
  }
}
```

> Note: pi.dev custom providers also have an `api` field, but its values (`openai-completions`, `anthropic-messages`, …) are LLM streaming formats that don't apply to image generation. The values here (`openai`, `gemini`, `dashscope`, `openrouter`, `ark`, `meta`) are image-API wire shapes — same field name, different namespace.

### Example: self-hosted Stable Diffusion (OpenAI-compatible)

```sh
export SD_KEY=local-secret
```

```json
{
  "pi-image-gen": {
    "defaultModel": "sd3",
    "customProviders": {
      "my-sd": {
        "api": "openai",
        "baseUrl": "http://localhost:8000/v1",
        "apiKey": "$SD_KEY",
        "models": [{ "id": "sd-3-large", "alias": "sd3" }]
      }
    }
  }
}
```

The agent calls `image_generate({prompt: ...})`; the extension sees `defaultModel: "sd3"`, finds it under `my-sd`, and POSTs to `http://localhost:8000/v1/images/generations` with `Bearer $SD_KEY`.

### Example: Volcengine Doubao image API (OpenAI-compatible)

```json
{
  "pi-image-gen": {
    "defaultModel": "doubao-seed-image",
    "customProviders": {
      "doubao": {
        "api": "openai",
        "baseUrl": "https://ark.cn-beijing.volces.com/api/v3",
        "apiKey": "${ARK_API_KEY}",
        "models": [{ "id": "doubao-seedream-4-0-250828", "alias": "doubao-seed-image" }]
      }
    }
  }
}
```

### Example: a Gemini-shape proxy

If your provider speaks the Google Generative Language wire format:

```json
{
  "pi-image-gen": {
    "defaultModel": "internal-banana",
    "customProviders": {
      "internal": {
        "api": "gemini",
        "baseUrl": "https://gemini-proxy.corp.example/v1beta",
        "apiKey": "$INTERNAL_GEMINI_KEY",
        "models": [{ "id": "gemini-2.5-flash-image", "alias": "internal-banana" }]
      }
    }
  }
}
```

### Direct addressing without an alias

If a custom provider has no `models` list, you can still address it with `<providerName>/<remoteId>`:

```json
{
  "pi-image-gen": {
    "defaultModel": "my-sd/sd-3-large",
    "customProviders": {
      "my-sd": { "api": "openai", "baseUrl": "http://localhost:8000/v1", "apiKey": "$SD_KEY" }
    }
  }
}
```

## Optional sprite generation

`image_generate` remains the general image tool. Enable the separate `sprite_generate` tool only when you need one coherent action sheet plus deterministic local processing:

```json
{
  "pi-image-gen": {
    "defaultProvider": "openai-api",
    "defaultModel": "gpt-image-2",
    "spriteGeneration": {
      "enabled": true,
      "defaultRows": 2,
      "defaultColumns": 3,
      "defaultFormat": "apng",
      "frameDurationMs": 120,
      "strictValidation": true,
      "outputDir": ".pi/images/sprites",
      "maxFrames": 16
    }
  }
}
```

Run `/image-gen reload` after editing settings. The command reports whether sprite generation is enabled. Toggling it changes only `sprite_generate`; all other active tools are preserved.

A call makes exactly one provider request through the same `generateImage()` service used by `image_generate`. The model creates one full sheet, then local code splits cells in row-major order, segments alpha foreground, applies one shared scale, aligns frames, checks geometry and silhouette motion, and writes transparent PNG assets. No automatic paid retry occurs.

```ts
sprite_generate({
  prompt: "the same red-jacket courier running in place, crisp pixel art",
  image: ["references/courier.png"],
  assetType: "player",
  action: "run",
  view: "side",
  rows: 2,
  columns: 3,
  frameCount: 6,
  align: "feet",
  format: "apng",
  frameDurationMs: 120,
  filename: "courier-run"
})
```

Six frames default to a 2×3 grid. `frameCount` must equal `rows × columns`, with a hard maximum of 16. Supported output formats are `apng` and `frames`; GIF is intentionally not advertised because it reduces alpha and color fidelity. Model-aware `size`, `aspectRatio`, `imageSize`, and `quality` controls appear only when the configured route supports them.

Each call reserves a new run directory and never overwrites an earlier run:

```text
.pi/images/sprites/courier-run/
├── prompt-used.txt
├── raw-sheet.png
├── sheet-transparent.png
├── frames/frame-01.png ... frame-06.png
├── animation.apng
└── pipeline-meta.json
```

Strict validation prevents APNG approval when required checks fail, while preserving the raw sheet and any safe processed artifacts. Advisory mode can accept bounded quality warnings, but structural failures such as empty cells or missing alpha still reject the sequence. Local checks cannot prove identity, costume, anatomy, or acting quality; inspect those visually before shipping.

## Tool: `image_generate`

```ts
image_generate({
  prompt: string,                  // required — what to draw or how to edit
  image?: string[],                // optional — array of file paths or http(s) URLs
  n?: number,                      // per-model ceiling (qwen 1–6, gpt-image-2 1–10); hidden for Seedream
  size?: string,                   // per-model form (see below); hidden for Gemini models
  aspectRatio?: string,            // Gemini models only — enum from the model's vocabulary
  imageSize?: string,              // Gemini models only — tier enum ("1K"/"2K"/"4K"), when the model has tiers
  quality?: 'low'|'medium'|'high'|'xhigh'|'max'|'auto', // exact enum is model-specific
  outputFormat?: 'png'|'jpeg'|'webp', // verified OpenAI/OpenRouter routes
  background?: 'auto'|'transparent'|'opaque',
  outputCompression?: number,        // 0–100; JPEG/WebP only
  mask?: string,                     // precise OpenAI edit mask; requires image
  negativePrompt?: string,           // Qwen 3 / discovered OpenRouter support
  seed?: number,
  promptEnhance?: boolean,
  enableThinking?: boolean,
  watermark?: boolean,
  seriesMaxImages?: number,          // Seedream related series; distinct from n
  filename?: string,               // filename prefix (no extension)
  outputDir?: string,              // override settings.outputDir for this call
})
```

Returns the absolute file path(s) of saved images. Files land in `outputDir` (default `<cwd>/.pi/images`), filename pattern `<filename or model-UTC-stamp>.<ext>`. Result details also include elapsed time and, when supplied by the provider, a sanitized request id, numeric usage/cost metadata, and decoded output dimensions.

**The schema is model-aware.** Every built-in model carries a capability contract sourced from official API docs or clearly labeled extension safety limits, and the tool is registered with parameters shaped by that contract (on session start, and again after `/image-gen reload`) — so the agent sees exactly the knobs the active model honors, with documented values in enums and descriptions where available. Provider-specific numeric contracts (size ranges, `n` ceilings, and reference-image counts) are generally **advice, not a gate** because a self-hosted deployment or gateway may legitimately differ. Independently, the extension enforces universal safety ceilings of 16 references, 20MB per input, and 128MB combined, plus rejects parameter combinations an adapter would otherwise silently drop. Providers may enforce stricter limits.

- `size` follows the model's documented form:
  - **Qwen** (`qwen-image-*`): `"<width>*<height>"` (asterisk, e.g. `"2048*2048"`), total pixels 512²–2048²; 3.0 models additionally cap aspect ratio at 1:8–8:1. The x-form is normalized automatically as a safety net.
  - **Seedream** (`doubao-seedream-*`): a tier token from the model's list (`1K`/`1.5K`/`2K`/`3K`/`4K`) **or** an explicit `"<w>x<h>"` within the model's pixel window (2K floor on 5.0/4.5).
  - **gpt-image-2**: `"auto"` or `"<w>x<h>"` — arbitrary sizes allowed (both edges divisible by 16, ratio ≤ 3:1, 655,360–8,294,400 px, longest edge ≤ 3840), beyond the standard `1024x1024`/`1536x1024`/`1024x1536`.
  - **GPT Image 2.5 Flare/Sunburst**: the same arbitrary `"<w>x<h>"` range as GPT Image 2 (multiples of 16, ratio 1:3–3:1, 655,360–8,294,400 px, longest edge ≤ 3840), plus `"auto"`. The standard recommended sizes remain `1024x1024`, `1536x1024`, and `1024x1536`; resolutions above `2560x1440` are experimental.
  - **Meta Muse Image**: passed through the Responses API's `image_generation` tool; official cookbook examples include `1024x1024`, `1536x1024`, and `1024x1536`, but the field remains free-form for provider validation.
  - Omit `size` to use the model's own default (qwen-image-3.0 auto-picks from the prompt).
- `aspectRatio` / `imageSize` replace `size` for **Gemini** models (they have no pixel-size knob): `aspectRatio` is an enum from the model's vocabulary (10–14 values), `imageSize` an enum of the model's tiers (`1K`/`2K`/`4K`; hidden when the model is fixed at one tier, as `gemini-3.1-flash-lite-image` and `gemini-2.5-flash-image` are).
- `n` is model-specific and carries the model's documented ceiling in its description (Qwen 6, GPT Image 2/2.5 10). The extension enforces a universal maximum of 10 outputs per call. It is **hidden for Seedream and Meta Muse Image** — those APIs expose no count knob here, and direct callers are rejected if they request more than one output.
- `image` spells out the active model's documented reference-image contract in its description (formats, max count, per-image byte ceiling, dimension advice): qwen documents ≤ 3 images (JPG/JPEG/PNG/BMP/TIFF/WEBP/GIF, ≤ 10MB each), Seedream ≤ 10–14 (incl. HEIC/HEIF, ≤ 30MB), gpt-image-2 ≤ 16 (png/webp/jpg, ≤ 50MB), Gemini ≤ 3–14 (≤ 20MB), Meta Muse Image labels the extension's own recognized formats (PNG/JPEG/GIF/WEBP/BMP/TIFF/HEIC/HEIF) because the cookbook does not publish an exhaustive input contract. Provider-documented contracts remain advisory; the extension-wide 16-reference, 20MB-per-input, and 128MB-combined safety ceilings are enforced locally, and providers may enforce stricter rules.
- `quality` appears **only** for a **built-in gpt-image** route — the built-in OpenAI provider on `gpt-image-*`, or an OpenRouter route whose model id is gpt-image (e.g. `openrouter/openai/gpt-image-2`). GPT Image 2 and the verified Codex route use `low`/`medium`/`high`/`auto`; GPT Image 2.5 Flare and Sunburst additionally expose `xhigh` and `max`. It is **omitted from the schema entirely** for:
  - Gemini, DashScope/Qwen, Ark/Seedream, and Meta Muse Image — their image APIs have no `quality` field (Seedream varies quality by `size` resolution tier instead);
  - **non-gpt-image routes** on the OpenAI/OpenRouter wire — e.g. built-in `openai/dall-e-3` (which uses `standard`/`hd`) or an OpenRouter route to a non-OpenAI model like Seedream — because the enum above is gpt-image's vocabulary, not the wire format's; and
  - custom providers by default, including OpenAI-*compatible* ones — wire format alone does **not** imply a quality vocabulary. A custom model may opt in by explicitly declaring `capabilities.qualityValues`; this is honored only for the custom OpenAI/OpenRouter adapters that forward `quality`.

  If `defaultModel` is unset or misconfigured, `quality` stays present (the tool remains fully featured and `execute` surfaces a friendly config error). Use `"low"` for fast drafts and a higher level for final assets or dense text.

Advanced controls are also capability-gated:

- OpenAI API GPT Image routes expose `outputFormat`, `background`, `outputCompression`, and `mask`. The private Codex subscription route exposes `background` and forwards `auto`, `transparent`, or `opaque`; it returns PNG images and does not expose the other public-API controls. A mask requires an `image` edit target; transparent output requires PNG or WebP.
- Qwen Image 3 routes expose `negativePrompt`, `seed`, `promptEnhance`, `enableThinking`, and `watermark`.
- Seedream exposes `watermark` and `seriesMaxImages`. A series is a related set, not independent `n` variants.
- OpenRouter capability discovery caches the selected model's endpoint metadata for ten minutes and may add format, background, compression, seed, or negative-prompt controls. Discovery has a five-second deadline and safely falls back to the static/generic schema.
- Custom models may opt into the same fields through their `capabilities` declaration. Unsupported accepted parameters are rejected before a paid request rather than silently dropped.

Because the schema is fixed at registration, switching models via `/image-gen reload` re-registers the tool so the parameter set tracks the new provider.

**Non-destructive writes:** a saved file never overwrites an existing one. Two calls with `filename: "hero"` produce `hero.png` then `hero-v2.png`, so an earlier result is preserved rather than clobbered. Path reservation is atomic (`O_EXCL`): even many concurrent calls with the same `filename` each claim a distinct path — no two clobber each other.

### Tool result format

The tool's text result is shaped as ready-to-paste markdown the model can copy verbatim into its reply, so the UI renders the image inline:

```
Generated 1 image(s) via amaster (custom) (qwen-image-2.0). Show each one to the user as inline markdown — copy the lines below verbatim into your reply:

![white](/Users/.../white.png)
```

The `alt` text is the filename without its extension — i.e. whatever you passed as `filename`, or `<model>-<UTC-stamp>` if you didn't. When OpenAI returns a `revised_prompt`, it appears as a quote line under the image:

```
![beaver](/Users/.../beaver.png)
> revised prompt: a cute beaver, photorealistic, water droplets
```

The markdown URL is platform-shaped so any CommonMark host (desktop, TUI, CLI) keeps it intact: on macOS/Linux a bare absolute path — byte-identical unless it contains markdown-unsafe characters (whitespace, `#`, `?`, `%`, `()`, `<>`), which are percent-escaped; on Windows a percent-encoded `file:///…` URL (`![result](file:///C:/Users/.../result.png)`) — sanitizers such as react-markdown's `defaultUrlTransform` read `C:` as an unknown URI scheme and strip the img `src`. Independently of the markdown, `details.images[].path` always carries the raw filesystem path.

### Image-to-image / edit

`image` is always an array — pass `["path"]` for a single image, `["a", "b"]` for multi-image conditioning. Each entry must be:

- **Local file path** — a regular png/jpeg/gif/webp/bmp/tiff/heic/heif file inside the session cwd (the active model's accepted formats may be narrower — the `image` parameter description lists them). Paths may be absolute or relative, but symlinks and paths outside cwd are rejected.
- **Public http(s) URL** — private, loopback, link-local, metadata, credentialed, and unsafe redirect destinations are rejected.

Base64 strings and `data:` URIs are intentionally rejected — tool arguments don't survive megabyte-sized strings cleanly. If you have raw image bytes, write them to a file under the session cwd and pass that path.

**Iterating on a previous result:** pass the previous output path back. The next image is conditioned on the last one:

```
image_generate({ prompt: "a beaver chewing wood", filename: "beaver" })
  → /Users/.../.pi/images/beaver.png

image_generate({ prompt: "now in watercolor style", image: ["/Users/.../.pi/images/beaver.png"] })
  → /Users/.../.pi/images/gpt-image-2-20260605-...png  (edited)
```

Provider behavior:

| Provider | Image input route |
|---|---|
| OpenAI (`gpt-image-2`) | `POST /v1/images/edits` (multipart). Supports multi-image. |
| Gemini (`gemini-3-pro-image`, `gemini-3.1-flash-image`, `gemini-3.1-flash-lite-image`, `gemini-2.5-flash-image`) | `inline_data` parts prepended to the user message. Supports multi-image. |
| DashScope (`qwen-image-3.0-pro`, `qwen-image-3.0`, `qwen-image-2.0-pro`, `qwen-image-2.0`) | `image` parts in `messages[].content`. Up to 3 images. |
| Meta Muse Image (`muse-image-1.0`) | `POST /v1/responses` with `input_image` content parts. Supports multi-image composition. |
| OpenRouter | `POST /api/v1/images` with `input_references` JSON. Supports multi-image. |

There is intentionally no `model` parameter on the tool — the active route/model pair is fixed by `pi-image-gen.defaultProvider` and `pi-image-gen.defaultModel` in settings.

## Slash commands

- `/image-gen doctor` — validate the provider/model pair, authentication presence, timeout, custom-provider shapes, and output-directory writability without making a paid generation request or printing credentials.
- `/image-gen setup` — interactively choose a configured route and compatible model. Non-interactive hosts receive equivalent `/image-gen use` guidance.
- Command arguments provide completions for subcommands, routes, and known model ids.
- `/image-gen list` — show output directory, sprite status/defaults, default provider, default model, routes currently configured through API keys/Pi logins/custom settings, and every available provider/model route. OpenAI API vs Codex subscription and Meta API vs Meta subscription are separate entries. Listing login status never refreshes or retrieves an OAuth token.
- `/image-gen set provider <provider>` — persist only the default provider route. If the existing model is incompatible, the command warns so you can set the model next.
- `/image-gen set model <model>` — persist the model after validating it against the selected provider.
- `/image-gen use <provider> <model>` — validate and persist both atomically. This is the recommended switch command.
- `/image-gen reload` — re-read settings from disk and re-register the tool so its schema (e.g. whether `quality` is exposed) tracks the newly selected model.
- `/image-gen generate <prompt>` — generate an image directly from the command line using the active model. Reports the saved file path(s) as a plain-text notification (the command uses `ctx.ui.notify`, which shows a status line, not rendered Markdown — so unlike the tool result it does not emit an inline `![](…)` image). Use the `image_generate` tool from the agent when you want the image rendered inline.

Generation emits safe phase updates while loading inputs, waiting for the provider, and saving output. Escape cancellation and `requestTimeoutMs` propagate through provider requests and downloads. Paid generation POSTs are never retried automatically.

The three settings commands update `<cwd>/.pi/settings.json` only for a trusted project. They merge the `pi-image-gen` object without replacing unrelated settings and immediately re-register the tool; manual edits still require `/image-gen reload`.

## Bundled skill

This package ships an `image-gen` skill (`skills/image-gen/SKILL.md`) that Pi loads on demand. It carries the prompting playbook the one-line tool guidance can't hold: when to use raster generation vs repo-native SVG/CSS, generate-vs-edit intent, `n`-is-variants-not-assets, multi-image role labeling, edit invariants, text-in-image handling, and the labeled prompt schema. The tool works without it; the skill makes the model use the tool well.

The optional `sprite-gen` skill (`skills/sprite-gen/SKILL.md`) explains one-action sheet prompting, reference roles, grid/alpha constraints, validation limits, disabled-state guidance, and explicit retry behavior. The skill may remain discoverable while the tool is disabled; runtime activation is controlled by `spriteGeneration.enabled`.

## Acknowledgements

This standalone repository is derived from [`packages/pi-image-gen`](https://github.com/TGYD-helige/pi/tree/master/packages/pi-image-gen) in the TGYD-helige Pi extensions monorepo. Codex authentication and transport behavior was informed by [`pi-codex-image-gen`](https://github.com/crazygit/pi-codex-image-gen).

The optional sprite-generation workflow was inspired by and adapted from concepts in [`agent-sprite-forge`](https://github.com/0x0funky/agent-sprite-forge). Thank you to 0x0funky and its contributors for sharing their work.

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
