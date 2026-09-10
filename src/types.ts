export type ApiStyle =
  | 'openai'
  | 'gemini'
  | 'dashscope'
  | 'openrouter'
  | 'ark'
  | 'meta'
  | 'codex';
export type CustomApiStyle = Exclude<ApiStyle, 'codex'>;

/** Built-in provider id. Currently 1:1 with ApiStyle. */
export type BuiltInProviderId = ApiStyle;

/** User-facing provider route. Authentication paths are intentionally distinct. */
export type BuiltInProviderRouteId =
  | 'openai-api'
  | 'codex-subscription'
  | 'gemini-api'
  | 'dashscope-api'
  | 'openrouter-api'
  | 'ark-api'
  | 'meta-subscription'
  | 'meta-api';

/** A user-defined image-generation provider. */
export type CustomImageProvider = {
  /**
   * Image-API wire shape this provider speaks. Determines which adapter
   * is used to call it. Required. Codex is deliberately excluded because its
   * OAuth token may only be sent to the fixed ChatGPT endpoint.
   *
   * Note: this is NOT the same as pi.dev custom providers' `api` field — pi.dev's
   * values (`openai-completions`, `anthropic-messages`, ...) are LLM streaming
   * formats. The values here are image-generation API shapes.
   */
  api: CustomApiStyle;
  /** Override the API base URL. Optional; defaults to the api's default. */
  baseUrl?: string;
  /**
   * API key. User and agent settings support `$ENV_VAR` and `${ENV_VAR}` syntax.
   * Required unless the api does not need one.
   */
  apiKey?: string;
  /** Optional display name. */
  name?: string;
  /** Extra headers merged into every outbound request. */
  headers?: Record<string, string>;
  /** Models routed through this provider. Each entry is a model id (string) or an object. */
  models?: Array<string | CustomImageModel>;
};

export type CustomImageModel = {
  /** Model id sent to the provider (e.g. "qwen-image-2.0"). */
  id: string;
  /** Optional alias the agent / user can refer to. Defaults to id. */
  alias?: string;
  /** Optional display name. */
  name?: string;
  /**
   * Capability declaration driving the tool schema and pre-flight validation.
   * Every field is optional; omitted fields fall back to the built-in registry
   * entry of the same id when one exists, else to the generic (unconstrained)
   * schema. Mirrors pi-video-gen's custom-model capability inheritance.
   */
  capabilities?: Partial<ImageModelCapabilities>;
};

/** Per-built-in-provider override (api key, base url, custom headers). */
export type BuiltInProviderOverride = {
  apiKey?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
};

export type ImageGenSettings = {
  /** Authentication-specific provider route selected for the default model. */
  defaultProvider?: string;
  /** Default model id when the tool call does not pass `model`. */
  defaultModel?: string;
  /**
   * Where to write generated images. Relative paths resolve against the session cwd.
   * Default: `.pi/images`.
   */
  outputDir?: string;
  /** Per-built-in-provider overrides keyed by provider id. */
  providers?: Partial<Record<BuiltInProviderId, BuiltInProviderOverride>>;
  /** User-defined custom providers keyed by provider name. */
  customProviders?: Record<string, CustomImageProvider>;
};

export type GenerateImageParams = {
  prompt: string;
  /**
   * Optional reference / input images for image-to-image, editing, style
   * transfer, or character preservation. Each entry MUST be either:
   *   - an absolute or relative file path on the local filesystem, or
   *   - an http(s) URL.
   *
   * `data:` URIs and raw base64 strings are intentionally rejected — tool
   * arguments don't survive megabyte-sized strings cleanly across providers.
   * If you have raw image bytes, write them to a file first.
   */
  image?: string[];
  /** Number of images to generate. Default 1. */
  n?: number;
  /** Image size hint (e.g. "1024x1024"). Provider may ignore. */
  size?: string;
  /**
   * Gemini-style aspect ratio (e.g. "16:9"). Only honored when the active
   * model's capabilities declare `aspectRatios` (Gemini image models have no
   * pixel-size knob); rejected by validation otherwise.
   */
  aspectRatio?: string;
  /**
   * Gemini-style size tier (e.g. "2K"). Only honored when the active model's
   * capabilities declare `imageSizes`; rejected by validation otherwise.
   */
  imageSize?: string;
  /**
   * Quality hint (e.g. "low" | "medium" | "high" | "auto" for OpenAI gpt-image).
   * Provider-specific: forwarded on OpenAI-shaped providers, ignored by adapters
   * that don't expose a quality knob.
   */
  quality?: string;
  /** Output filename prefix. */
  filename?: string;
  /** Override settings.outputDir for this call. */
  outputDir?: string;
};

/** Materialized reference image, ready for adapters to encode. */
export type ResolvedImageInput = {
  bytes: Uint8Array;
  mimeType: string;
};

export type GeneratedImage = {
  /** Absolute path on disk where the image was saved. */
  path: string;
  /** Image MIME type, e.g. "image/png". */
  mimeType: string;
  /** Pass-through revised prompt if the provider returned one (e.g. OpenAI). */
  revisedPrompt?: string;
};

export type ImageGenResult = {
  model: string;
  provider: string;
  images: GeneratedImage[];
};

/** Resolved provider entry: either a built-in or a custom one. */
export type ResolvedProvider = {
  /** Provider key as referenced by the user (e.g. "openai", "my-stable-diffusion"). */
  id: string;
  api: ApiStyle;
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  /** Authentication behavior selected by a user-facing provider route. */
  authMode?: 'auto' | 'oauth' | 'api-key';
  /** Display label. */
  name: string;
  /** True for built-in providers (openai/gemini/dashscope/openrouter). */
  builtIn: boolean;
};

/** Result of resolving a model string to a provider + remote model id. */
export type ResolvedModel = {
  provider: ResolvedProvider;
  /** The id passed to the remote provider. */
  remoteId: string;
  /** The id the user asked for (alias or remoteId). */
  requestedId: string;
  /**
   * The model's capability contract, when known (built-in registry entry or a
   * custom model inheriting/overriding one). Absent for slash-routed and
   * catch-all custom models — callers must fall back to the generic schema and
   * skip capability validation.
   */
  capabilities?: ImageModelCapabilities;
  /** True when a custom model explicitly declared its quality vocabulary. */
  customQualityValues?: boolean;
};

/**
 * Per-model capability contract, sourced from official provider docs (the
 * registry in models.ts quotes the values). Drives the tool schema shape at
 * registration time and pre-flight validation before any paid call — mirrors
 * pi-video-gen's `VideoModelCapabilities`.
 */
export type ImageModelCapabilities = {
  /**
   * Discrete allowed `size` values (DALL·E-style fixed lists). Mutually
   * exclusive with `sizeRange`; when present, `size` is a string enum.
   */
  sizes?: string[];
  /** Range-based `size` validation for "<width><sep><height>" pixel strings. */
  sizeRange?: {
    /** Separator the provider's API expects: qwen uses "*", everyone else "x". */
    separator: 'x' | '*';
    /** Tier tokens accepted instead of a pixel string (Seedream: "1K"/"2K"/…). */
    tiers?: string[];
    /** The literal "auto" is accepted (model picks the size; gpt-image-2). */
    allowAuto?: boolean;
    /** Inclusive total-pixel (width × height) bounds. */
    minArea: number;
    maxArea: number;
    /** Inclusive width/height ratio bounds. */
    minRatio?: number;
    maxRatio?: number;
    /** Both dimensions must be divisible by this (gpt-image-2: 16). */
    divisibleBy?: number;
    /** Longest-edge ceiling in px (gpt-image-2: 3840). */
    maxEdge?: number;
  };
  /**
   * Gemini-style aspect-ratio vocabulary. Its presence means the model has NO
   * pixel-size knob: the schema hides `size` and exposes `aspectRatio` instead.
   */
  aspectRatios?: string[];
  /**
   * Gemini-style `imageSize` tiers (e.g. ["1K","2K","4K"]). A single entry
   * means a fixed tier — the param is hidden from the schema. Absent means the
   * model has no tier knob at all (gemini-2.5-flash-image is fixed at 1024px).
   */
  imageSizes?: string[];
  /** Model-specific quality vocabulary when the provider exposes a quality knob. */
  qualityValues?: string[];
  /** Max images per request via `n`. 1 = the model has no count knob; `n` is hidden. */
  nMax: number;
  /** Whether nMax comes from provider docs or a conservative extension ceiling. */
  nMaxSource?: 'provider' | 'extension';
  /** Max reference images per request. */
  maxReferenceImages: number;
  /** Accepted reference-image formats as display labels (e.g. "PNG", "JPEG"). */
  inputFormats: string[];
  /** Per-reference-image byte ceiling. */
  inputMaxBytes: number;
  /** Whether reference count/format/byte values come from provider docs or local safety limits. */
  referenceLimitsSource?: 'provider' | 'extension';
  /**
   * Documented advisory for reference-image dimensions (e.g. "both dimensions
   * between 384 and 2048 px"). Surfaced in the `image` param description only —
   * it is a provider recommendation, never hard-validated.
   */
  inputDimAdvice?: string;
};

/** Adapter interface implemented by each api shape. */
export type ImageProviderAdapter = {
  generate(
    provider: ResolvedProvider,
    remoteModelId: string,
    params: GenerateImageParams,
    fetchImpl: typeof fetch,
    signal?: AbortSignal,
    inputs?: ResolvedImageInput[],
    runtime?: ImageProviderRuntime,
  ): Promise<RawImageResult[]>;
};

/** Narrow Pi model-registry contract used to resolve subscription OAuth. */
export type ImageModelRegistry = {
  getAvailable(): Array<{ id: string; provider: string; baseUrl?: string }>;
  /** Resolve the active provider credential, including OAuth refresh when configured. */
  getApiKeyForProvider?(provider: string): Promise<string | undefined>;
  /** Report whether a concrete provider model is currently backed by OAuth. */
  isUsingOAuth?(model: { id: string; provider: string; baseUrl?: string }): boolean;
  getApiKeyAndHeaders(model: {
    id: string;
    provider: string;
    baseUrl?: string;
  }): Promise<{
    ok: boolean;
    apiKey?: string;
    headers?: Record<string, string>;
    error?: string;
  }>;
};

export type ImageProviderRuntime = {
  modelRegistry?: ImageModelRegistry;
};

export type RawImageResult = {
  /** Either base64 PNG bytes or a URL to fetch. */
  data: { kind: 'base64'; bytes: string; mimeType?: string } | { kind: 'url'; url: string };
  revisedPrompt?: string;
};
