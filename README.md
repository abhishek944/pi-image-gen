# pi-image-gen

Pi extension with image generation/editing (`image_generate`), optional sprite generation (`sprite_generate`), and **independent existing-image search** (`image_search`). Search has its own configuration and providers; it never generates images. See [Image search](#image-search) below.

Supported **generation** providers:

| Provider                       | Model id (alias)                              | Authentication        |
| ------------------------------ | --------------------------------------------- | --------------------- |
| ChatGPT Codex                  | `gpt-image-2` on route `codex-subscription` (`gpt-image-2-codex`, `codex`, and `openai-codex` remain legacy aliases) | Pi `/login` → ChatGPT Plus/Pro (Codex) |
| OpenAI                         | `gpt-image-2`, `gpt-image-2.5-flare`, `gpt-image-2.5-sunburst` | `OPENAI_API_KEY`      |
| Azure OpenAI | Azure GPT Image deployment name (`azure-openai-api`); GPT Image 1 / 1-mini / 1.5 / 2 / 2.5 Flare / Sunburst | `AZURE_OPENAI_API_KEY` |
| Google Gemini ("Nano Banana")  | `gemini-3-pro-image` (alias `nano-banana-pro`), `gemini-3.1-flash-image` (alias `nano-banana-2`), `gemini-3.1-flash-lite-image` (alias `nano-banana-2-lite`), `gemini-2.5-flash-image` (alias `nano-banana`) | `GEMINI_API_KEY` |
| Alibaba DashScope (Qwen-Image) | `qwen-image-3.0-pro`, `qwen-image-3.0`, `qwen-image-2.0-pro`, `qwen-image-2.0` | `DASHSCOPE_API_KEY`   |
| Volcengine Ark (ByteDance Seedream) | `doubao-seedream-5-0-pro-260628` (alias `seedream-5-pro`, retired id `doubao-seedream-5-0-pro-260128` still resolves), `doubao-seedream-5-0-260128` (aliases `seedream-5`, `seedream`; the same model also answers to `doubao-seedream-5-0-lite-260128` / `seedream-5-lite`), `doubao-seedream-4-5-251128` (alias `seedream-4-5`), `doubao-seedream-4-0-250828` (alias `seedream-4`) | `ARK_API_KEY`         |
| Meta Model API (Muse Image) | `muse-image-1.0` (aliases `muse-image`, `meta-muse`) | Pi `/login meta` via `pi-meta-oauth`, or `META_API_KEY` |
| Microsoft MAI (Azure Foundry) | Azure deployment name; MAI-Image-2.5 / Flash / Pro and MAI-Image-2.6 / Flash | `AZURE_MAI_API_KEY` |
| OpenRouter                     | any (use `openrouter/<vendor>/<id>`)          | `OPENROUTER_API_KEY`  |
| Custom providers               | whatever you declare in settings              | (your choice, via `$VAR`) |

Upstream API docs (handy when debugging gateway behavior or adding new models):

- OpenAI GPT Image — [generation guide](https://developers.openai.com/api/docs/guides/image-generation), [gpt-image-2](https://developers.openai.com/api/docs/models/gpt-image-2), [2.5 Flare](https://developers.openai.com/api/docs/models/gpt-image-2.5-flare), [2.5 Sunburst](https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst)
- Azure OpenAI — [image generation guide](https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/dall-e), [v1 preview REST endpoints](https://learn.microsoft.com/en-us/azure/foundry/openai/reference-preview-latest)
- Google Gemini image generation — [ai.google.dev/gemini-api/docs/image-generation](https://ai.google.dev/gemini-api/docs/image-generation)
- Alibaba Qwen-Image 3.0 (generation & editing) — [help.aliyun.com/zh/model-studio/qwen-image-generation-and-editing-api-reference](https://help.aliyun.com/zh/model-studio/qwen-image-generation-and-editing-api-reference)
- Alibaba DashScope Qwen-Image 2.0 (text-to-image) — [help.aliyun.com/zh/model-studio/qwen-image-api](https://help.aliyun.com/zh/model-studio/qwen-image-api)
- Alibaba DashScope Qwen-Image-Edit — [help.aliyun.com/zh/model-studio/qwen-image-edit-api](https://help.aliyun.com/zh/model-studio/qwen-image-edit-api)
- Volcengine Ark Seedream — [volcengine.com/docs/82379/1824121](https://www.volcengine.com/docs/82379/1824121)
- Microsoft MAI Image — [Azure Foundry generation and edits API](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/use-foundry-models-mai-image)
- Meta Muse Image cookbook — [github.com/meta-models/meta-model-cookbook/tree/main/05_muse_image](https://github.com/meta-models/meta-model-cookbook/tree/main/05_muse_image)
- OpenRouter image API — [openrouter.ai/docs/api/api-reference/images/create-images](https://openrouter.ai/docs/api/api-reference/images/create-images)

Built-in API-key routes read `providers.<id>.apiKey` in local `settings.json` first, then fall back to the environment variables shown above; they do not read keys saved by Pi's general `/login` flow. Subscription routes are separate: Meta can use a Pi credential created by the [`pi-meta-oauth`](https://github.com/BlockedPath/pi-meta-oauth) package, while Codex uses Pi's ChatGPT Plus/Pro login. Meta API billing also accepts `META_API_KEY`; legacy `MODEL_API_KEY` remains accepted.

For subscription-backed generation, first run `/login` in Pi and select **ChatGPT Plus/Pro (Codex)**, then run `/image-gen use codex-subscription gpt-image-2`. No `OPENAI_API_KEY` is required. Codex requests use the ChatGPT-backed image endpoints and count against provider-managed subscription usage and limits. GPT Image 2.5 is intentionally **not** listed on this route: its API model ids have not been verified against the private Codex subscription endpoint.

The primary route is configured in `settings.json` as `default: { provider, model }`. Optional `fallback` and `compare` arrays contain the same provider/model pairs. `image_generate` uses the default with selective fallback; `image_compare` runs only for explicit model comparisons. Neither tool accepts arbitrary model/provider arguments. Use `/image-gen use <provider> <model>` to update the default safely without changing either list.

## Install

From npm:

```sh
pi install npm:@abhishek944/pi-image-gen
```

Or directly from GitHub:

```sh
pi install git:github.com/abhishek944/pi-image-gen@v0.9.1
```

The package's `pi.extensions` field auto-registers the compiled `dist/extension.js` entry with the host pi-coding-agent runtime; no extra wiring needed.

### Use as a Node library

The npm package ships compiled ESM JavaScript and TypeScript declarations, so a normal Node 22 process can import the library without a TypeScript loader:

```js
import {
  generateImage,
  compareImages,
  runSpritePipeline,
} from '@abhishek944/pi-image-gen';
```

The package root is intentionally the lightweight library entry and does not load Pi-only runtime modules. Hosts that manually register the Pi extension instead of using the `pi.extensions` manifest can import its default export explicitly:

```js
import piImageGenExtension from '@abhishek944/pi-image-gen/extension';
```

## Configure

Settings are read by `pi-shared`'s `loadPiSettings`, which merges three files (low-to-high priority):

1. `~/.pi/agent/settings.json` (global)
2. The agent config directory's `settings.json` (`PI_CODING_AGENT_DIR`, then `PI_AGENT_HOME`, otherwise the global directory; duplicate paths are loaded once)
3. `<cwd>/.pi/settings.json` (trusted project)

Project settings are ignored when project trust is declined. `${ENV_VAR}` interpolation is supported in global and agent settings only, so keep environment-backed credentials out of project settings.

All settings live under the `pi-image-gen` key. New configurations should use `default` with an authentication-specific `provider` and `model` (the command below writes this for you):

```text
/image-gen use gemini-api nano-banana
```

```json
{
  "pi-image-gen": {
    "version": 2,
    "default": { "provider": "gemini-api", "model": "nano-banana" }
  }
}
```

The namespace schema version is **2**, independent of the npm package version. Unversioned and `version: 1` legacy configurations remain readable; unsupported versions are rejected rather than silently downgraded. Within one file, `default` wins over sibling legacy keys. Defaults are normalized per file before applying global < agent < trusted-project priority, so a higher legacy override still works when a lower file has already migrated. Complete defaults written by setup/use/set now contain `version: 2` and `default`, without obsolete legacy default keys. No startup operation rewrites files automatically.

…and exports the matching env var:

```sh
export GEMINI_API_KEY=sk-...
```

That's it. From the agent: `image_generate({ prompt: "a cyberpunk cat" })`.

### All settings fields

```json
{
  "pi-image-gen": {
    "version": 2,
    "default": { "provider": "gemini-api", "model": "nano-banana" },
    "fallback": [
      { "provider": "openai-api", "model": "gpt-image-2" }
    ],
    "compare": [
      { "provider": "gemini-api", "model": "nano-banana" },
      { "provider": "openai-api", "model": "gpt-image-2" }
    ],
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
| `version` | Namespace schema version. Current: `2`; missing/`1` are legacy-compatible. Unsupported versions are refused. |
| `default` | Preferred `{ provider, model }` pair. Provider is an authentication-specific route such as `openai-api`, `codex-subscription`, `gemini-api`, `meta-api`, `meta-subscription`, or a custom-provider id. |
| `fallback` | Ordered provider/model pairs for safely classified default-generation failures. Omitted/empty disables fallback. |
| `compare` | Provider/model pairs used only by explicit comparison requests. The default is not implicitly included. |
| `defaultProvider` | Legacy authentication-specific default route; used when `default` is absent. |
| `defaultModel` | Legacy model id or alias; ordinary generation needs this or a valid `default`. |
| `outputDir`       | Where to write generated images. Relative paths resolve against the session cwd. Default `.pi/images`. |
| `requestTimeoutMs` | End-to-end deadline including inputs and downloads. `1000`–`900000`; default `120000`. |
| `openRouterDiscovery` | Best-effort discovery of the selected OpenRouter model's supported parameters. Default `true`; failure falls back safely. |
| `providers`       | Per-built-in-provider override. Set `apiKey`, `baseUrl`, or `headers` to point at a proxy or non-standard env var. |
| `customProviders` | User-defined providers — see below. Built-in route ids such as `openai-api` and `meta-subscription` are reserved and cannot be shadowed. |
| `spriteGeneration` | Optional sprite-sheet processing settings. Disabled by default; see below. Invalid values fail closed to safe defaults. |

In global and agent settings, `apiKey`, `baseUrl`, and `headers` values support `$VAR` and `${VAR}` environment interpolation. Fallbacks require the braced form (for example, `${FOO:-default}`); `$FOO:-default` is not supported. Project settings keep all of these placeholders literal.

## Migrate existing settings to version 2

Load this extension version, then preview migration before applying it:

```text
/image-gen migrate --dry-run
/image-gen migrate
```

The default scope is `all`: global, agent and the trusted current project. Identical paths are handled once. To select one scope:

```text
/image-gen migrate --dry-run --scope project
/image-gen migrate --scope project
```

Other scopes are `global` and `agent`. Dry-run creates no backups, files or directories. Migration reports paths/statuses and field changes, never API keys or full settings contents.

Each existing JSON file is migrated **individually from its raw contents**, never from merged settings. Complete `defaultProvider`/`defaultModel` pairs become `default`; the old keys are removed and `version: 2` is written. Existing nested defaults retain precedence. Credentials, custom providers, sprites, fallback/compare lists, unrelated namespaces and literal environment placeholders are preserved. Missing fallback/compare arrays are not filled with empty arrays, because that could disable inherited lists.

A model-only default is inferred only when the same-file routing is unambiguous and isolated from other layers' defaults/custom providers. Ambiguous Meta auto-auth, layered defaults, environment-dependent model names, multiple candidate providers and provider-only partial defaults are left unchanged with guidance to add an explicit same-file pair. A skipped file does not stop other independently safe files from migrating; mixed legacy/v2 loading remains supported. Untrusted projects, invalid JSON, symlinks, non-regular files and unsupported versions are not rewritten.

Before replacing a changed file, migration creates a unique adjacent **private backup** named `settings.json.pi-image-gen-backup-<id>.bak` containing its original bytes. It then writes a same-directory temporary file and atomically renames it, preserving the original permissions. An intervening source edit stops replacement. Backups may contain credentials: keep them private, do not commit them, and inspect them before manually restoring. Backups are retained; no automatic rollback is performed. Each file is atomic, not the whole multi-file command. Already-current files are no-ops, and successful writes reload the extension settings.

## Image search

`image_search` finds **existing images** through Serper, Brave Search, SerpApi or Openverse. It is entirely separate from image generation: no generation models, credentials, default, fallback or compare routes are reused. It always downloads and validates candidates, returning usable local files plus source metadata. Optional `resize` saves exact-sized PNG copies. There is no URL-only mode or `download` flag. It never generates images.

Configure its separate **`pi-image-search`** namespace in `settings.json`:

```json
{
  "pi-image-search": {
    "default": { "provider": "serper" },
    "fallback": [
      { "provider": "brave" },
      { "provider": "serpapi" }
    ],
    "compare": [
      { "provider": "serper" },
      { "provider": "brave" },
      { "provider": "serpapi" },
      { "provider": "openverse" }
    ],
    "requestTimeoutMs": 30000,
    "providers": {
      "serper": { "apiKey": "${SERPER_API_KEY}" },
      "brave": { "apiKey": "${BRAVE_SEARCH_API_KEY}" },
      "serpapi": { "apiKey": "${SERPAPI_API_KEY}" }
    }
  }
}
```

The configuration follows the same **default + fallback + compare** pattern as generation. Search routes have only `provider`, not `model`, because these APIs search existing images rather than run generation models. Omit fallback/compare to disable them. No default is silently chosen, and a fallback list cannot repeat its default or another fallback provider.

| Search provider | Credential environment variable | Notes |
| --- | --- | --- |
| `serper` | `SERPER_API_KEY` | Google Images via Serper |
| `brave` | `BRAVE_SEARCH_API_KEY` | Independent image index; strict safe search |
| `serpapi` | `SERPAPI_API_KEY` | Google Images via SerpApi; safe search enabled |
| `openverse` | Optional `OPENVERSE_ACCESS_TOKEN` | Anonymous access works at lower limits; optional `apiKey` is an existing Bearer access token, not a client secret |

Search reads the same global, agent and trusted-project settings layers, but only its own namespace. Provider `apiKey` takes precedence over its environment variable. Environment placeholders expand only in global/agent settings, never in project settings. Keep keys out of committed project files. Unresolved placeholders are never sent as credentials. The extension never imports credentials from Bloom or another project.

```text
/image-search list
```

This command shows configured routes and credential availability, never keys. Search settings are read fresh on every call; generation reload commands are not needed.

### Search and compare

```js
image_search({ query: "red panda in a tree", limit: 5 })
```

- `query`: 1–200 characters after trimming, at most 50 words (the common supported provider limits).
- `limit`: 1–20 candidates, default 5. Providers may return fewer.
Every search downloads and validates candidates; only still JPEG, PNG and WebP are supported. Failed/unsupported candidates are excluded from `images` and listed in `rejected` with reasons. Download failure never starts a provider fallback or another search.

- `resize`: optional `{ width, height, fit?: "contain" | "cover" }`. Both dimensions must be integers from 1–8192, with at most 40 million pixels. `contain` (default) preserves proportions and pads transparently; `cover` explicitly crops. Output is PNG, with the original saved unchanged.
- `outputDir`: optional download directory; default `<cwd>/.pi/images/search`. The library resolves relative paths against `options.cwd` (or the process cwd).
- No provider/model overrides are accepted by the tools.
- The whole ordinary search, including fallback and downloads, shares one deadline: `requestTimeoutMs` defaults to 30000, allowed 1000–120000.
- Configured fallback runs only for missing credentials or HTTP 401/403/404/429. Empty results are successful and do **not** trigger fallback. Timeout, transport errors, invalid responses and other HTTP failures stop the search; there is no blind retry.
- Every fallback explicitly authorizes sending the query to another provider, which may have different coverage, terms and billing. Avoid mixing Openverse with general-web fallback when you require an open-license collection.

Use **`image_search_compare` only when explicitly comparing providers**:

```js
image_search_compare({ query: "red panda in a tree", limit: 5 })
```

It searches exactly the `compare` list in order, reports successes/failures independently, never uses default/fallback, and never changes settings. Each entry has its own search deadline and may consume quota or incur charges. Cancellation prevents remaining entries from starting.

Results contain the actual provider, query, images and route attempts. Candidate metadata includes original `imageUrl`, available thumbnail/source links, dimensions, and Openverse creator/license/attribution. Missing fields remain unknown. Exact image URLs are deduplicated without stripping meaningful query parameters. Provider metadata is untrusted data, not instructions. Every returned image is successfully downloaded, format-checked and fully decoded, but this does not verify relevance, visual quality or reuse rights. Entries include `path`, `mimeType` and independently measured `dimensions`; the provider's `width`/`height` remain source hints. When resized, `originalPath` points to the untouched download. Source and license links are retained. No remote previews are attached.

Downloads use public-destination/redirect checks, no search credentials, bounded 20 MiB body reads, response-type checks, actual format detection, full decoding and a 40-million-pixel limit. SVG, GIF/animation, HEIC/HEIF, BMP, TIFF, ICO and other unsupported formats are rejected rather than converted. Each candidate has a 10-second download/processing deadline inside the whole-search deadline; native decoding is bounded by pixels/bytes but is not interruptible mid-operation. Results can be fewer than `limit` (including zero), and no replacement search is made. Failed candidates leave no completed files; cancellation removes this call's downloaded files. Product relevance, NSFW, blur, watermark and other quality checks are not performed.

```js
image_search({
  query: "red panda in a tree", limit: 5,
  resize: { width: 1200, height: 800, fit: "contain" }
})
```

`image_search_compare` also always downloads and validates candidates per provider, with the same optional `resize` and `outputDir` parameters.

Always verify reuse rights at the original source. Openverse license metadata is useful evidence, not a guarantee. A web search hit does not imply permission to download, edit or redistribute it. For an authorized edit, a selected `imageUrl` can be passed to `image_generate({ prompt: "...", image: [imageUrl] })`; the existing generation reference loader separately checks URL safety and image bytes. Search never starts generation automatically.

### Independent search library

The separate package entry does not import generation or Pi runtime modules:

```js
import { searchImages, compareImageSearches } from '@abhishek944/pi-image-gen/search';

const settings = {
  default: { provider: 'serper' },
  fallback: [{ provider: 'brave' }],
  compare: [{ provider: 'serper' }, { provider: 'openverse' }],
};
const result = await searchImages({ query: 'red panda', limit: 5 }, { settings });
// Explicit comparison only:
const comparison = await compareImageSearches({ query: 'red panda', limit: 5 }, { settings });
```

Both functions accept an optional `signal` in the options. `loadImageSearchSettings(cwd, projectTrusted)` loads search settings explicitly for library hosts. The settings-only `/durable` entry additionally registers native `image_search` and `image_search_compare` tools from explicit search settings; this Node search entry itself does not claim a portable runtime.

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

## Azure OpenAI image deployments

Use `azure-openai-api` for Azure-hosted GPT Image models. It is separate from public OpenAI API billing, the Codex subscription route, and Azure MAI. No credential falls back to those other providers.

```sh
export AZURE_OPENAI_API_KEY="your-azure-resource-key"
```

In `~/.pi/agent/settings.json` (or agent settings):

```json
{
  "pi-image-gen": {
    "defaultProvider": "azure-openai-api",
    "defaultModel": "your-image-deployment",
    "providers": {
      "azure-openai": {
        "baseUrl": "https://your-resource.openai.azure.com/openai/v1"
      }
    }
  }
}
```

Set `defaultModel` to the **Azure deployment name**, not necessarily the catalog model name. Select it in Pi with `/image-gen use azure-openai-api your-image-deployment`.

- Credentials: `providers.azure-openai.apiKey` first, then local `AZURE_OPENAI_API_KEY`. You can use `${AZURE_OPENAI_API_KEY}` in global/agent settings; project settings do not interpolate environment placeholders. The built-in route sends the key in `api-key` and rejects redirects; it does not read Pi `/login` credentials or refresh Entra tokens.
- Endpoint: `providers.azure-openai.baseUrl` first, then local `AZURE_OPENAI_ENDPOINT`. An HTTPS resource root, `/openai/v1` base, or full v1 `/images/generations` or `/images/edits` URL is accepted. No userinfo, query parameters, fragments, project path, or legacy deployment-scoped URL is accepted. Only configure an endpoint you trust: credentials are sent there.
- Requests use the existing OpenAI image API wire format: JSON generations and multipart edits, both with `?api-version=preview`. The integration does not call the legacy `/openai/deployments/...` API and requires no Azure SDK.
- Catalog profiles: `gpt-image-1`, `gpt-image-1-mini`, `gpt-image-1.5`, `gpt-image-2`, `gpt-image-2.5-flare`, `gpt-image-2.5-sunburst`. These only work when deployed in your resource. Arbitrary deployment names are passed through unchanged and receive common GPT Image control advice rather than a guessed model version. Catalog-named deployments receive their known quality/size profile. DALL-E 3 is retired and is not advertised.
- Supports generation, reference-image editing, masks, quality, PNG/JPEG output, background and JPEG compression controls. Microsoft's image guide excludes WebP output for Azure; direct OpenAI's formats are unchanged. Model-specific options and numeric limits remain Azure's authority. GPT Image 2.5 profiles expose `xhigh` and `max` in addition to the common quality values. This extension keeps its existing 20MB-per-input and 128MB-combined safety ceilings.

See [Microsoft's image generation guide](https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/dall-e) for regional/model access and deployment requirements.

## Microsoft MAI on Azure Foundry

Use the `mai-api` route. Set `defaultModel` to **your Azure deployment name**, not necessarily the model's catalog name. MAI has no shared default endpoint: configure the resource endpoint explicitly.

```sh
export AZURE_MAI_API_KEY="your-azure-resource-key"
```

In `~/.pi/agent/settings.json` (or your agent settings):

```json
{
  "pi-image-gen": {
    "defaultProvider": "mai-api",
    "defaultModel": "your-mai-deployment",
    "providers": {
      "mai": {
        "baseUrl": "https://your-resource.services.ai.azure.com/mai/v1"
      }
    }
  }
}
```

Optionally set `providers.mai.apiKey` to a credential or `${AZURE_MAI_API_KEY}` in global/agent settings. A nonblank settings key takes precedence over `AZURE_MAI_API_KEY`; otherwise the environment variable is read directly. Environment placeholders are not expanded in project settings. Credentials are sent to the configured endpoint, so use a trusted resource or gateway.

A resource-root URL also works: the adapter adds `/mai/v1`. Do not include `/images/generations`, `/images/edits`, query parameters, or a project endpoint path. Requests use the `api-key` header and reject redirects. The built-in route does not use Pi `/login` or refresh Entra credentials.

After loading the updated extension, select the deployment with:

```text
/image-gen use mai-api your-mai-deployment
```

Microsoft's current documented catalog (all preview, Global Standard):

| Catalog model | Deployment version |
| --- | --- |
| `MAI-Image-2.5` | `2026-06-02` |
| `MAI-Image-2.5-Flash` | `2026-06-02` |
| `MAI-Image-2.5-Pro` | `2026-06-19` |
| `MAI-Image-2.6` | `2026-07-31` |
| `MAI-Image-2.6-Flash` | `2026-07-31` |

The version is selected when deploying in Azure; it is not a generation-request setting. Arbitrary deployment names (including older deployments) are passed through unchanged. Catalog-named deployments receive the known model's size advice; arbitrary deployment names receive family-level guidance without guessing their version.

- Text-to-image: `POST /mai/v1/images/generations`; `size: "1024x1024"` becomes integer `width` and `height`. Each dimension must be at least 768. MAI 2.5 permits at most 1,048,576 total pixels; MAI 2.6 permits at most 2,359,296. The provider enforces the deployed model's numeric limits.
- Editing: `POST /mai/v1/images/edits` with multipart form data and repeated `image` fields. Current documented models accept up to five PNG/JPEG references. **Omit `size` for edits**; the documented edits API has no width/height control. Older deployments may not support edits.
- Output is a base64-encoded PNG, saved through the existing image pipeline. No `n` greater than 1, `quality`, `background`, mask, output-format/compression, or seed controls are exposed. PNG output does not guarantee transparency; the sprite pipeline still requires real alpha.
- MAI 2.6-specific `auto_aspect_ratio` and `web_grounding` controls are not exposed by this integration.

See [Microsoft's MAI image API reference](https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/use-foundry-models-mai-image) for availability, quotas, and current preview limitations.

## Custom providers

Use `customProviders` for anything not built in: a self-hosted Stable Diffusion, an internal corp gateway, a third-party image API. The shape mirrors [pi.dev's custom-provider docs](https://pi.dev/docs/latest/custom-provider).

Each custom provider declares:

| Field      | Required | Notes                                                                                |
| ---------- | -------- | ------------------------------------------------------------------------------------ |
| `api` | yes      | One of `openai`, `gemini`, `dashscope`, `openrouter`, `ark`, `meta`, `mai`. Picks the image-API wire shape. |
| `baseUrl`  | no       | API endpoint URL; defaults to the selected `api` adapter's built-in endpoint when omitted, except `mai`, which requires a resource-specific URL. Environment interpolation follows the settings-file rules above. |
| `apiKey`   | usually  | Credential string. `$VAR` syntax supported. Required for `bearer` and `header` authentication. |
| `auth`     | no       | `{ "type": "bearer" }`, `{ "type": "header", "header": "x-api-key" }`, or explicit `{ "type": "none" }`. Omission preserves the adapter's legacy default (Gemini uses `x-goog-api-key`, MAI uses `api-key`; the others use bearer). |
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

> Note: pi.dev custom providers also have an `api` field, but its values (`openai-completions`, `anthropic-messages`, …) are LLM streaming formats that don't apply to image generation. The values here (`openai`, `gemini`, `dashscope`, `openrouter`, `ark`, `meta`, `mai`) are image-API wire shapes — same field name, different namespace.

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
  scaleStrategy: "fit",
  componentMode: "largest",
  format: "apng",
  frameDurationMs: 120,
  filename: "courier-run"
})
```

Six frames default to a 2×3 grid. `frameCount` must equal `rows × columns`, subject to the configured `maxFrames` and a hard maximum of 16. Supported output formats are `png` (a static normalized sprite sheet), `apng` (the default animation), `webp` (a lossless animation with transparency), and `frames` (the existing PNG-frame option). Set `spriteGeneration.defaultFormat` in settings or override it with `format` on a call. All formats preserve the PNG sheet and individual PNG frames. APNG and WebP require at least two frames; use `format: "png"` or `"frames"` for a single sprite. GIF is intentionally not advertised because it reduces alpha and color fidelity. Model-aware `size`, `aspectRatio`, `imageSize`, and `quality` controls appear only when the configured route supports them.

Processing controls:

- `align`: `feet`, `bottom`, or `center`. Defaults to `feet` for characters and props, or `center` for `fx`, `spell`, `projectile`, and `impact` assets.
- `scaleStrategy`: `fit` (default) applies one shared scale to fit all frames; `preserve` keeps the source scale unless a shared reduction is needed to prevent clipping.
- `componentMode`: `largest` favors the main connected subject; `all` preserves meaningful detached components. Defaults to `all` for the effect asset types above and `largest` otherwise.
- `frameDurationMs`: an integer from 20 to 10000; defaults to the configured value (120 ms).
- `strictValidation`: overrides the configured validation mode for this call.
- `outputDir`: overrides the sprite output root. Relative paths must stay inside the session cwd and must not contain symlinks; absolute roots are also supported.

The generated sheet must be a readable PNG with usable alpha, and its width and height must divide evenly by the grid's columns and rows. Explicit pixel sizes are checked for grid divisibility before generation. The pipeline requests PNG and a transparent background when the active model advertises those controls; routes without them must still return a suitable sheet. Sprite generation enforces the active model's reference-image count, unlike the advisory model counts on `image_generate`.

Each call reserves a new run directory and never overwrites an earlier run:

```text
.pi/images/sprites/courier-run/
├── prompt-used.txt
├── raw-sheet.png
├── sheet-transparent.png
├── frames/frame-01.png ... frame-06.png
├── animation.apng           # animation.webp for WebP; absent for png/frames
└── pipeline-meta.json
```

WebP encoding uses the Sharp dependency locally; it does not make another provider request. The encoder verifies decoded pixels, frame order, timing, and infinite looping before saving the animation. If native encoder loading or verification fails, PNG assets are preserved and the result reports `webp-encoding`.

Strict validation prevents animation approval when required checks fail, while preserving the raw sheet and any safe processed artifacts. Advisory mode can accept bounded quality warnings, but structural failures such as empty cells or missing alpha still reject the sequence. Local checks cannot prove identity, costume, anatomy, or acting quality; inspect those visually before shipping.

## Tool: `image_generate`

```ts
image_generate({
  prompt: string,                  // required — what to draw or how to edit
  image?: string[],                // optional — array of file paths or http(s) URLs
  n?: number,                      // per-model ceiling; hidden for Codex, Seedream, and Meta
  size?: string,                   // per-model form (see below); hidden for Gemini models
  aspectRatio?: string,            // Gemini models only — enum from the model's vocabulary
  imageSize?: string,              // Gemini tier enum; 3.1 Flash also exposes "512px"
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
  resize?: { width: number, height: number, fit?: 'contain'|'cover' }, // local PNG copy
  filename?: string,               // filename prefix (no extension)
  outputDir?: string,              // override settings.outputDir for this call
})
```

Returns the absolute file path(s) of saved images. Files land in `outputDir` (default `<cwd>/.pi/images`), filename pattern `<filename or model-UTC-stamp>.<ext>`. Result details also include elapsed time, a sanitized provider request id when available, and decoded output dimensions. Accounting preserves nested provider counters in `metadata.reportedUsage` (including cached-token details), plus normalized disjoint `metadata.tokenUsage` buckets when the API's semantics are known: `input` excludes `cacheRead` and `cacheWrite`, and `output` includes billable output tokens. Missing counters are not invented from image dimensions.

Optional desktop `resize` is local postprocessing, not a provider control: `size`, `aspectRatio` and `imageSize` still select the provider's native output. Resize uses the same 1–8192-edge / 40-million-pixel contract as search and supports still JPEG/PNG/WebP inputs, producing an exact-sized PNG copy. `contain` pads transparently and preserves the whole image; `cover` crops. The returned image `path` identifies the derivative, and `originalPath` identifies the untouched provider original. Resizing runs after successful original storage, with a separate processing timeout using the configured generation timeout value. If local resizing fails, times out or is cancelled, the original is returned with `resizeError`; do not automatically regenerate paid output. Without `resize`, existing format/output behavior is unchanged. This local option is not exposed by `image_compare`, the portable core or Durable APIs.

`metadata.costDetails` uses a valid provider-reported cost first (including zero). Otherwise it uses `pi-ai.calculateCost` only when a trusted registry adapter supplies an exact, endpoint-matched image model, explicitly attests `costCompatibility: 'complete-four-bucket-token-pricing'`, and sufficient token usage is available; otherwise cost is `unknown`. Stock Pi catalog entries do not provide this attestation: their numeric rates alone may omit image fees or use default zeros, so they are not automatically treated as complete image prices. Calculated costs are labeled estimates, not provider charges. There are no local price tables, pixel/quality token estimates, or gateway-estimate fallbacks. GPT Image's separate text/image input rates cannot be represented by Pi's four-rate calculator and therefore do not use this fallback. Older Pi registries without image-model lookup still support generation and provider-reported costs, but cannot supply calculated costs.

Legacy `metadata.usage` retains top-level numeric counters, and legacy numeric `metadata.cost` remains provider-reported only. Use `reportedUsage`, `tokenUsage` and `costDetails` for full accounting. Image and sprite tool summaries display these fields; costs are per provider request, never multiplied by the number of images.

**The schema is model-aware.** Every built-in model carries a capability contract sourced from official API docs or clearly labeled extension safety limits, and the tool is registered with parameters shaped by that contract (on session start, and again after `/image-gen reload`) — so the agent sees exactly the knobs the active model honors, with documented values in enums and descriptions where available. Provider-specific numeric contracts (size ranges, `n` ceilings, and reference-image counts) are generally **advice, not a gate** because a self-hosted deployment or gateway may legitimately differ. Independently, the extension enforces universal safety ceilings of 16 references, 20MB per input, and 128MB combined, plus rejects parameter combinations an adapter would otherwise silently drop. Providers may enforce stricter limits.

- `size` follows the model's documented form:
  - **Qwen** (`qwen-image-*`): `"<width>*<height>"` (asterisk, e.g. `"2048*2048"`), total pixels 512²–2048²; 3.0 models additionally cap aspect ratio at 1:8–8:1. The x-form is normalized automatically as a safety net.
  - **Seedream** (`doubao-seedream-*`): a tier token from the model's list (`1K`/`1.5K`/`2K`/`3K`/`4K`) **or** an explicit `"<w>x<h>"` within the model's pixel window (2K floor on 5.0/4.5).
  - **Codex subscription (`gpt-image-2`)**: the tool exposes `"auto"`, `"1024x1024"`, `"1536x1024"`, and `"1024x1536"`, not the public OpenAI API's arbitrary-size range.
  - **OpenAI API `gpt-image-2`**: `"auto"` or `"<w>x<h>"` — arbitrary sizes allowed (both edges divisible by 16, ratio ≤ 3:1, 655,360–8,294,400 px, longest edge ≤ 3840), beyond the standard `1024x1024`/`1536x1024`/`1024x1536`.
  - **GPT Image 2.5 Flare/Sunburst**: the same arbitrary `"<w>x<h>"` range as GPT Image 2 (multiples of 16, ratio 1:3–3:1, 655,360–8,294,400 px, longest edge ≤ 3840), plus `"auto"`. The standard recommended sizes remain `1024x1024`, `1536x1024`, and `1024x1536`; resolutions above `2560x1440` are experimental.
  - **Meta Muse Image**: passed through the Responses API's `image_generation` tool; official cookbook examples include `1024x1024`, `1536x1024`, and `1024x1536`, but the field remains free-form for provider validation.
  - Omit `size` to use the model's own default (qwen-image-3.0 auto-picks from the prompt).
- `aspectRatio` / `imageSize` replace `size` for **Gemini** models (they have no pixel-size knob): `aspectRatio` is an enum from the model's vocabulary (10–14 values), `imageSize` an enum of the model's tiers. Gemini 3 Pro exposes `1K`/`2K`/`4K`; Gemini 3.1 Flash also exposes `512px` (the exact upstream literal remains pending live verification). The field is hidden for fixed-resolution models: Gemini 3.1 Flash Lite is fixed at `1K`, and Gemini 2.5 Flash has no tier control.
- `n` is model-specific and carries the model's documented ceiling in its description (Qwen 6, GPT Image 2/2.5 10). The extension enforces a universal maximum of 10 outputs per call. It is **hidden for Codex, Seedream, and Meta Muse Image** — those routes expose no count knob here, and direct callers are rejected if they request more than one output.
- `image` spells out the active model's documented reference-image contract in its description (formats, max count, per-image byte ceiling, dimension advice): qwen documents ≤ 3 images (JPG/JPEG/PNG/BMP/TIFF/WEBP/GIF, ≤ 10MB each), Seedream ≤ 10–14 (incl. HEIC/HEIF, ≤ 30MB), OpenAI API gpt-image-2 ≤ 16 (png/webp/jpg, ≤ 50MB), Codex ≤ 5 (PNG/WEBP/JPEG, ≤ 20MB), Gemini ≤ 3–14 (≤ 20MB), Meta Muse Image labels the extension's own recognized formats (PNG/JPEG/GIF/WEBP/BMP/TIFF/HEIC/HEIF) because the cookbook does not publish an exhaustive input contract. Provider-documented contracts remain advisory; the extension-wide 16-reference, 20MB-per-input, and 128MB-combined safety ceilings are enforced locally, and providers may enforce stricter rules.
- `quality` appears **only** for a **built-in gpt-image** route — the built-in OpenAI provider on `gpt-image-*`, or an OpenRouter route whose model id is gpt-image (e.g. `openrouter/openai/gpt-image-2`). GPT Image 2 and the verified Codex route use `low`/`medium`/`high`/`auto`; GPT Image 2.5 Flare and Sunburst additionally expose `xhigh` and `max`. It is **omitted from the schema entirely** for:
  - Gemini, DashScope/Qwen, Ark/Seedream, and Meta Muse Image — their image APIs have no `quality` field (Seedream varies quality by `size` resolution tier instead);
  - **non-gpt-image routes** on the OpenAI/OpenRouter wire — e.g. built-in `openai/dall-e-3` (which uses `standard`/`hd`) or an OpenRouter route to a non-OpenAI model like Seedream — because the enum above is gpt-image's vocabulary, not the wire format's; and
  - custom providers by default, including OpenAI-*compatible* ones — wire format alone does **not** imply a quality vocabulary. A custom model may opt in by explicitly declaring `capabilities.qualityValues`; this is honored only for the custom OpenAI/OpenRouter adapters that forward `quality`.

  If `defaultModel` is unset or misconfigured, `quality` stays present (the tool remains fully featured and `execute` surfaces a friendly config error). Use `"low"` for fast drafts and a higher level for final assets or dense text.

Advanced controls are also capability-gated:

- OpenAI API GPT Image routes expose `outputFormat`, `background`, `outputCompression`, and `mask`. The private Codex subscription route exposes `background` and forwards `auto`, `transparent`, or `opaque`; it returns PNG images and does not expose the other public-API controls. A mask requires an `image` edit target; transparent output requires PNG or WebP.
- Qwen Image 3 routes expose `negativePrompt`, `seed`, `promptEnhance`, `enableThinking`, and `watermark`.
- Seedream exposes `watermark`; supported non-Pro models also expose `seriesMaxImages` (1–10). Seedream 5.0 Pro does not support series output. A series is a related set, not independent `n` variants.
- OpenRouter capability discovery caches the selected model's endpoint metadata for ten minutes and may add format, background, compression, seed, or negative-prompt controls. Discovery has a five-second deadline and safely falls back to the static/generic schema.
- Custom models may opt into the same fields through their `capabilities` declaration. Unsupported accepted parameters are rejected before a paid request rather than silently dropped.

Because the schema is fixed at registration, switching models via `/image-gen reload` re-registers the tool so the parameter set tracks the new provider.

**Non-destructive writes:** a saved file never overwrites an existing one. Two calls with `filename: "hero"` produce `hero.png` then `hero-v2.png`, so an earlier result is preserved rather than clobbered. Path reservation is atomic (`O_EXCL`): even many concurrent calls with the same `filename` each claim a distinct path — no two clobber each other.

### Tool result format

`image_generate` includes native image attachments so image-capable Pi clients can show previews directly beneath the tool call, without waiting for the agent's reply. The first four outputs are eligible for previews, each fitted within 1024×1024 pixels and 384 KiB of base64 (at most 1.5 MiB across four previews). These are display copies only: saved originals, file paths, and result metadata stay unchanged. Vision-capable models can also inspect the attachments, so previews may add image input usage to subsequent model requests. Missing, unreadable, or unresizable previews are skipped without failing generation. Clients without inline image rendering can still use the saved paths and Markdown links. The `/image-gen generate` command continues to report paths through a text notification.

The tool's text result is still shaped as ready-to-paste markdown the model can copy verbatim into its reply, so the UI renders the image inline:

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
| OpenAI (`gpt-image-2`, GPT Image 2.5 Flare/Sunburst and their snapshots) | `POST /v1/images/edits` (multipart). Supports multi-image and optional masks. |
| ChatGPT Codex subscription (`gpt-image-2`) | `POST /backend-api/codex/images/edits` with JSON `images` entries. The model contract documents up to 5 references. |
| Gemini (`gemini-3-pro-image`, `gemini-3.1-flash-image`, `gemini-3.1-flash-lite-image`, `gemini-2.5-flash-image`) | `inline_data` parts prepended to the user message. Supports multi-image. |
| DashScope (`qwen-image-3.0-pro`, `qwen-image-3.0`, `qwen-image-2.0-pro`, `qwen-image-2.0`) | `image` parts in `messages[].content`. Up to 3 images. |
| Volcengine Ark (Seedream) | `POST /api/v3/images/generations` with an `image` array in the JSON body. Supports multi-image; no separate edits endpoint. |
| Meta Muse Image (`muse-image-1.0`) | `POST /v1/responses` with `input_image` content parts. Supports multi-image composition. |
| OpenRouter | `POST /api/v1/images` with `input_references` JSON. Supports multi-image. |

There is intentionally no `model` parameter on the tool. The primary route comes from `default` (or legacy `defaultProvider`/`defaultModel`); configured fallbacks are the only automatic alternatives.

## Default, fallback and explicit comparison

Ordinary `image_generate` and library `generateImage()` use the default, followed by `fallback` entries in order only after a missing/unusable credential (including a missing or expired Pi image login before generation) or an explicit generation HTTP **401, 404 or 429**. Each selected route is attempted once; the same failed route is not automatically retried. The successful result reports the actual provider/model and, when fallback was exercised, the attempted routes. Duplicate resolved route/model pairs are rejected before generation. A legacy model-only Meta default must be made explicit (`meta-api` or `meta-subscription`) before adding the same Meta model under another authentication route.

No automatic fallback occurs after **403/policy refusal, 400/422, 5xx, timeout, network/disconnection, cancellation, malformed output, image-download failure or storage failure**. Such outcomes either need correction or may already have consumed quota. Fallback can cross billing providers only because those pairs were explicitly configured. Every candidate uses its own capabilities; incompatible explicit controls stop the chain rather than being silently dropped. For example, a mask or pixel size supported by the default may not work on a Gemini fallback. Use shared controls or omit provider-specific controls when cross-provider fallback is important. Sprite generation keeps its one-request contract and does not use fallback.

Use **`image_compare`** only when the user explicitly asks to compare models, or run `/image-gen compare <prompt>`. It uses exactly the entries in `compare`, without fallback/substitution and without changing the default. Each entry is a separate potentially billable generation. One failure does not delete other successful images, and cancellation prevents subsequent entries from starting. Comparison results are labeled by the selected provider/model and retain per-entry duration, usage, cost, original paths and bounded native previews. Missing cost remains unknown; there is no invented combined charge.

The comparison tool accepts `prompt`, optional `image` references, `filename` and `outputDir`. To avoid pretending different providers share size/quality semantics, it uses each model's native defaults rather than exposing default-model-specific controls. Mixed-provider comparisons may therefore return different dimensions. The library exports `compareImages(params, options)` with the same small control set. The portable core keeps its single-route execution contract. The settings-only native Durable entry exposes the same fallback-backed `image_generate` and the `compare`-list `image_compare` (without per-call `outputDir`), plus `sprite_generate` only when `spriteGeneration.enabled` is true; it adds no hidden routes beyond the supplied settings.

## Slash commands

- `/image-gen migrate [--dry-run] [--scope all|global|agent|project]` — migrate raw settings files to schema version 2 with private backups and atomic replacement. Default scope is `all`; no automatic migration occurs at startup.
- `/image-gen doctor` — validate the config version, provider/model pair, authentication presence, timeout, custom-provider shapes, and output-directory writability without making a paid generation request or printing credentials.
- `/image-gen setup` — interactively choose a configured route and compatible model. Non-interactive hosts receive equivalent `/image-gen use` guidance.
- Command arguments provide completions for subcommands, routes, and known model ids.
- `/image-gen list` — show output directory, sprite status/defaults, default provider, default model, fallback/compare lists, routes currently configured through API keys/Pi logins/custom settings, and every available provider/model route. OpenAI API vs Codex subscription and Meta API vs Meta subscription are separate entries. Listing login status never refreshes or retrieves an OAuth token.
- `/image-gen set provider <provider>` — update the default provider, preserving its current model and synchronizing the new/legacy settings shapes. If the existing model is incompatible, the command warns so you can set the model next.
- `/image-gen set model <model>` — persist the model after validating it against the selected provider.
- `/image-gen use <provider> <model>` — validate and persist both atomically. This is the recommended switch command.
- `/image-gen reload` — re-read settings from disk and re-register the tool so its schema (e.g. whether `quality` is exposed) tracks the newly selected model.
- `/image-gen generate <prompt>` — generate an image directly from the command line using the active model. Reports the saved file path(s) as a plain-text notification (the command uses `ctx.ui.notify`, which shows a status line, not rendered Markdown — so unlike the tool result it does not emit an inline `![](…)` image). Use the `image_generate` tool from the agent when you want the image rendered inline.

- `/image-gen compare <prompt>` — explicitly generate with every configured comparison pair and report labeled per-route results. Use `image_compare` from the agent for native previews.

Generation emits safe phase updates while loading inputs, waiting for the provider, and saving output. Escape cancellation and `requestTimeoutMs` propagate through provider requests and downloads. Each route keeps its own request deadline. Paid POSTs are never blindly retried; only the explicitly configured fallback policy above can authorize another route after a classified rejection.

The three settings commands update `<cwd>/.pi/settings.json` only for a trusted project. They merge the `pi-image-gen` object without replacing unrelated settings and immediately re-register the tool; manual edits still require `/image-gen reload`.

## Bundled skill

This package ships an `image-gen` skill (`skills/image-gen/SKILL.md`) that Pi loads on demand. It carries the prompting playbook the one-line tool guidance can't hold: when to use raster generation vs repo-native SVG/CSS, generate-vs-edit intent, `n`-is-variants-not-assets, multi-image role labeling, edit invariants, text-in-image handling, and the labeled prompt schema. The tool works without it; the skill makes the model use the tool well.

The optional `sprite-gen` skill (`skills/sprite-gen/SKILL.md`) explains one-action sheet prompting, reference roles, grid/alpha constraints, validation limits, disabled-state guidance, and explicit retry behavior. The skill may remain discoverable while the tool is disabled; runtime activation is controlled by `spriteGeneration.enabled`.

## Acknowledgements

This standalone repository is derived from [`packages/pi-image-gen`](https://github.com/TGYD-helige/pi/tree/master/packages/pi-image-gen) in the TGYD-helige Pi extensions monorepo. Codex authentication and transport behavior was informed by [`pi-codex-image-gen`](https://github.com/crazygit/pi-codex-image-gen).

The optional sprite-generation workflow was inspired by and adapted from concepts in [`agent-sprite-forge`](https://github.com/0x0funky/agent-sprite-forge). Thank you to 0x0funky and its contributors for sharing their work.

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
