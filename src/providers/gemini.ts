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
import { bearerHeaders, credentialRedirectMode, hasProviderAuthentication, setHeaderCaseInsensitive } from './openai.js';

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
    if (!hasProviderAuthentication(provider)) {
      throw missingKeyError(provider);
    }
    const base = withDefaultPath(provider.baseUrl, '/v1beta');
    const url = `${base}/models/${encodeURIComponent(remoteModelId)}:generateContent`;
    const usesLegacyGoogleAuth = provider.builtIn || provider.customAuth == null;
    const headers: Record<string, string> = usesLegacyGoogleAuth
      ? { ...(provider.headers ?? {}) }
      : bearerHeaders(provider);
    setHeaderCaseInsensitive(headers, 'content-type', 'application/json');
    if (usesLegacyGoogleAuth && provider.apiKey) {
      const configuredGoogleKey = Object.entries(provider.headers ?? {})
        .filter(([name]) => name.toLowerCase() === 'x-goog-api-key')
        .at(-1)?.[1];
      setHeaderCaseInsensitive(
        headers,
        'x-goog-api-key',
        configuredGoogleKey ?? provider.apiKey,
      );
    }

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
        redirect: credentialRedirectMode(provider),
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
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      // The parse error message echoes response bytes, so it's dropped entirely.
      const detail = `${provider.name} returned invalid JSON.`;
      throw new ImageGenError(detail, `${providerLogLabel(provider)} returned invalid JSON`);
    }

    if (!isRecord(json) || (json.candidates !== undefined && !Array.isArray(json.candidates))) {
      throw invalidResponseError(provider);
    }
    const out: RawImageResult[] = [];
    for (const candidate of json.candidates ?? []) {
      if (!isRecord(candidate)) throw invalidResponseError(provider);
      const content = candidate.content;
      if (content !== undefined && !isRecord(content)) throw invalidResponseError(provider);
      const parts = isRecord(content) ? content.parts : undefined;
      if (parts !== undefined && !Array.isArray(parts)) throw invalidResponseError(provider);
      for (const part of parts ?? []) {
        if (!isRecord(part)) throw invalidResponseError(provider);
        // Google's REST API returns camelCase `inlineData`; the gRPC/proto form
        // is `inline_data`. Accept both — different gateways may pass either.
        const inline = isRecord(part.inlineData)
          ? part.inlineData
          : isRecord(part.inline_data)
            ? part.inline_data
            : undefined;
        const data = typeof inline?.data === 'string' ? inline.data : undefined;
        const mimeType =
          (typeof inline?.mimeType === 'string' ? inline.mimeType : undefined) ??
          (typeof inline?.mime_type === 'string' ? inline.mime_type : undefined) ??
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
    const requestId = typeof json.responseId === 'string'
      ? json.responseId
      : res.headers.get('x-request-id') ?? undefined;
    const usage = numericRecord(json.usageMetadata);
    if (out[0] && (requestId || usage)) {
      out[0].metadata = {
        ...(requestId ? { requestId } : {}),
        ...(usage ? { usage } : {}),
      };
    }
    if (out.length === 0) {
      const detail = `${provider.name} returned no image data — the model may have refused to generate. Tell the user to rephrase the prompt or try a different model.`;
      throw new ImageGenError(detail, `${providerLogLabel(provider)} returned no image data`);
    }
    return out;
  },
};

function invalidResponseError(provider: ResolvedProvider): ImageGenError {
  return new ImageGenError(
    `${provider.name} returned an invalid image response.`,
    `${providerLogLabel(provider)} returned an invalid image response`,
  );
}

function numericRecord(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).filter(
    (entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]),
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
