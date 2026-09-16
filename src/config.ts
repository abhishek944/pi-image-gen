import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadPiSettings } from '@amaster.ai/pi-shared/settings';
import { sanitizeCapabilities } from './capabilities.js';
import { canUseMetaOAuth } from './providers/meta.js';
import {
  BUILT_IN_MODELS,
  DEFAULT_API_STYLE,
  DEFAULT_BASE_URL,
  ENV_VARS,
  findBuiltInModel,
  PROVIDER_DISPLAY_NAME,
} from './models.js';
import type {
  BuiltInProviderId,
  BuiltInProviderRouteId,
  CustomApiStyle,
  CustomImageModel,
  CustomImageProvider,
  CustomProviderAuth,
  ImageGenSettings,
  ImageModelCapabilities,
  ResolvedModel,
  ResolvedProvider,
} from './types.js';

const SETTINGS_KEY = 'pi-image-gen';

/**
 * Conservative capability fallback for custom models that declare partial
 * capabilities (or inherit by id) but leave fields unset: today's generic
 * contract — n up to 8, any sniffable format, the global byte ceiling.
 * Custom models with neither an explicit declaration nor a built-in id match
 * get NO capabilities at all (generic schema, no validation), so their
 * behavior is unchanged.
 */
const GENERIC_CAPABILITIES: ImageModelCapabilities = {
  nMax: 8,
  maxReferenceImages: 8,
  // Keep in sync with sniffMime's detectable set in image-input.ts.
  inputFormats: ['PNG', 'JPEG', 'GIF', 'WEBP', 'BMP', 'TIFF', 'HEIC', 'HEIF'],
  inputMaxBytes: 20 * 1024 * 1024,
};

/**
 * Resolve a custom model's capabilities: explicit per-field declarations win
 * (after a shape check — settings are a trust boundary), then the built-in
 * registry entry of the same id, then the generic contract. Mirrors
 * pi-video-gen's capability inheritance for custom models.
 */
function inheritCapabilities(
  modelId: string,
  explicit: Partial<ImageModelCapabilities> | undefined,
  owner: string,
): {
  capabilities: ImageModelCapabilities;
  declaredCapabilities?: Partial<ImageModelCapabilities>;
  includesRegistry: boolean;
} | undefined {
  const builtIn = findBuiltInModel(modelId)?.capabilities;
  if (!builtIn && !explicit) return undefined;
  const declaredCapabilities = explicit ? sanitizeCapabilities(explicit, owner) : undefined;
  const capabilities: ImageModelCapabilities = { ...GENERIC_CAPABILITIES, ...builtIn };
  for (const [key, value] of Object.entries(declaredCapabilities ?? {})) {
    if (value !== undefined) (capabilities as Record<string, unknown>)[key] = value;
  }
  return {
    capabilities,
    ...(declaredCapabilities ? { declaredCapabilities } : {}),
    includesRegistry: Boolean(builtIn),
  };
}

export function loadImageGenSettings(cwd: string, projectTrusted = false): ImageGenSettings {
  let fallback: ImageGenSettings;
  try {
    fallback = loadPiSettings<ImageGenSettings>(SETTINGS_KEY, { cwd, projectTrusted });
  } catch {
    fallback = {};
  }
  if (!projectTrusted) return fallback;
  try {
    const loaded = loadPiSettings<ImageGenSettings>(SETTINGS_KEY, {
      cwd,
      projectTrusted,
      strictProjectSettings: true,
    });
    return malformedProjectNamespace(cwd)
      ? { ...loaded, spriteGeneration: { ...loaded.spriteGeneration, enabled: false } }
      : loaded;
  } catch {
    // Preserve established image settings fallback, but never let a malformed
    // trusted project file expose a globally enabled optional sprite tool.
    return { ...fallback, spriteGeneration: { ...fallback.spriteGeneration, enabled: false } };
  }
}

function malformedProjectNamespace(cwd: string): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(resolve(cwd, '.pi', 'settings.json'), 'utf8'));
    if (!isRecord(parsed) || !(SETTINGS_KEY in parsed)) return false;
    return !isRecord(parsed[SETTINGS_KEY]);
  } catch {
    // Invalid/unreadable files are handled by strictProjectSettings above.
    return false;
  }
}

function buildBuiltInProvider(
  id: BuiltInProviderId,
  settings: ImageGenSettings,
): ResolvedProvider | null {
  const providers = isRecord(settings.providers) ? settings.providers : {};
  const rawOverride = providers[id];
  const override = isRecord(rawOverride) ? rawOverride : {};
  const envVar = ENV_VARS[id];
  const configuredApiKey = trimCredential(override.apiKey);
  const configuredBaseUrl =
    typeof override.baseUrl === 'string' && override.baseUrl.trim()
      ? override.baseUrl.trim()
      : undefined;
  const environmentApiKey =
    id === 'meta'
      ? trimCredential(process.env.META_API_KEY) ?? trimCredential(process.env.MODEL_API_KEY)
      : envVar
        ? trimCredential(process.env[envVar])
        : undefined;
  const apiKey = configuredApiKey ?? environmentApiKey;
  const provider: ResolvedProvider = {
    id,
    api: DEFAULT_API_STYLE[id],
    baseUrl: configuredBaseUrl ?? DEFAULT_BASE_URL[id],
    name: PROVIDER_DISPLAY_NAME[id],
    builtIn: true,
  };
  if (apiKey) provider.apiKey = apiKey;
  if (isStringRecord(override.headers)) provider.headers = override.headers;
  return provider;
}

function buildCustomProvider(name: string, raw: unknown): ResolvedProvider | null {
  if (!isValidCustomProviderId(name) || !isRecord(raw) || !isCustomApiStyle(raw.api)) {
    return null;
  }
  if (raw.baseUrl !== undefined && typeof raw.baseUrl !== 'string') return null;
  if (raw.apiKey !== undefined && typeof raw.apiKey !== 'string') return null;
  const customAuth = parseCustomAuth(raw.auth);
  if (raw.auth !== undefined && !customAuth) return null;
  if (
    raw.name !== undefined &&
    (typeof raw.name !== 'string' || !raw.name.trim() || raw.name.trim() !== raw.name)
  ) {
    return null;
  }
  if (
    raw.models !== undefined &&
    (!Array.isArray(raw.models) || !raw.models.every(isValidCustomModelEntry))
  ) {
    return null;
  }
  if (raw.headers !== undefined && !isStringRecord(raw.headers)) return null;

  const api = raw.api;
  const baseUrl = raw.baseUrl?.trim() || DEFAULT_BASE_URL[api as BuiltInProviderId];
  if (!baseUrl) return null;
  const provider: ResolvedProvider = {
    id: name,
    api,
    baseUrl,
    name: raw.name ?? name,
    builtIn: false,
    ...(customAuth ? { customAuth } : {}),
  };
  const apiKey = trimCredential(raw.apiKey);
  if (apiKey) provider.apiKey = apiKey;
  if (raw.headers) provider.headers = raw.headers;
  return provider;
}

function customModels(
  raw: unknown,
): Array<{ id: string; alias: string; capabilities?: Partial<ImageModelCapabilities> }> {
  if (!isRecord(raw)) return [];
  const list = raw.models ?? [];
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry) => {
    if (typeof entry === 'string') return [{ id: entry, alias: entry }];
    if (!isRecord(entry)) return [];
    const m = entry as CustomImageModel;
    if (typeof m.id !== 'string' || !m.id) return [];
    const out: { id: string; alias: string; capabilities?: Partial<ImageModelCapabilities> } = {
      id: m.id,
      alias: m.alias ?? m.id,
    };
    if (m.capabilities) out.capabilities = m.capabilities;
    return [out];
  });
}

/**
 * Resolve a model id (or alias) to a (provider, remoteModelId) pair using:
 *   1. Custom providers' explicit model lists (alias or id match).
 *   2. Built-in known models (alias or id match).
 *   3. `<provider>/<remote-id>` fallback for explicit routing.
 *   4. Catch-all: any custom provider that didn't declare a `models` list
 *      will accept any unknown model id, passing it through as the remote id.
 *      This lets users configure a single OpenAI-compatible gateway and use
 *      any model name without restating it in `models`.
 */
export function resolveModel(
  modelOrAlias: string,
  settings: ImageGenSettings,
): ResolvedModel | { error: string } {
  if (settings.defaultProvider !== undefined) {
    if (typeof settings.defaultProvider !== 'string') {
      return { error: 'pi-image-gen.defaultProvider must be a string.' };
    }
    const selectedRoute = settings.defaultProvider.trim();
    if (!selectedRoute) return { error: 'pi-image-gen.defaultProvider must not be blank.' };
    if (typeof modelOrAlias !== 'string') return { error: 'Model id must be a string.' };
    return resolveModelOnRoute(modelOrAlias, selectedRoute, settings);
  }
  if (typeof modelOrAlias !== 'string') return { error: 'Model id must be a string.' };
  return resolveModelUnscoped(modelOrAlias, settings);
}

function resolveModelUnscoped(
  modelOrAlias: string,
  settings: ImageGenSettings,
): ResolvedModel | { error: string } {
  const requested = modelOrAlias.trim();
  if (!requested) return { error: 'Model id is empty.' };

  const conflictingRouteId = customProviderEntries(settings).find(([name]) =>
    isReservedProviderRouteId(name),
  )?.[0];
  if (conflictingRouteId) {
    return {
      error: `Custom provider id "${conflictingRouteId}" is now reserved for a built-in authentication route. Rename that custom provider before using model-only routing.`,
    };
  }

  for (const [name, raw] of customProviderEntries(settings)) {
    if (isReservedProviderRouteId(name)) continue;
    const provider = buildCustomProvider(name, raw);
    if (!provider) continue;
    for (const model of customModels(raw)) {
      if (model.alias === requested || model.id === requested) {
        const resolved: ResolvedModel = { provider, remoteId: model.id, requestedId: requested };
        const capabilities = inheritCapabilities(
          model.id,
          model.capabilities,
          `customProviders.${name} model "${model.id}"`,
        );
        if (capabilities) {
          resolved.capabilities = capabilities.capabilities;
          if (capabilities.declaredCapabilities) {
            resolved.declaredCapabilities = capabilities.declaredCapabilities;
          }
          resolved.capabilitiesIncludeRegistry = capabilities.includesRegistry;
        }
        if (hasExplicitQualityValues(model.capabilities)) resolved.customQualityValues = true;
        return resolved;
      }
    }
  }

  let builtInWithoutCredentials: ResolvedModel | undefined;
  const builtIn = findBuiltInModel(requested);
  if (builtIn) {
    const provider = buildBuiltInProvider(builtIn.provider, settings);
    if (provider) {
      const resolved: ResolvedModel = {
        provider,
        remoteId: builtIn.remoteId ?? builtIn.id,
        requestedId: requested,
      };
      if (builtIn.capabilities) resolved.capabilities = builtIn.capabilities;
      // Codex and Meta can obtain credentials from Pi at request time, so their
      // built-in model ids must not be diverted to a catch-all custom provider.
      if (provider.apiKey || provider.id === 'codex' || provider.id === 'meta') return resolved;
      // Preserve catch-all custom-provider routing for other known model ids. If
      // no custom route accepts it, return this credential-less provider so its
      // adapter can emit the precise missing-key error instead of mislabeling a
      // known model as unknown.
      builtInWithoutCredentials = resolved;
    }
  }

  const slash = requested.indexOf('/');
  if (slash > 0) {
    const providerKey = requested.slice(0, slash);
    const remoteId = requested.slice(slash + 1);
    if (!remoteId) return { error: 'Model id is empty.' };
    const customRaw = isReservedProviderRouteId(providerKey)
      ? undefined
      : customProviderRaw(settings, providerKey);
    // `meta` was a valid custom prefix before this release added a built-in
    // provider with that name. Preserve that route without changing the
    // established built-in-first precedence of older provider prefixes.
    if (providerKey === 'meta' && customRaw) {
      const provider = buildCustomProvider(providerKey, customRaw);
      if (provider) return { provider, remoteId, requestedId: requested };
    }
    if (isBuiltInProviderId(providerKey)) {
      if (providerKey === 'codex') {
        return resolveModelOnRoute(remoteId, 'codex-subscription', settings);
      }
      const provider = buildBuiltInProvider(providerKey, settings);
      if (provider) {
        const resolved: ResolvedModel = { provider, remoteId, requestedId: requested };
        const known = BUILT_IN_MODELS.find(
          (candidate) =>
            candidate.provider === providerKey &&
            (candidate.id === remoteId || candidate.remoteId === remoteId),
        );
        if (known?.capabilities) resolved.capabilities = known.capabilities;
        return resolved;
      }
    }
    if (customRaw) {
      const provider = buildCustomProvider(providerKey, customRaw);
      if (provider) return { provider, remoteId, requestedId: requested };
    }
  }

  for (const [name, raw] of customProviderEntries(settings)) {
    if (isReservedProviderRouteId(name)) continue;
    const provider = buildCustomProvider(name, raw);
    if (!provider) continue;
    if (customModels(raw).length > 0) continue;
    return { provider, remoteId: requested, requestedId: requested };
  }

  if (builtInWithoutCredentials) return builtInWithoutCredentials;
  return { error: unknownModelError(requested, settings) };
}

export type ProviderRoute = {
  id: string;
  label: string;
  providerId: string;
  authentication: 'api-key' | 'subscription' | 'custom';
  modelIds: string[];
  acceptsAnyModel: boolean;
  configuredBySettings: boolean;
};

const BUILT_IN_ROUTES: Array<{
  id: BuiltInProviderRouteId;
  label: string;
  providerId: BuiltInProviderId;
  authentication: 'api-key' | 'subscription';
}> = [
  { id: 'openai-api', label: 'OpenAI API', providerId: 'openai', authentication: 'api-key' },
  {
    id: 'codex-subscription',
    label: 'ChatGPT Codex subscription',
    providerId: 'codex',
    authentication: 'subscription',
  },
  { id: 'gemini-api', label: 'Gemini API', providerId: 'gemini', authentication: 'api-key' },
  {
    id: 'dashscope-api',
    label: 'DashScope API',
    providerId: 'dashscope',
    authentication: 'api-key',
  },
  {
    id: 'openrouter-api',
    label: 'OpenRouter API',
    providerId: 'openrouter',
    authentication: 'api-key',
  },
  { id: 'ark-api', label: 'Volcengine Ark API', providerId: 'ark', authentication: 'api-key' },
  {
    id: 'meta-subscription',
    label: 'Meta subscription',
    providerId: 'meta',
    authentication: 'subscription',
  },
  { id: 'meta-api', label: 'Meta API', providerId: 'meta', authentication: 'api-key' },
];

const LEGACY_ROUTE_ALIASES: Partial<Record<BuiltInProviderId, BuiltInProviderRouteId>> = {
  openai: 'openai-api',
  codex: 'codex-subscription',
  gemini: 'gemini-api',
  dashscope: 'dashscope-api',
  openrouter: 'openrouter-api',
  ark: 'ark-api',
};

/** Return the canonical route id, preserving declared custom-provider ids. */
export function canonicalProviderRouteId(
  value: string,
  settings: ImageGenSettings,
): string | undefined {
  const requested = value.trim();
  if (isReservedProviderRouteId(requested)) return requested;
  if (customProviderRaw(settings, requested)) return requested;
  if (requested === 'meta') return undefined; // Deliberately ambiguous: API and login are separate.
  return isBuiltInProviderId(requested) ? LEGACY_ROUTE_ALIASES[requested] : undefined;
}

export function listProviderRoutes(settings: ImageGenSettings): ProviderRoute[] {
  const routes: ProviderRoute[] = BUILT_IN_ROUTES.map((route) => {
    const models = BUILT_IN_MODELS.filter((model) => model.provider === route.providerId).map(
      (model) => (route.providerId === 'codex' ? (model.remoteId ?? model.id) : model.id),
    );
    const provider = buildBuiltInProvider(route.providerId, settings);
    return {
      id: route.id,
      label: route.label,
      providerId: route.providerId,
      authentication: route.authentication,
      modelIds: [...new Set(models)],
      acceptsAnyModel: route.providerId === 'openrouter',
      configuredBySettings: route.authentication === 'api-key' && Boolean(provider?.apiKey),
    };
  });

  for (const [id, raw] of customProviderEntries(settings)) {
    // Authentication-specific built-in route ids are reserved and cannot be
    // shadowed by custom settings.
    if (isReservedProviderRouteId(id)) continue;
    const provider = buildCustomProvider(id, raw);
    if (!provider) continue;
    const models = customModels(raw).map((model) => model.alias);
    routes.push({
      id,
      label: provider.name,
      providerId: id,
      authentication: 'custom',
      modelIds: models,
      acceptsAnyModel: models.length === 0,
      configuredBySettings:
        provider.customAuth?.type === 'none' || Boolean(provider.apiKey),
    });
  }
  return routes;
}

function resolveModelOnRoute(
  modelOrAlias: string,
  selectedRoute: string,
  settings: ImageGenSettings,
): ResolvedModel | { error: string } {
  const requestedRoute = selectedRoute.trim();
  const routeId = canonicalProviderRouteId(requestedRoute, settings);
  if (!routeId) {
    const hint =
      requestedRoute === 'meta'
        ? 'Choose "meta-api" or "meta-subscription".'
        : `Run /image-gen list to see available provider routes.`;
    return { error: `Unknown image provider route "${requestedRoute}". ${hint}` };
  }

  let requested = modelOrAlias.trim();
  if (!requested) return { error: 'Model id is empty.' };
  const originalRequested = requested;
  let explicitlyQualified = false;
  for (const prefix of [`${routeId}/`, `${requestedRoute}/`]) {
    if (requested.startsWith(prefix)) {
      requested = requested.slice(prefix.length);
      explicitlyQualified = true;
    }
  }
  if (!requested) return { error: 'Model id is empty.' };

  const route = BUILT_IN_ROUTES.find((candidate) => candidate.id === routeId);
  const customRaw = route ? undefined : customProviderRaw(settings, routeId);
  if (customRaw) {
    const provider = buildCustomProvider(routeId, customRaw);
    if (!provider) return { error: `Custom provider "${routeId}" is invalid.` };
    const models = customModels(customRaw);
    const model =
      models.find(
        (candidate) =>
          candidate.alias === originalRequested || candidate.id === originalRequested,
      ) ?? models.find((candidate) => candidate.alias === requested || candidate.id === requested);
    if (!model && models.length > 0) {
      return {
        error: `Model "${originalRequested}" is not available through provider route "${routeId}". Available models: ${models.map((candidate) => candidate.alias).join(', ')}.`,
      };
    }
    // A catch-all accepts arbitrary slash-bearing model ids, so never assume a
    // leading route id is merely a qualifier. Explicit model lists can still
    // match the stripped convenience form above without corrupting remote ids.
    const remoteId = model?.id ?? originalRequested;
    const resolved: ResolvedModel = { provider, remoteId, requestedId: originalRequested };
    if (model) {
      const capabilities = inheritCapabilities(
        remoteId,
        model.capabilities,
        `customProviders.${routeId} model "${remoteId}"`,
      );
      if (capabilities) {
        resolved.capabilities = capabilities.capabilities;
        if (capabilities.declaredCapabilities) {
          resolved.declaredCapabilities = capabilities.declaredCapabilities;
        }
        resolved.capabilitiesIncludeRegistry = capabilities.includesRegistry;
      }
      if (hasExplicitQualityValues(model.capabilities)) resolved.customQualityValues = true;
    }
    return resolved;
  }

  if (!route) return { error: `Provider route "${routeId}" is invalid.` };
  const providerPrefix = `${route.providerId}/`;
  if (requested.startsWith(providerPrefix)) {
    requested = requested.slice(providerPrefix.length);
    explicitlyQualified = true;
  }
  if (!requested) return { error: 'Model id is empty.' };
  const model = BUILT_IN_MODELS.find(
    (candidate) =>
      candidate.provider === route.providerId &&
      (candidate.id === requested ||
        candidate.aliases?.includes(requested) ||
        (route.providerId === 'codex' && candidate.remoteId === requested)),
  );

  const knownForeignModel = findBuiltInModel(requested);
  if (
    !model &&
    route.authentication === 'api-key' &&
    route.providerId !== 'openrouter' &&
    knownForeignModel &&
    knownForeignModel.provider !== route.providerId
  ) {
    return {
      error: `Model "${requested}" belongs to a different built-in provider and is not available through provider route "${routeId}".`,
    };
  }

  // OpenRouter is an explicit pass-through route and does not maintain a fixed
  // model catalog. Other built-in routes allow explicitly qualified unknown
  // ids for private deployments, but never known models owned by another route.
  if (
    !model &&
    (route.providerId === 'openrouter' ||
      (explicitlyQualified && route.authentication === 'api-key'))
  ) {
    const provider = buildBuiltInProvider(route.providerId, settings)!;
    if (route.id === 'meta-api') provider.authMode = 'api-key';
    return { provider, remoteId: requested, requestedId: requested };
  }
  if (!model) {
    const available = BUILT_IN_MODELS.filter((candidate) => candidate.provider === route.providerId).map(
      (candidate) => (route.providerId === 'codex' ? (candidate.remoteId ?? candidate.id) : candidate.id),
    );
    return {
      error: `Model "${requested}" is not available through provider route "${routeId}".${available.length > 0 ? ` Available models: ${[...new Set(available)].join(', ')}.` : ''}`,
    };
  }

  const provider = buildBuiltInProvider(route.providerId, settings)!;
  if (route.id === 'codex-subscription') provider.authMode = 'oauth';
  if (route.id === 'meta-api') provider.authMode = 'api-key';
  if (route.id === 'meta-subscription') {
    provider.authMode = 'oauth';
    if (!canUseMetaOAuth(provider)) {
      return {
        error:
          'The meta-subscription route is available only on the official api.meta.ai endpoint. Use meta-api for an overridden endpoint.',
      };
    }
  }
  const resolved: ResolvedModel = {
    provider,
    remoteId: model.remoteId ?? model.id,
    requestedId: requested,
  };
  if (model.capabilities) resolved.capabilities = model.capabilities;
  return resolved;
}

function unknownModelError(requested: string, settings: ImageGenSettings): string {
  const customNames = customProviderEntries(settings)
    .map(([name]) => name)
    .filter((name) => !isReservedProviderRouteId(name));
  const lines = [`Unknown image model "${requested}".`];

  if (customNames.length > 0) {
    const explicit = customNames.filter((n) => {
      const m = customProviderRaw(settings, n)?.models;
      return Array.isArray(m) && m.length > 0;
    });
    if (explicit.length > 0) {
      lines.push(
        `Configured customProviders with explicit model lists: ${explicit.join(', ')}. The requested id didn't match any of their entries.`,
      );
    }
    lines.push(
      `To accept any model id without listing it, omit the "models" field on a customProvider — that provider then becomes a catch-all.`,
    );
  }

  const builtInIds = listKnownModelIds();
  lines.push(
    `Built-in model ids: ${builtInIds.slice(0, 10).join(', ')}${builtInIds.length > 10 ? ', ...' : ''}.`,
  );
  return lines.join(' ');
}

export function listKnownModelIds(): string[] {
  return BUILT_IN_MODELS.flatMap((m) => [m.id, ...(m.aliases ?? [])]);
}

export type ConfiguredProvider = ResolvedProvider & {
  /** True for customProviders without an explicit `models` list — accepts any unknown id. */
  catchAll: boolean;
  /** Number of model entries explicitly declared. */
  modelCount: number;
};

export function listConfiguredProviders(settings: ImageGenSettings): ConfiguredProvider[] {
  const out: ConfiguredProvider[] = [];
  for (const id of [
    'openai',
    'gemini',
    'dashscope',
    'openrouter',
    'ark',
    'meta',
  ] as BuiltInProviderId[]) {
    const provider = buildBuiltInProvider(id, settings);
    if (provider?.apiKey) out.push({ ...provider, catchAll: false, modelCount: 0 });
  }
  for (const [name, raw] of customProviderEntries(settings)) {
    if (isReservedProviderRouteId(name)) continue;
    const provider = buildCustomProvider(name, raw);
    if (provider) {
      const modelCount = customModels(raw).length;
      out.push({ ...provider, catchAll: modelCount === 0, modelCount });
    }
  }
  return out;
}

export function isReservedProviderRouteId(value: string): value is BuiltInProviderRouteId {
  return BUILT_IN_ROUTES.some((route) => route.id === value);
}

function hasExplicitQualityValues(
  capabilities: Partial<ImageModelCapabilities> | undefined,
): boolean {
  const values = capabilities?.qualityValues;
  return Boolean(
    Array.isArray(values) &&
      values.length > 0 &&
      values.every((value) => typeof value === 'string' && value.length > 0) &&
      new Set(values).size === values.length,
  );
}

const RESERVED_AUTH_HEADERS = new Set([
  'authorization',
  'content-length',
  'content-type',
  'host',
  'transfer-encoding',
]);

function parseCustomAuth(value: unknown): CustomProviderAuth | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return undefined;
  if (value.type === 'bearer' || value.type === 'none') {
    return Object.keys(value).length === 1 ? { type: value.type } : undefined;
  }
  if (
    value.type === 'header' &&
    Object.keys(value).length === 2 &&
    typeof value.header === 'string' &&
    /^[A-Za-z0-9-]+$/.test(value.header) &&
    !RESERVED_AUTH_HEADERS.has(value.header.toLowerCase())
  ) {
    return { type: 'header', header: value.header };
  }
  return undefined;
}

function trimCredential(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function customProviderEntries(settings: ImageGenSettings): Array<[string, unknown]> {
  const providers: unknown = settings.customProviders;
  return isRecord(providers) ? Object.entries(providers) : [];
}

function customProviderRaw(
  settings: ImageGenSettings,
  id: string,
): Record<string, unknown> | undefined {
  const providers: unknown = settings.customProviders;
  if (!isRecord(providers)) return undefined;
  const raw = providers[id];
  return isRecord(raw) ? raw : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string');
}

function isValidCustomModelEntry(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0 && value.trim() === value;
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    value.id.trim().length > 0 &&
    value.id.trim() === value.id &&
    (value.alias === undefined ||
      (typeof value.alias === 'string' &&
        value.alias.trim().length > 0 &&
        value.alias.trim() === value.alias))
  );
}

function isValidCustomProviderId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

function isCustomApiStyle(value: unknown): value is CustomApiStyle {
  return (
    value === 'openai' ||
    value === 'gemini' ||
    value === 'dashscope' ||
    value === 'openrouter' ||
    value === 'ark' ||
    value === 'meta'
  );
}

function isBuiltInProviderId(value: string): value is BuiltInProviderId {
  return (
    value === 'openai' ||
    value === 'gemini' ||
    value === 'dashscope' ||
    value === 'openrouter' ||
    value === 'ark' ||
    value === 'meta' ||
    value === 'codex'
  );
}
