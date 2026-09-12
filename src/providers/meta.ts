import {
  describeNetworkError,
  ImageGenError,
  missingKeyError,
  providerLogLabel,
  readBodyText,
  throwHttpError,
} from '../errors.js';
import {
  classifyImageOutput,
  MAX_GENERATED_IMAGES,
  toDataUri,
} from '../image-input.js';
import type {
  GenerateImageParams,
  ImageProviderAdapter,
  ImageProviderRuntime,
  RawImageResult,
  ResolvedImageInput,
  ResolvedProvider,
} from '../types.js';
import { withDefaultPath } from '../url.js';
import { credentialRedirectMode, hasProviderAuthentication, jsonHeaders } from './openai.js';

/**
 * Meta Model API image generation via the conversational Responses API.
 *
 * Muse Image does not expose an OpenAI Images endpoint. Text-only generation
 * sends a string input; editing and composition send one user message whose
 * content contains input_text followed by input_image data URLs. Setting
 * store=false keeps this stateless: callers can iterate by passing the prior
 * output back through the image parameter instead of retaining server state.
 *
 * Official cookbook:
 * https://github.com/meta-models/meta-model-cookbook/tree/main/05_muse_image
 */
export const metaAdapter: ImageProviderAdapter = {
  async generate(
    provider: ResolvedProvider,
    remoteModelId: string,
    params: GenerateImageParams,
    fetchImpl: typeof fetch,
    signal?: AbortSignal,
    inputs?: ResolvedImageInput[],
    runtime?: ImageProviderRuntime,
  ): Promise<RawImageResult[]> {
    if (params.n != null && params.n !== 1) {
      throw new ImageGenError(
        'Meta Muse Image returns one image per request, so n must be 1 or omitted.',
        `${providerLogLabel(provider)} rejected unsupported n parameter`,
      );
    }

    const base = withDefaultPath(provider.baseUrl, '/v1');
    const url = `${base}/responses`;
    const oauthKey = await resolveMetaOAuthApiKey(provider, runtime);
    if (signal?.aborted) {
      throw new ImageGenError('Request to Meta Model API was cancelled.', 'Meta request cancelled');
    }
    const configuredKey = provider.apiKey?.trim();
    const apiKey = provider.authMode === 'oauth' ? oauthKey : (oauthKey ?? configuredKey);
    if (provider.authMode === 'oauth' && !oauthKey) throw missingKeyError(provider);
    if (!apiKey && !hasProviderAuthentication(provider)) throw missingKeyError(provider);
    let input: unknown = params.prompt;
    if (inputs && inputs.length > 0) {
      const content: Array<Record<string, string>> = [
        { type: 'input_text', text: params.prompt },
      ];
      for (const image of inputs) {
        if (signal?.aborted) {
          throw new ImageGenError('Request to Meta Model API was cancelled.', 'Meta request cancelled');
        }
        content.push({ type: 'input_image', image_url: toDataUri(image) });
      }
      input = [{ role: 'user', content }];
    }
    const imageTool: Record<string, string> = { type: 'image_generation' };
    if (params.size) imageTool.size = params.size;
    const body: Record<string, unknown> = {
      model: remoteModelId,
      input,
      tools: [imageTool],
      store: false,
    };

    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers:
          provider.builtIn || provider.customAuth == null
            ? metaRequestHeaders(provider, apiKey!)
            : jsonHeaders(provider),
        body: JSON.stringify(body),
        signal: signal ?? null,
        redirect: credentialRedirectMode(provider),
      });
    } catch (error) {
      throw describeNetworkError(error, provider);
    }

    if (!res.ok) await throwHttpError(res, provider);
    const text = await readBodyText(res, provider);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw invalidMetaResponse(provider);
    }
    if (!isRecord(json) || !Array.isArray(json.output)) {
      throw invalidMetaResponse(provider);
    }

    const out: RawImageResult[] = [];
    for (const item of json.output) {
      if (!isRecord(item)) throw invalidMetaResponse(provider);
      if (item.type !== 'image_generation_call') continue;
      if (typeof item.result !== 'string') throw invalidMetaResponse(provider);
      const data = classifyImageOutput(item.result);
      if (!data) continue;
      if (out.length >= MAX_GENERATED_IMAGES) {
        throw new ImageGenError(
          `Provider returned too many images (maximum ${MAX_GENERATED_IMAGES}).`,
          `${providerLogLabel(provider)} returned too many images`,
        );
      }
      out.push({ data });
    }

    const requestId = typeof json.id === 'string' ? json.id : res.headers.get('x-request-id') ?? undefined;
    const usage = numericRecord(json.usage);
    if (out[0] && (requestId || usage)) out[0].metadata = { ...(requestId ? { requestId } : {}), ...(usage ? { usage } : {}) };
    if (out.length === 0) {
      throw new ImageGenError(
        `${provider.name} returned no image data — the model may have refused to generate. Tell the user to rephrase the prompt or try a different model.`,
        `${providerLogLabel(provider)} returned no image data`,
      );
    }
    return out;
  },
};

export function canUseMetaOAuth(provider: ResolvedProvider): boolean {
  if (!provider.builtIn || provider.id !== 'meta') return false;
  try {
    const base = withDefaultPath(provider.baseUrl, '/v1');
    const url = new URL(`${base}/responses`);
    return (
      url.protocol === 'https:' &&
      url.hostname === 'api.meta.ai' &&
      url.port === '' &&
      url.username === '' &&
      url.password === '' &&
      url.pathname === '/v1/responses'
    );
  } catch {
    return false;
  }
}

/** Resolve only a real Pi OAuth login, not registry-backed environment API keys. */
export async function resolveMetaOAuthApiKey(
  provider: ResolvedProvider,
  runtime?: ImageProviderRuntime,
): Promise<string | undefined> {
  // OAuth credentials belong to Pi's registered `meta` provider. Never query or
  // attach them for a custom provider or an overridden endpoint.
  if (provider.authMode === 'api-key' || !canUseMetaOAuth(provider)) return undefined;
  const registry = runtime?.modelRegistry;
  if (!registry?.getApiKeyForProvider || !registry.isUsingOAuth) return undefined;
  try {
    const metaModel = registry.getAvailable().find((model) => model.provider === 'meta');
    if (!metaModel || !registry.isUsingOAuth(metaModel)) return undefined;
    const oauthKey = await registry.getApiKeyForProvider('meta');
    return oauthKey?.trim() || undefined;
  } catch {
    // A separately configured API key remains a valid fallback when OAuth is
    // unavailable or cannot refresh. Raw auth errors are intentionally hidden.
    return undefined;
  }
}

function metaRequestHeaders(
  provider: ResolvedProvider,
  apiKey: string,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(provider.headers ?? {})) {
    if (name.toLowerCase() !== 'authorization' && name.toLowerCase() !== 'content-type') {
      headers[name] = value;
    }
  }
  // The resolved credential always wins, regardless of configured header casing.
  headers.authorization = `Bearer ${apiKey}`;
  headers['content-type'] = 'application/json';
  return headers;
}

function numericRecord(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]));
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidMetaResponse(provider: ResolvedProvider): ImageGenError {
  return new ImageGenError(
    `${provider.name} returned an invalid response.`,
    `${providerLogLabel(provider)} returned invalid response`,
  );
}
