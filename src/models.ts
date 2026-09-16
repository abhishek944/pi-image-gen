import type { ApiStyle, BuiltInProviderId, ImageModelCapabilities } from './types.js';

/**
 * Built-in known image models. Maps a model id (or alias) to its built-in
 * provider. Custom providers may add or override entries via settings.
 */
export type BuiltInModelEntry = {
  id: string;
  aliases?: string[];
  provider: BuiltInProviderId;
  /** Remote model id sent to the provider (defaults to id). */
  remoteId?: string;
  /**
   * The model's capability contract — drives the tool schema (which params
   * exist, their enums/patterns) and pre-flight validation before any paid
   * call. Every built-in entry must declare one (enforced by the registry
   * test); custom models may inherit it by id (see config.ts).
   */
  capabilities?: ImageModelCapabilities;
};

// Format vocabularies shared by several entries (display labels; the input
// layer maps sniffed MIME types onto these, see image-input.ts).
const QWEN_INPUT_FORMATS = ['JPG', 'JPEG', 'PNG', 'BMP', 'TIFF', 'WEBP', 'GIF'];
const SEEDREAM_INPUT_FORMATS = ['JPEG', 'PNG', 'WEBP', 'BMP', 'TIFF', 'GIF', 'HEIC', 'HEIF'];
const GEMINI_INPUT_FORMATS = ['PNG', 'JPEG', 'WEBP', 'HEIC', 'HEIF'];
const META_INPUT_FORMATS = ['PNG', 'JPEG', 'GIF', 'WEBP', 'BMP', 'TIFF', 'HEIC', 'HEIF'];

// Contract fragments shared by sibling entries.
const SEEDREAM_DIM_ADVICE =
  'reference images: each dimension > 14 px, aspect ratio 1/16–16, total pixels ≤ 6000x6000';
const QWEN3_SIZE_RANGE: NonNullable<ImageModelCapabilities['sizeRange']> = {
  // 3.0 adds a hard 1:8–8:1 aspect-ratio cap; size omitted = model picks.
  separator: '*',
  minArea: 512 * 512,
  maxArea: 2048 * 2048,
  minRatio: 1 / 8,
  maxRatio: 8,
};

const MB = 1024 * 1024;

// Gemini aspect-ratio vocabularies per https://ai.google.dev/gemini-api/docs/image-generation
// (2026-08): the classic 10, and the 3.1 set adding extreme ratios.
const GEMINI_ASPECTS_10 = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'];
const GEMINI_ASPECTS_14 = [
  '1:1',
  '1:4',
  '1:8',
  '2:3',
  '3:2',
  '3:4',
  '4:1',
  '4:3',
  '4:5',
  '5:4',
  '8:1',
  '9:16',
  '16:9',
  '21:9',
];

/**
 * Capability values reflect the official provider docs as of 2026-08 and are
 * PENDING live verification where noted:
 * - gpt-image-2: https://developers.openai.com/api/docs/guides/image-generation
 * - Gemini: https://ai.google.dev/gemini-api/docs/image-generation
 * - Qwen 3.0: https://help.aliyun.com/zh/model-studio/qwen-image-generation-and-editing-api-reference
 * - Qwen 2.0: https://help.aliyun.com/zh/model-studio/qwen-image-api (+ qwen-image-edit-api)
 * - Seedream: https://www.volcengine.com/docs/82379/1824121 (+ /1666946)
 */
export const BUILT_IN_MODELS: BuiltInModelEntry[] = [
  // ChatGPT-backed Codex Images. This is intentionally a distinct model alias:
  // selecting it opts into subscription usage instead of silently replacing
  // OpenAI developer-API billing when OPENAI_API_KEY is absent.
  {
    id: 'gpt-image-2-codex',
    aliases: ['codex', 'openai-codex'],
    provider: 'codex',
    remoteId: 'gpt-image-2',
    capabilities: {
      sizes: ['auto', '1024x1024', '1536x1024', '1024x1536'],
      qualityValues: ['low', 'medium', 'high', 'auto'],
      backgroundValues: ['auto', 'transparent', 'opaque'],
      nMax: 1,
      maxReferenceImages: 5,
      inputFormats: ['PNG', 'WEBP', 'JPEG'],
      inputMaxBytes: 20 * MB,
    },
  },

  // OpenAI image generation. gpt-image-2 accepts arbitrary WxH beyond the
  // standard sizes: both edges divisible by 16, ratio ≤ 3:1, total pixels
  // 655,360–8,294,400, longest edge ≤ 3840; "auto" lets the model pick.
  // Reference images: png/webp/jpg, ≤ 50MB each, up to 16.
  {
    id: 'gpt-image-2',
    provider: 'openai',
    capabilities: {
      sizeRange: {
        separator: 'x',
        allowAuto: true,
        minArea: 655_360,
        maxArea: 8_294_400,
        minRatio: 1 / 3,
        maxRatio: 3,
        divisibleBy: 16,
        maxEdge: 3840,
      },
      qualityValues: ['low', 'medium', 'high', 'auto'],
      outputFormats: ['png', 'jpeg', 'webp'],
      backgroundValues: ['auto', 'transparent', 'opaque'],
      supportsOutputCompression: true,
      supportsMask: true,
      nMax: 10,
      maxReferenceImages: 16,
      inputFormats: ['PNG', 'WEBP', 'JPEG'],
      inputMaxBytes: 50 * MB,
    },
  },

  // GPT Image 2.5 adds xhigh/max and supports the same arbitrary-size range
  // documented for GPT Image 2. The Images API publishes n=1..10. Reference
  // metadata stays on conservative extension ceilings where the checked docs
  // do not publish a narrower model-specific edit-input contract.
  ...([
    'gpt-image-2.5-flare',
    'gpt-image-2.5-flare-2026-09-08',
    'gpt-image-2.5-sunburst',
    'gpt-image-2.5-sunburst-2026-09-08',
  ] as const).map((id) => ({
    id,
    provider: 'openai' as const,
    capabilities: {
      sizeRange: {
        separator: 'x' as const,
        allowAuto: true,
        minArea: 655_360,
        maxArea: 8_294_400,
        minRatio: 1 / 3,
        maxRatio: 3,
        divisibleBy: 16,
        maxEdge: 3840,
      },
      qualityValues: ['low', 'medium', 'high', 'xhigh', 'max', 'auto'],
      outputFormats: ['png', 'jpeg', 'webp'] as Array<'png' | 'jpeg' | 'webp'>,
      backgroundValues: ['auto', 'transparent', 'opaque'] as Array<'auto' | 'transparent' | 'opaque'>,
      supportsOutputCompression: true,
      supportsMask: true,
      nMax: 10,
      maxReferenceImages: 16,
      inputFormats: ['PNG', 'WEBP', 'JPEG'],
      inputMaxBytes: 20 * MB,
      referenceLimitsSource: 'extension' as const,
    },
  })),

  // Meta Muse Image via the Meta Model API Responses endpoint. The official
  // cookbook demonstrates square, landscape, and portrait output sizes and
  // multiple reference images. Input metadata below is an extension safety
  // contract rather than an asserted provider limit. Requests are stateless in this
  // extension; callers iterate by passing the previous output as an input image.
  {
    id: 'muse-image-1.0',
    aliases: ['muse-image', 'meta-muse'],
    provider: 'meta',
    capabilities: {
      // Meta's public cookbook demonstrates these sizes but does not publish an
      // exhaustive enum, so size stays a free-form provider-validated string.
      nMax: 1,
      maxReferenceImages: 16,
      inputFormats: META_INPUT_FORMATS,
      inputMaxBytes: 20 * MB,
      referenceLimitsSource: 'extension',
    },
  },

  // Google Gemini "Nano Banana" image generation. Gemini has no pixel-size
  // knob — output shape is aspectRatio + imageSize tier (uppercase "K").
  // Per https://ai.google.dev/gemini-api/docs/image-generation:
  //   Nano Banana Pro      → gemini-3-pro-image
  //   Nano Banana 2        → gemini-3.1-flash-image
  //   Nano Banana 2 Lite   → gemini-3.1-flash-lite-image
  //   Nano Banana          → gemini-2.5-flash-image
  // Input formats PNG/JPEG/WEBP/HEIC/HEIF; inline requests cap at 20MB total.
  {
    id: 'gemini-3-pro-image',
    aliases: ['nano-banana-pro'],
    provider: 'gemini',
    capabilities: {
      aspectRatios: GEMINI_ASPECTS_10,
      imageSizes: ['1K', '2K', '4K'],
      nMax: 8,
      maxReferenceImages: 14,
      inputFormats: GEMINI_INPUT_FORMATS,
      inputMaxBytes: 20 * MB,
    },
  },
  {
    id: 'gemini-3.1-flash-image',
    aliases: ['nano-banana-2'],
    provider: 'gemini',
    capabilities: {
      aspectRatios: GEMINI_ASPECTS_14,
      // The 512px tier is documented for 3.1 Flash — PENDING live verification
      // of the exact literal ("512px" vs "0.5K").
      imageSizes: ['512px', '1K', '2K', '4K'],
      nMax: 8,
      maxReferenceImages: 14,
      inputFormats: GEMINI_INPUT_FORMATS,
      inputMaxBytes: 20 * MB,
    },
  },
  {
    id: 'gemini-3.1-flash-lite-image',
    aliases: ['nano-banana-2-lite'],
    provider: 'gemini',
    capabilities: {
      aspectRatios: GEMINI_ASPECTS_14,
      imageSizes: ['1K'], // fixed at 1K — the schema hides imageSize entirely
      nMax: 8,
      maxReferenceImages: 14,
      inputFormats: GEMINI_INPUT_FORMATS,
      inputMaxBytes: 20 * MB,
    },
  },
  {
    id: 'gemini-2.5-flash-image',
    aliases: ['nano-banana'],
    provider: 'gemini',
    capabilities: {
      aspectRatios: GEMINI_ASPECTS_10,
      // No imageSize knob — fixed 1024px output. Works best with ≤ 3 inputs.
      nMax: 8,
      maxReferenceImages: 3,
      inputFormats: GEMINI_INPUT_FORMATS,
      inputMaxBytes: 20 * MB,
    },
  },

  // Alibaba Qwen-Image series via DashScope (sync multimodal-generation).
  // Size is "<width>*<height>" (asterisk, NOT "x"); total pixels must stay
  // between 512*512 and 2048*2048. Reference images: JPG/JPEG/PNG/BMP/TIFF/
  // WEBP/GIF, ≤ 10MB each, up to 3. Output is always PNG.
  ...(['qwen-image-3.0-pro', 'qwen-image-3.0'] as const).map((id) => ({
    id,
    provider: 'dashscope' as const,
    capabilities: {
      sizeRange: QWEN3_SIZE_RANGE,
      supportsNegativePrompt: true,
      supportsSeed: true,
      supportsPromptEnhance: true,
      supportsThinking: true,
      supportsWatermark: true,
      nMax: 6,
      maxReferenceImages: 3,
      inputFormats: QWEN_INPUT_FORMATS,
      inputMaxBytes: 10 * MB,
      inputDimAdvice: 'reference images work best with both dimensions between 384 and 2048 px',
    },
  })),
  {
    id: 'qwen-image-2.0-pro',
    provider: 'dashscope',
    capabilities: {
      // No aspect-ratio cap is documented for the 2.0 series (unlike 3.0).
      sizeRange: { separator: '*', minArea: 512 * 512, maxArea: 2048 * 2048 },
      nMax: 6,
      maxReferenceImages: 3,
      inputFormats: QWEN_INPUT_FORMATS,
      inputMaxBytes: 10 * MB,
      inputDimAdvice: 'reference images work best with both dimensions between 384 and 3072 px',
    },
  },
  {
    id: 'qwen-image-2.0',
    provider: 'dashscope',
    capabilities: {
      sizeRange: { separator: '*', minArea: 512 * 512, maxArea: 2048 * 2048 },
      nMax: 6,
      maxReferenceImages: 3,
      inputFormats: QWEN_INPUT_FORMATS,
      inputMaxBytes: 10 * MB,
      inputDimAdvice: 'reference images work best with both dimensions between 384 and 3072 px',
    },
  },

  // ByteDance Seedream via Volcengine Ark. `size` takes EITHER a tier token
  // (model-specific list) OR an explicit "<w>x<h>" pixel string — never mix
  // forms. The `seedream` alias points at the latest stable Seedream release.
  // Docs: https://www.volcengine.com/docs/82379/1824121
  //
  // Registry note (2026-08): the current docs list 5.0 pro as -260628 (the
  // older -260128 id no longer appears) and treat doubao-seedream-5-0-260128
  // and doubao-seedream-5-0-lite-260128 as the SAME model — hence the merged
  // entry below. The retired ids stay as aliases so existing configs resolve.
  {
    id: 'doubao-seedream-5-0-pro-260628',
    aliases: ['seedream-5-pro', 'doubao-seedream-5-0-pro-260128'],
    provider: 'ark',
    capabilities: {
      // 5.0 pro accepts 1K/1.5K/2K tiers; pixel range 1280x720–2048x2048-class.
      // Unlike the non-Pro 5.0 model, Pro does not support related series output.
      supportsWatermark: true,
      sizeRange: {
        separator: 'x',
        tiers: ['1K', '1.5K', '2K'],
        minArea: 921_600,
        maxArea: 4_624_220,
        minRatio: 1 / 16,
        maxRatio: 16,
      },
      nMax: 1, // no count knob — sequential_image_generation is not exposed
      maxReferenceImages: 10,
      inputFormats: SEEDREAM_INPUT_FORMATS,
      inputMaxBytes: 30 * MB,
      inputDimAdvice: SEEDREAM_DIM_ADVICE,
    },
  },
  {
    id: 'doubao-seedream-5-0-260128',
    aliases: ['seedream-5', 'seedream', 'doubao-seedream-5-0-lite-260128', 'seedream-5-lite'],
    provider: 'ark',
    capabilities: {
      // 5.0 (lite): 2K floor — 1K pixel sizes fail with InvalidParameter.
      supportsWatermark: true,
      supportsSeries: true,
      sizeRange: {
        separator: 'x',
        tiers: ['2K', '3K', '4K'],
        minArea: 3_686_400,
        maxArea: 16_777_216,
        minRatio: 1 / 16,
        maxRatio: 16,
      },
      nMax: 1,
      maxReferenceImages: 14,
      inputFormats: SEEDREAM_INPUT_FORMATS,
      inputMaxBytes: 30 * MB,
      inputDimAdvice: SEEDREAM_DIM_ADVICE,
    },
  },
  {
    id: 'doubao-seedream-4-5-251128',
    aliases: ['seedream-4-5'],
    provider: 'ark',
    capabilities: {
      supportsWatermark: true,
      supportsSeries: true,
      sizeRange: {
        separator: 'x',
        tiers: ['2K', '4K'],
        minArea: 3_686_400,
        maxArea: 16_777_216,
        minRatio: 1 / 16,
        maxRatio: 16,
      },
      nMax: 1,
      maxReferenceImages: 14,
      inputFormats: SEEDREAM_INPUT_FORMATS,
      inputMaxBytes: 30 * MB,
      inputDimAdvice: SEEDREAM_DIM_ADVICE,
    },
  },
  {
    id: 'doubao-seedream-4-0-250828',
    aliases: ['seedream-4'],
    provider: 'ark',
    capabilities: {
      // 4.0 is the only Seedream that still accepts 1K-class pixel sizes.
      supportsWatermark: true,
      supportsSeries: true,
      sizeRange: {
        separator: 'x',
        tiers: ['1K', '2K', '4K'],
        minArea: 921_600,
        maxArea: 16_777_216,
        minRatio: 1 / 16,
        maxRatio: 16,
      },
      nMax: 1,
      maxReferenceImages: 14,
      inputFormats: SEEDREAM_INPUT_FORMATS,
      inputMaxBytes: 30 * MB,
      inputDimAdvice: SEEDREAM_DIM_ADVICE,
    },
  },
];

/** Resolve a model id or alias against the built-in registry. */
export function findBuiltInModel(idOrAlias: string): BuiltInModelEntry | undefined {
  return BUILT_IN_MODELS.find(
    (entry) => entry.id === idOrAlias || entry.aliases?.includes(idOrAlias),
  );
}

export const DEFAULT_BASE_URL: Record<BuiltInProviderId, string> = {
  openai: 'https://api.openai.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
  dashscope: 'https://dashscope.aliyuncs.com/api/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  ark: 'https://ark.cn-beijing.volces.com/api/v3',
  meta: 'https://api.meta.ai/v1',
  codex: 'https://chatgpt.com/backend-api/codex/images',
};

export const DEFAULT_API_STYLE: Record<BuiltInProviderId, ApiStyle> = {
  openai: 'openai',
  gemini: 'gemini',
  dashscope: 'dashscope',
  openrouter: 'openrouter',
  ark: 'ark',
  meta: 'meta',
  codex: 'codex',
};

export const ENV_VARS: Partial<Record<BuiltInProviderId, string>> = {
  openai: 'OPENAI_API_KEY',
  gemini: 'GEMINI_API_KEY',
  dashscope: 'DASHSCOPE_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  ark: 'ARK_API_KEY',
  meta: 'META_API_KEY',
};

export const PROVIDER_DISPLAY_NAME: Record<BuiltInProviderId, string> = {
  openai: 'OpenAI',
  gemini: 'Google Gemini',
  dashscope: 'Alibaba DashScope',
  openrouter: 'OpenRouter',
  ark: 'Volcengine Ark',
  meta: 'Meta Model API',
  codex: 'ChatGPT Plus/Pro (Codex)',
};
