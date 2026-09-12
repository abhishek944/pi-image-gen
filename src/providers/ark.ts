import { describeNetworkError, missingKeyError } from '../errors.js';
import { toDataUri } from '../image-input.js';
import type {
  GenerateImageParams,
  ImageProviderAdapter,
  RawImageResult,
  ResolvedImageInput,
  ResolvedProvider,
} from '../types.js';
import { withDefaultPath } from '../url.js';
import { credentialRedirectMode, hasProviderAuthentication, jsonHeaders, parseImagesResponse } from './openai.js';

/**
 * Volcengine Ark image generation (ByteDance Seedream series).
 *
 *   POST /api/v3/images/generations
 *
 * OpenAI-shaped request + response (model/prompt/n/size, data[].url|b64_json),
 * with one twist: reference images for image-to-image / multi-image conditioning
 * go into the same JSON body as `image: [<data-uri>, ...]` — NOT a multipart
 * /images/edits call. So we reuse openai's parser but build our own body.
 *
 * Docs: https://www.volcengine.com/docs/82379/1824121
 */
export const arkAdapter: ImageProviderAdapter = {
  async generate(
    provider: ResolvedProvider,
    remoteModelId: string,
    params: GenerateImageParams,
    fetchImpl: typeof fetch,
    signal?: AbortSignal,
    inputs?: ResolvedImageInput[],
  ): Promise<RawImageResult[]> {
    if (!hasProviderAuthentication(provider)) {
      throw missingKeyError(provider);
    }
    const base = withDefaultPath(provider.baseUrl, '/api/v3');
    const url = `${base}/images/generations`;
    const body: Record<string, unknown> = {
      model: remoteModelId,
      prompt: params.prompt,
      // Seedream's watermark switch defaults to true, stamping an "AI 生成"
      // badge in the corner — opt out explicitly.
      watermark: params.watermark ?? false,
    };
    if (params.size) body.size = params.size;
    if (params.seriesMaxImages != null) {
      body.sequential_image_generation = 'auto';
      body.sequential_image_generation_options = { max_images: params.seriesMaxImages };
    }
    // Seedream sizing is driven by `size` resolution tiers (1K/2K/4K), not an
    // OpenAI-style `quality` knob — forwarding `quality` here risks a 400, so we
    // intentionally drop it. See README provider table. The same applies to `n`:
    // related multi-image output uses the separately named and capability-gated
    // sequential_image_generation mechanism exposed as seriesMaxImages.
    if (inputs && inputs.length > 0) {
      body.image = inputs.map((input) => toDataUri(input));
    }

    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: jsonHeaders(provider),
        body: JSON.stringify(body),
        signal: signal ?? null,
        redirect: credentialRedirectMode(provider),
      });
    } catch (error) {
      throw describeNetworkError(error, provider);
    }
    return parseImagesResponse(res, url, provider);
  },
};
