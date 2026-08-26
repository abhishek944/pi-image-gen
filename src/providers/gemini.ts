import {
  describeNetworkError,
  ImageGenError,
  missingKeyError,
  providerLogLabel,
  readBodyText,
  throwHttpError,
} from '../errors.js';
import { MAX_GENERATED_IMAGES } from '../image-input.js';
import type {
  GenerateImageParams,
  ImageProviderAdapter,
  RawImageResult,
  ResolvedImageInput,
  ResolvedProvider,
} from '../types.js';
import { withDefaultPath } from '../url.js';

/**
 * Google Generative Language API for `gemini-2.5-flash-image` (Nano Banana)
 * and successors.
 *   POST {baseUrl}/models/{model}:generateContent
 *   Header: x-goog-api-key
 * Response: candidates[].content.parts[].inline_data (base64).
 */
export const geminiAdapter: ImageProviderAdapter = {
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
    const base = withDefaultPath(provider.baseUrl, '/v1beta');
    const url = `${base}/models/${encodeURIComponent(remoteModelId)}:generateContent`;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-goog-api-key': provider.apiKey,
    };
    if (provider.headers) Object.assign(headers, provider.headers);

    const n = params.n ?? 1;
    // Per https://ai.google.dev/gemini-api/docs/image-generation REST examples,
    // request body uses snake_case (`inline_data`, `mime_type`). Google accepts
    // both; we stay aligned with the docs.
    const userParts: Array<
      { text: string } | { inline_data: { mime_type: string; data: string } }
    > = [];
    for (const input of inputs ?? []) {
      userParts.push({
        inline_data: {
          mime_type: input.mimeType,
          data: Buffer.from(input.bytes).toString('base64'),
        },
      });
    }
    userParts.push({ text: params.prompt });
    // Gemini image models have no pixel-size knob — output shape is driven by
    // imageConfig { aspectRatio, imageSize } (uppercase "K" tiers).
    const imageConfig: Record<string, string> = {};
    if (params.aspectRatio) imageConfig.aspectRatio = params.aspectRatio;
    if (params.imageSize) imageConfig.imageSize = params.imageSize;
    const body = {
      contents: [{ role: 'user', parts: userParts }],
      generationConfig: {
        responseModalities: ['IMAGE'],
        candidateCount: n,
        ...(Object.keys(imageConfig).length > 0 ? { imageConfig } : {}),
      },
    };

    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
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
      candidates?: Array<{
        content?: {
          parts?: Array<{
            inlineData?: { mimeType?: string; data?: string };
            inline_data?: { mime_type?: string; data?: string };
          }>;
        };
      }>;
    };
    try {
      json = JSON.parse(text);
    } catch {
      // The parse error message echoes response bytes, so it's dropped entirely.
      const detail = `${provider.name} returned invalid JSON.`;
      throw new ImageGenError(detail, `${providerLogLabel(provider)} returned invalid JSON`);
    }

    const out: RawImageResult[] = [];
    for (const candidate of json.candidates ?? []) {
      for (const part of candidate.content?.parts ?? []) {
        // Google's REST API returns camelCase `inlineData`; the gRPC/proto form
        // is `inline_data`. Accept both — different gateways may pass either.
        const inline = part.inlineData ?? part.inline_data;
        const data = inline?.data;
        const mimeType =
          (inline as { mimeType?: string; mime_type?: string } | undefined)?.mimeType ??
          (inline as { mimeType?: string; mime_type?: string } | undefined)?.mime_type ??
          'image/png';
        if (data) {
          if (out.length >= MAX_GENERATED_IMAGES) {
            throw new ImageGenError(
              `Provider returned too many images (maximum ${MAX_GENERATED_IMAGES}).`,
              `${providerLogLabel(provider)} returned too many images`,
            );
          }
          out.push({
            data: {
              kind: 'base64',
              bytes: data,
              mimeType,
            },
          });
        }
      }
    }
    if (out.length === 0) {
      const detail = `${provider.name} returned no image data — the model may have refused to generate. Tell the user to rephrase the prompt or try a different model.`;
      throw new ImageGenError(detail, `${providerLogLabel(provider)} returned no image data`);
    }
    return out;
  },
};
