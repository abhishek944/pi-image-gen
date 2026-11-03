import type { Cost, ImageTokenUsage, ReportedUsage } from '../core/protocol.js';
import type { SpriteGenerationSettings } from '../sprite/types.js';
import type { GenerateImageParams, ImageDimensions, ImageModelCapabilities } from './image.js';
import type { ApiStyle, CustomApiStyle, CustomProviderAuth, ResolvedProvider } from './provider.js';

/** Provider identity is separate from wire format: Azure shares the OpenAI API. */
export type BuiltInProviderId = ApiStyle | 'azure-openai';

/** User-facing provider route. Authentication paths are intentionally distinct. */
export type BuiltInProviderRouteId =
  | 'openai-api'
  | 'azure-openai-api'
  | 'codex-subscription'
  | 'gemini-api'
  | 'dashscope-api'
  | 'openrouter-api'
  | 'ark-api'
  | 'meta-subscription'
  | 'meta-api'
  | 'mai-api';

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
  /** Authentication policy. Omitted values preserve the adapter's legacy default. */
  auth?: CustomProviderAuth;
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

export type ImageRouteSelection = { provider: string; model: string };

export type ImageGenSettings = {
  /** Namespace schema version. Missing/version 1 are legacy; version 2 is current. */
  version?: 1 | 2;
  /** Preferred default route; takes precedence over the two legacy keys in its layer. */
  default?: ImageRouteSelection;
  /** Ordered alternatives used only after a safely classified failure. */
  fallback?: ImageRouteSelection[];
  /** Explicit comparison targets; never used by ordinary generation. */
  compare?: ImageRouteSelection[];
  /** Authentication-specific provider route selected for the default model (legacy). */
  defaultProvider?: string;
  /** Legacy default model id. The tool does not accept arbitrary model overrides. */
  defaultModel?: string;
  /**
   * Where to write generated images. Relative paths resolve against the session cwd.
   * Default: `.pi/images`.
   */
  outputDir?: string;
  /** Request deadline in milliseconds. Default 120000; allowed 1000–900000. */
  requestTimeoutMs?: number;
  /** Best-effort OpenRouter endpoint capability discovery. Default true. */
  openRouterDiscovery?: boolean;
  /** Per-built-in-provider overrides keyed by provider id. */
  providers?: Partial<Record<BuiltInProviderId, BuiltInProviderOverride>>;
  /** User-defined custom providers keyed by provider name. */
  customProviders?: Record<string, CustomImageProvider>;
  /** Optional sprite-sheet generation and deterministic local processing. Disabled by default. */
  spriteGeneration?: SpriteGenerationSettings;
};

export type GenerationMetadata = {
  durationMs: number;
  requestId?: string;
  /** Legacy top-level numeric usage; use reportedUsage for nested cache details. */
  usage?: Record<string, number>;
  reportedUsage?: ReportedUsage;
  tokenUsage?: ImageTokenUsage;
  /** Legacy provider-reported scalar only; estimates are kept in costDetails. */
  cost?: number;
  costDetails?: Cost;
};

export type GeneratedImage = {
  /** Absolute path on disk where the image was saved. */
  path: string;
  /** Image MIME type, e.g. "image/png". */
  mimeType: string;
  /** Pass-through revised prompt if the provider returned one (e.g. OpenAI). */
  revisedPrompt?: string;
  dimensions?: ImageDimensions;
  /** Untouched provider original when path identifies a resized copy. */
  originalPath?: string;
  /** Resize failed locally; path still identifies the successfully saved original. */
  resizeError?: string;
};

export type ImageRouteAttempt = {
  route: ImageRouteSelection;
  status: 'success' | 'failed';
  error?: string;
};

export type ImageGenResult = {
  model: string;
  provider: string;
  images: GeneratedImage[];
  metadata?: GenerationMetadata;
  /** Present when configured fallback was exercised, including the successful route. */
  attempts?: ImageRouteAttempt[];
};

export type ImageCompareEntry =
  | { route: ImageRouteSelection; status: 'success'; result: ImageGenResult }
  | { route: ImageRouteSelection; status: 'failed' | 'cancelled'; error: string; partialImages?: GeneratedImage[] };

export type ImageCompareResult = { entries: ImageCompareEntry[] };
export type CompareImageParams = Pick<GenerateImageParams, 'prompt' | 'image' | 'filename' | 'outputDir'>;

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
  /** Sanitized fields explicitly declared by a custom model, before fallback inheritance. */
  declaredCapabilities?: Partial<ImageModelCapabilities>;
  /** True when `capabilities` inherits an official built-in registry contract. */
  capabilitiesIncludeRegistry?: boolean;
  /** True when a custom model explicitly declared its quality vocabulary. */
  customQualityValues?: boolean;
};
