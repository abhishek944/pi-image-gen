import { createHash } from 'node:crypto';
import { readResponseBytes } from '@amaster.ai/pi-shared';
import { MAX_GENERATED_IMAGES } from './image-input.js';
import { bearerHeaders, credentialRedirectMode } from './providers/openai.js';
import { withDefaultPath } from './url.js';
import type { ImageModelCapabilities, ResolvedModel } from './types.js';

const DISCOVERY_TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 10 * 60_000;

type CacheEntry = { expiresAt: number; capabilities: Partial<ImageModelCapabilities> };
const cache = new Map<string, CacheEntry>();

/**
 * Best-effort OpenRouter image capability discovery. Failure is deliberately
 * non-fatal: callers keep the static or generic contract.
 */
export async function discoverOpenRouterCapabilities(
  resolved: ResolvedModel,
  enabled = true,
  fetchImpl: typeof fetch = fetch,
): Promise<Partial<ImageModelCapabilities> | undefined> {
  const apiKey = resolved.provider.apiKey;
  if (
    !enabled ||
    resolved.provider.api !== 'openrouter' ||
    (resolved.provider.customAuth?.type !== 'none' && !apiKey)
  ) return undefined;
  const key = `${resolved.provider.baseUrl}\n${resolved.remoteId}\n${requestIdentity(resolved)}`;
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.capabilities;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
  try {
    const base = withDefaultPath(resolved.provider.baseUrl, '/api/v1');
    const headers = bearerHeaders(resolved.provider);
    const response = await fetchImpl(`${base}/images/models`, {
      headers,
      signal: controller.signal,
      redirect: credentialRedirectMode(resolved.provider),
    });
    if (!response.ok || !(response.headers.get('content-type') ?? '').includes('json')) {
      await response.body?.cancel().catch(() => {});
      return undefined;
    }
    const bytes = await readResponseBytes(response, 4 * 1024 * 1024);
    const json = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    const rows = isRecord(json) && Array.isArray(json.data) ? json.data : [];
    const row = rows.find((item) => isRecord(item) && item.id === resolved.remoteId);
    if (!isRecord(row)) return undefined;
    const parameters = collectSupportedParameters(row);
    const capabilities = mapParameters(parameters);
    cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, capabilities });
    return capabilities;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function requestIdentity(resolved: ResolvedModel): string {
  const headers = Object.entries(resolved.provider.headers ?? {})
    .map(([name, value]) => [name.toLowerCase(), value] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  return createHash('sha256')
    .update(JSON.stringify({
      providerId: resolved.provider.id,
      builtIn: resolved.provider.builtIn,
      auth: resolved.provider.customAuth ?? null,
      apiKey: resolved.provider.apiKey ?? null,
      headers,
    }))
    .digest('hex');
}

function collectSupportedParameters(row: Record<string, unknown>): Map<string, unknown> {
  const parameters = new Map<string, unknown>();
  const add = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) if (typeof item === 'string') parameters.set(item, true);
    } else if (isRecord(value)) {
      for (const [name, descriptor] of Object.entries(value)) parameters.set(name, descriptor);
    }
  };
  add(row.supported_parameters);
  // Some proxies inline endpoint records even though OpenRouter's public model
  // catalog normally links to them. Supporting both shapes is harmless.
  if (Array.isArray(row.endpoints)) {
    for (const endpoint of row.endpoints) if (isRecord(endpoint)) add(endpoint.supported_parameters);
  }
  return parameters;
}

function mapParameters(parameters: Map<string, unknown>): Partial<ImageModelCapabilities> {
  const capabilities: Partial<ImageModelCapabilities> = {};
  const enumValues = <T extends string>(name: string, allowed: readonly T[]): T[] | undefined => {
    if (!parameters.has(name)) return undefined;
    const descriptor = parameters.get(name);
    const values = isRecord(descriptor) && Array.isArray(descriptor.values) ? descriptor.values : allowed;
    const clean = values.filter((value): value is T => typeof value === 'string' && allowed.includes(value as T));
    return clean.length > 0 ? [...new Set(clean)] : undefined;
  };
  let formats = enumValues('output_format', ['png', 'jpeg', 'webp'] as const);
  // OpenRouter's normalized image API exposes raster encoding even when an
  // endpoint catalog only lists output_compression. Compression implies a
  // JPEG/WebP-capable encoding choice on that route.
  if (!formats && parameters.has('output_compression')) formats = ['png', 'jpeg', 'webp'];
  if (formats) capabilities.outputFormats = formats;
  const backgrounds = enumValues('background', ['auto', 'transparent', 'opaque'] as const);
  if (backgrounds) capabilities.backgroundValues = backgrounds;
  if (
    parameters.has('output_compression') &&
    formats?.some((format) => format === 'jpeg' || format === 'webp')
  ) {
    capabilities.supportsOutputCompression = true;
  }
  if (parameters.has('seed')) capabilities.supportsSeed = true;
  if (parameters.has('negative_prompt')) capabilities.supportsNegativePrompt = true;
  const nMax = descriptorMaximum(parameters.get('n'));
  if (!parameters.has('n')) {
    // A successful catalog lookup makes omission meaningful: OpenRouter says
    // unsupported parameters are absent, and such image routes are single-output.
    capabilities.nMax = 1;
    capabilities.nMaxSource = 'provider';
  } else if (nMax != null) {
    capabilities.nMax = Math.min(nMax, MAX_GENERATED_IMAGES);
    capabilities.nMaxSource = 'provider';
  } else {
    // The route advertises n but no usable numeric bound. Keep the extension's
    // safety ceiling and label it honestly rather than inventing provider docs.
    capabilities.nMax = MAX_GENERATED_IMAGES;
    capabilities.nMaxSource = 'extension';
  }
  return capabilities;
}

function descriptorMaximum(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  for (const candidate of [value.max, value.maximum, value.maxItems, value.max_items]) {
    if (Number.isInteger(candidate) && (candidate as number) >= 1) return candidate as number;
  }
  if (isRecord(value.range)) return descriptorMaximum(value.range);
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
