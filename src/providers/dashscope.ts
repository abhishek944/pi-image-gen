import { SIZE_PIXEL_RE } from '../capabilities.js';
import {
  describeNetworkError,
  ImageGenError,
  missingKeyError,
  providerLogLabel,
  readBodyText,
  throwHttpError,
} from '../errors.js';
import { classifyImageOutput, MAX_GENERATED_IMAGES, toDataUri } from '../image-input.js';
import type {
  GenerateImageParams,
  ImageProviderAdapter,
  RawImageResult,
  ResolvedImageInput,
  ResolvedProvider,
} from '../types.js';
import { withDefaultPath } from '../url.js';

/**
 * Alibaba DashScope text-to-image (Qwen-Image series). Sync only:
 *
 *   POST /services/aigc/multimodal-generation/generation
 *   One request, one response, image URLs / bytes inline.
 *
 * The legacy async task endpoint (text2image/image-synthesis) is not used —
 * it doesn't accept reference images and the supported models there are old.
 */

/**
 * DashScope wants "<width>*<height>" (asterisk). The tool schema tells the
 * model so, but normalize defensively anyway — a stale prompt, a hand-written
 * /image-gen call, or a custom gateway can still produce the x-form, and the
 * API rejects it with a bare InvalidParameter.
 */
function normalizeDashScopeSize(size: string): string {
  const trimmed = size.trim();
  const match = SIZE_PIXEL_RE.exec(trimmed);
  return match ? `${match[1]}*${match[2]}` : trimmed;
}

export const dashscopeAdapter: ImageProviderAdapter = {
  async generate(
    provider: ResolvedProvider,
    remoteModelId: string,
    params: GenerateImageParams,
    fetchImpl: typeof fetch,
    signal?: AbortSignal,
    inputs?: ResolvedImageInput[],
  ): Promise<RawImageResult[]> {
    if (!provider.apiKey) {
      throw missingKeyError(provider);
    }
    const base = withDefaultPath(provider.baseUrl, '/api/v1');
    const headers: Record<string, string> = {
      authorization: `Bearer ${provider.apiKey}`,
      'content-type': 'application/json',
    };
    if (provider.headers) Object.assign(headers, provider.headers);

    const userContent: Array<{ text?: string; image?: string }> = [];
    for (const input of inputs ?? []) {
      userContent.push({ image: toDataUri(input) });
    }
    userContent.push({ text: params.prompt });

    let res: Response;
    try {
      res = await fetchImpl(`${base}/services/aigc/multimodal-generation/generation`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: remoteModelId,
          input: { messages: [{ role: 'user', content: userContent }] },
          parameters: {
            n: params.n ?? 1,
            // Defaults to false upstream today, but pass it explicitly so a
            // flipped default can't start stamping "Qwen-Image" badges.
            watermark: false,
            ...(params.size ? { size: normalizeDashScopeSize(params.size) } : {}),
          },
        }),
        signal: signal ?? null,
      });
    } catch (error) {
      throw describeNetworkError(error, provider);
    }
    // Status first (body-free), then read: a broken/cancelled body is classified
    // as a network failure rather than swallowed and misreported as invalid JSON.
    if (!res.ok) {
      await throwHttpError(res, provider);
    }
    const text = await readBodyText(res, provider);
    let json: {
      output?: {
        choices?: Array<{
          message?: {
            content?: Array<{
              image?: string;
              image_url?: string | { url?: string };
              text?: string;
            }>;
          };
        }>;
      };
    };
    try {
      json = JSON.parse(text);
    } catch {
      // The parse error message echoes response bytes, so it's dropped entirely.
      const detail = `${provider.name} returned invalid JSON.`;
      throw new ImageGenError(detail, `${providerLogLabel(provider)} returned invalid JSON`);
    }
    const out: RawImageResult[] = [];
    for (const choice of json.output?.choices ?? []) {
      for (const part of choice.message?.content ?? []) {
        const candidate =
          typeof part.image_url === 'string' ? part.image_url : (part.image_url?.url ?? part.image);
        const classified = classifyImageOutput(candidate);
        if (classified) {
          if (out.length >= MAX_GENERATED_IMAGES) {
            throw new ImageGenError(
              `Provider returned too many images (maximum ${MAX_GENERATED_IMAGES}).`,
              `${providerLogLabel(provider)} returned too many images`,
            );
          }
          out.push({ data: classified });
        }
      }
    }
    if (out.length === 0) {
      // Drop the raw body ("Raw: …") — it may echo the prompt or provider internals.
      const detail = `${provider.name} returned no images. The model may have refused the prompt or the response shape changed.`;
      throw new ImageGenError(detail, `${providerLogLabel(provider)} returned no images`);
    }
    return out;
  },
};
