import {
  describeNetworkError,
  ImageGenError,
  missingKeyError,
  providerLogLabel,
  readBodyText,
  redactUrl,
  throwHttpError,
} from '../errors.js';
import {
  classifyImageOutput,
  MAX_BASE64_IMAGE_CHARS,
  MAX_GENERATED_IMAGES,
  sniffMime,
} from '../image-input.js';
import type {
  GenerateImageParams,
  ImageProviderAdapter,
  RawImageResult,
  ResolvedImageInput,
  ResolvedProvider,
  ImageProviderRuntime,
} from '../types.js';
import { withDefaultPath } from '../url.js';

export function hasProviderAuthentication(provider: ResolvedProvider): boolean {
  return provider.customAuth?.type === 'none' || Boolean(provider.apiKey);
}

export function credentialRedirectMode(provider: ResolvedProvider): 'error' | 'follow' {
  return provider.customAuth?.type === 'header' ||
      (provider.api === 'gemini' && (provider.builtIn || provider.customAuth == null)) ||
      Object.keys(provider.headers ?? {}).length > 0
    ? 'error'
    : 'follow';
}

export function setHeaderCaseInsensitive(
  headers: Record<string, string>,
  name: string,
  value: string,
): void {
  for (const existing of Object.keys(headers)) {
    if (existing.toLowerCase() === name.toLowerCase()) delete headers[existing];
  }
  headers[name] = value;
}

export function bearerHeaders(provider: ResolvedProvider): Record<string, string> {
  const headers: Record<string, string> = { ...(provider.headers ?? {}) };
  if (provider.customAuth?.type === 'none') return headers;
  if (provider.customAuth?.type === 'header') {
    if (provider.apiKey) setHeaderCaseInsensitive(headers, provider.customAuth.header, provider.apiKey);
    return headers;
  }
  if (provider.customAuth == null) {
    const legacyAuthorization = Object.entries(headers)
      .filter(([name]) => name.toLowerCase() === 'authorization')
      .at(-1)?.[1];
    if (legacyAuthorization != null) {
      setHeaderCaseInsensitive(headers, 'authorization', legacyAuthorization);
      return headers;
    }
  }
  if (provider.apiKey) setHeaderCaseInsensitive(headers, 'authorization', `Bearer ${provider.apiKey}`);
  return headers;
}

export function jsonHeaders(provider: ResolvedProvider): Record<string, string> {
  const headers = bearerHeaders(provider);
  setHeaderCaseInsensitive(headers, 'content-type', 'application/json');
  return headers;
}

/**
 * OpenAI-compatible image API. Used for OpenAI directly and any
 * customProvider with `api: 'openai'`.
 *
 * Two endpoints:
 *   - POST /v1/images/generations  (text-to-image, JSON body)
 *   - POST /v1/images/edits        (image-to-image, multipart/form-data)
 *
 * The edit path is selected when the caller passes `inputs` (resolved
 * reference images). Verified GPT Image routes may also attach a separate mask.
 *
 * OpenRouter is NOT OpenAI-compatible for images — it uses POST /api/v1/images
 * (no `/generations` suffix). See providers/openrouter.ts.
 */
export const openaiAdapter: ImageProviderAdapter = {
  async generate(
    provider: ResolvedProvider,
    remoteModelId: string,
    params: GenerateImageParams,
    fetchImpl: typeof fetch,
    signal?: AbortSignal,
    inputs?: ResolvedImageInput[],
    runtime?: ImageProviderRuntime,
  ): Promise<RawImageResult[]> {
    if (!hasProviderAuthentication(provider)) {
      throw missingKeyError(provider);
    }
    const base = withDefaultPath(provider.baseUrl, '/v1');
    if (inputs && inputs.length > 0) {
      return generateWithImages(provider, base, remoteModelId, params, inputs, fetchImpl, signal, runtime?.mask);
    }
    return generateFromText(provider, base, remoteModelId, params, fetchImpl, signal);
  },
};

async function generateFromText(
  provider: ResolvedProvider,
  base: string,
  remoteModelId: string,
  params: GenerateImageParams,
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
): Promise<RawImageResult[]> {
  const url = `${base}/images/generations`;
  const body: Record<string, unknown> = {
    model: remoteModelId,
    prompt: params.prompt,
    n: params.n ?? 1,
  };
  if (params.size) body.size = params.size;
  if (params.quality) body.quality = params.quality;
  if (params.outputFormat) body.output_format = params.outputFormat;
  if (params.background) body.background = params.background;
  if (params.outputCompression != null) body.output_compression = params.outputCompression;

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
}

async function generateWithImages(
  provider: ResolvedProvider,
  base: string,
  remoteModelId: string,
  params: GenerateImageParams,
  inputs: ResolvedImageInput[],
  fetchImpl: typeof fetch,
  signal?: AbortSignal,
  mask?: ResolvedImageInput,
): Promise<RawImageResult[]> {
  const url = `${base}/images/edits`;
  const form = new FormData();
  form.append('model', remoteModelId);
  form.append('prompt', params.prompt);
  form.append('n', String(params.n ?? 1));
  if (params.size) form.append('size', params.size);
  if (params.quality) form.append('quality', params.quality);
  if (params.outputFormat) form.append('output_format', params.outputFormat);
  if (params.background) form.append('background', params.background);
  if (params.outputCompression != null) form.append('output_compression', String(params.outputCompression));
  if (mask) {
    const ext = mask.mimeType.split('/')[1] ?? 'png';
    form.append('mask', new Blob([new Uint8Array(mask.bytes)], { type: mask.mimeType }), `mask.${ext}`);
  }
  // OpenAI accepts repeated `image[]` for multi-image edits on gpt-image-2.
  const fieldName = inputs.length > 1 ? 'image[]' : 'image';
  for (const [i, input] of inputs.entries()) {
    const ext = input.mimeType.split('/')[1] ?? 'png';
    const blob = new Blob([new Uint8Array(input.bytes)], { type: input.mimeType });
    form.append(fieldName, blob, `image-${i}.${ext}`);
  }

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: bearerHeaders(provider),
      body: form,
      signal: signal ?? null,
      redirect: credentialRedirectMode(provider),
    });
  } catch (error) {
    throw describeNetworkError(error, provider);
  }
  return parseImagesResponse(res, url, provider);
}

export async function parseImagesResponse(
  res: Response,
  url: string,
  provider: ResolvedProvider,
): Promise<RawImageResult[]> {
  // Check status BEFORE reading the body: an HTTP error is classified by status
  // (body-free), and a body that breaks mid-read is classified as a network
  // failure rather than swallowed and misreported as "invalid JSON".
  if (!res.ok) {
    await throwHttpError(res, provider);
  }
  const text = await readBodyText(res, provider);
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('json')) {
    // The raw body may carry credentials / another tenant's data — never
    // interpolate it; `redactUrl(url)` drops any signed query on the endpoint.
    const detail = `${provider.name} returned ${contentType || 'non-JSON'} from ${redactUrl(url)}. The endpoint probably doesn't expose the OpenAI-compatible images API at this path.`;
    throw new ImageGenError(detail, `${providerLogLabel(provider)} returned non-JSON`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    // The parse error message echoes response bytes, so it's dropped entirely.
    const detail = `${provider.name} returned invalid JSON.`;
    throw new ImageGenError(detail, `${providerLogLabel(provider)} returned invalid JSON`);
  }
  if (!isRecord(json) || (json.data !== undefined && !Array.isArray(json.data))) {
    throw invalidResponseError(provider);
  }
  const data = json.data ?? [];
  if (data.length > MAX_GENERATED_IMAGES) {
    throw new ImageGenError(
      `Provider returned too many images (maximum ${MAX_GENERATED_IMAGES}).`,
      `${providerLogLabel(provider)} returned too many images`,
    );
  }
  const out: RawImageResult[] = [];
  for (const entry of data) {
    if (!isRecord(entry)) throw invalidResponseError(provider);
    // Prefer explicit b64_json field (OpenAI shape). If absent, classify the
    // `url` field — some gateways return a `data:` URI or even raw base64
    // there instead of a real URL.
    let payload: RawImageResult['data'] | null = null;
    if (typeof entry.b64_json === 'string' && entry.b64_json) {
      if (entry.b64_json.length > MAX_BASE64_IMAGE_CHARS) {
        throw new ImageGenError(
          'Provider returned an image that exceeds the size ceiling.',
          `${providerLogLabel(provider)} returned an oversized image`,
        );
      }
      const prefix = Buffer.from(entry.b64_json.slice(0, 24), 'base64');
      const mimeType =
        sniffMime(prefix) ??
        (typeof entry.media_type === 'string' ? entry.media_type : undefined) ??
        'image/png';
      payload = { kind: 'base64', bytes: entry.b64_json, mimeType };
    } else {
      const classified = classifyImageOutput(
        typeof entry.url === 'string' ? entry.url : undefined,
      );
      if (classified) payload = classified;
    }
    if (!payload) continue;
    const item: RawImageResult = { data: payload };
    if (typeof entry.revised_prompt === 'string') item.revisedPrompt = entry.revised_prompt;
    out.push(item);
  }
  const requestId = res.headers.get('x-request-id') ?? res.headers.get('request-id') ?? undefined;
  const usage = numericRecord(json.usage);
  const cost = finiteNumber(json.cost) ?? finiteNumber(usage?.cost);
  if (out[0] && (requestId || usage || cost != null)) {
    out[0].metadata = {
      ...(requestId ? { requestId } : {}),
      ...(usage ? { usage } : {}),
      ...(cost != null ? { cost } : {}),
    };
  }
  if (out.length === 0) {
    // Entry count is safe metadata; the raw body ("Raw: …") is not — drop it.
    const detail = `${provider.name} returned no usable images. Response had ${data.length} entries but none had b64_json or a valid url.`;
    throw new ImageGenError(detail, `${providerLogLabel(provider)} returned no usable images`);
  }
  return out;
}

function invalidResponseError(provider: ResolvedProvider): ImageGenError {
  return new ImageGenError(
    `${provider.name} returned an invalid image response.`,
    `${providerLogLabel(provider)} returned an invalid image response`,
  );
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
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
