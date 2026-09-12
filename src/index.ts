import { constants as fsConstants } from 'node:fs';
import { access, lstat, stat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { isProjectTrusted } from '@amaster.ai/pi-shared/settings';
import { StringEnum } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import {
  capabilitiesForApi,
  capabilitySizeDescription,
  genericCapabilitiesForApi,
  hasAspectRatioKnob,
  referenceImageDescription,
} from './capabilities.js';
import {
  canonicalProviderRouteId,
  isReservedProviderRouteId,
  listProviderRoutes,
  loadImageGenSettings,
  resolveModel,
} from './config.js';
import { errorMessageForUser, toLogSummary } from './errors.js';
import { generateImage } from './generate.js';
import { MAX_GENERATED_IMAGES, MAX_REFERENCE_IMAGE_INPUTS } from './image-input.js';
import { discoverOpenRouterCapabilities } from './openrouter-discovery.js';
import { canUseMetaOAuth } from './providers/meta.js';
import { SettingsWriteError, updateProjectImageGenSettings } from './settings-write.js';
import type {
  ApiStyle,
  GenerateImageParams,
  ImageGenResult,
  ImageGenSettings,
  ImageModelCapabilities,
  ImageModelRegistry,
} from './types.js';

export { loadImageGenSettings, resolveModel } from './config.js';
export { errorMessageForUser, toLogSummary } from './errors.js';
export { generateImage } from './generate.js';
export type { GenerateImageParams, ImageGenSettings } from './types.js';

/**
 * Quality levels advertised for providers whose `quality` vocabulary we have
 * verified: the built-in OpenAI gpt-image and OpenRouter image APIs. This is
 * deliberately NOT applied by wire format — a custom OpenAI-compatible provider
 * may use a different vocabulary (e.g. DALL·E 3 uses "standard"/"hd") or none at
 * all, so matching `api: "openai"` does not imply these values. See
 * {@link resolveImageToolCapabilities}.
 */
export const QUALITY_VALUES = ['low', 'medium', 'high', 'auto'] as const;

/** Provider-derived shape decisions for the `image_generate` schema. */
export interface ImageToolCapabilities {
  /** Active provider wire format, or null when the default model is unset/unresolvable. */
  api: ApiStyle | null;
  /** Allowed `quality` enum values, or null to omit `quality` from the schema entirely. */
  quality: readonly string[] | null;
  /**
   * Active model's capability contract — drives which of size/aspectRatio/
   * imageSize/n appear and with what enums, patterns, and descriptions. Null
   * (unset/unresolvable model, or a custom model with no contract) yields the
   * fully-generic fallback schema.
   */
  model: ImageModelCapabilities | null;
}

export default function piImageGenExtension(pi: ExtensionAPI): void {
  let settings: ImageGenSettings = {};
  let sessionCwd = process.cwd();
  let discoveredCapabilities: Partial<ImageModelCapabilities> | undefined;
  let discoveryRevision = 0;

  // Single generate path shared by the tool's execute() and the /image-gen
  // generate command, so options construction and signal wiring can't drift
  // between the two. Callers layer their own result formatting / error surface
  // on top (a tool result vs. a UI notification).
  const runGenerate = (
    params: GenerateImageParams,
    cwd: string,
    signal?: AbortSignal,
    modelRegistry?: ImageModelRegistry,
    onProgress?: (phase: 'loading-inputs' | 'waiting-provider' | 'saving-output') => void,
  ): Promise<ImageGenResult> => {
    const effectiveModel = resolveImageToolCapabilities(settings, discoveredCapabilities).model;
    const opts: Parameters<typeof generateImage>[1] = {
      cwd,
      settings,
      ...(effectiveModel ? { modelCapabilities: effectiveModel } : {}),
    };
    if (signal) opts.signal = signal;
    if (modelRegistry) opts.modelRegistry = modelRegistry;
    if (onProgress) opts.onProgress = onProgress;
    return generateImage(params, opts);
  };

  // Register (or re-register) the tool with a schema shaped for the currently
  // configured provider. `registerTool` is keyed by name, so a repeat call
  // overwrites the previous definition — we call this on session_start (once
  // settings are loaded) and again after `/image-gen reload`, so the parameter
  // set always reflects the active model. Notably, `quality` only appears for
  // providers whose API honors it; the model never sees a no-op knob it would
  // otherwise have to reason about.
  const registerImageTool = (): void => {
    const caps = resolveImageToolCapabilities(settings, discoveredCapabilities);
    pi.registerTool({
      name: 'image_generate',
      label: 'ImageGen',
      description:
        'Generate or edit images. The image provider route and model are fixed by pi-image-gen.defaultProvider/defaultModel in settings (this tool does not accept provider or model parameters). Pass `image` to do image-to-image / edit / style transfer / character preservation: a regular image file inside the session cwd (absolute or relative) or a public http(s) URL. To iterate on a previous result, pass its file path back when it is inside cwd. Do NOT pass base64 or data: URIs — write bytes to a file under cwd first. Saves the output to disk and returns the absolute path(s). When reporting the result to the user, render each generated image as inline markdown — copy the `![alt](…)` line(s) from the tool result verbatim so the UI can display it; do not just paste the bare path. Run /image-gen list to see the active model.',
      promptSnippet:
        'Generate or edit raster images (photos, illustrations, textures, mockups). Not for icons/logos/diagrams that should be repo-native SVG/CSS/canvas.',
      promptGuidelines: buildImageGuidelines(caps),
      parameters: buildImageToolParameters(caps) as never,
      async execute(_toolCallId: string, rawParams: unknown, signal, onUpdate, ctx) {
        const params = rawParams as GenerateImageParams;
        const cwd = ctx?.cwd ?? sessionCwd;
        try {
          const result = await runGenerate(
            params,
            cwd,
            signal,
            ctx.modelRegistry as unknown as ImageModelRegistry,
            (phase) => onUpdate?.({
              content: [{ type: 'text' as const, text: progressMessage(phase) }],
              details: { phase },
            }),
          );
          return {
            content: [{ type: 'text' as const, text: formatToolResultText(result) }],
            details: result,
          };
        } catch (error) {
          // Both surfaces are sanitized (see errors.ts): errorMessageForUser
          // returns an ImageGenError's vetted, body-free hint (and a generic
          // sentence for any unexpected throw), while toLogSummary gives stderr a
          // terse category. Neither echoes a raw fs/fetch error or response body.
          console.error(`[pi-image-gen] image_generate failed: ${toLogSummary(error)}`);
          throw new Error(`image_generate failed: ${errorMessageForUser(error)}`);
        }
      },
    });
  };

  const publishSettings = async (nextSettings: ImageGenSettings): Promise<boolean> => {
    const revision = ++discoveryRevision;
    let nextDiscovered: Partial<ImageModelCapabilities> | undefined;
    const model = trimmedSetting(nextSettings.defaultModel);
    if (model) {
      const resolved = resolveModel(model, nextSettings);
      if (!('error' in resolved)) {
        nextDiscovered = await discoverOpenRouterCapabilities(
          resolved,
          nextSettings.openRouterDiscovery !== false,
        );
      }
    }
    if (revision !== discoveryRevision) return false;
    // Publish one coherent snapshot: execute-time settings, discovered controls,
    // and the advertised schema must always advance together.
    settings = nextSettings;
    discoveredCapabilities = nextDiscovered;
    registerImageTool();
    return true;
  };

  pi.on('session_start', async (_event: unknown, ctx: ExtensionContext) => {
    sessionCwd = ctx.cwd;
    await publishSettings(loadImageGenSettings(ctx.cwd, isProjectTrusted(ctx)));
  });

  pi.registerCommand('image-gen', {
    description:
      'pi-image-gen: /image-gen [list|doctor|setup|reload|set provider <id>|set model <id>|use <provider> <model>|generate <prompt>]',
    getArgumentCompletions: (prefix: string) => imageGenCompletions(prefix, settings),
    handler: async (args: string | undefined, ctx: ExtensionContext) => {
      const raw = (args ?? '').trim();
      const tokens = raw.split(/\s+/).filter(Boolean);
      if (tokens[0] === 'doctor') {
        const report = await diagnoseImageGen(
          settings,
          ctx.cwd,
          ctx.modelRegistry as unknown as ImageModelRegistry,
        );
        ctx.ui.notify(report.join('\n'), report.some((line) => line.startsWith('ERROR')) ? 'error' : 'info');
        return;
      }
      if (tokens[0] === 'reload') {
        await publishSettings(loadImageGenSettings(ctx.cwd, isProjectTrusted(ctx)));
        ctx.ui.notify('pi-image-gen settings reloaded.', 'info');
        return;
      }
      if (tokens[0] === 'generate') {
        const prompt = raw.slice(tokens[0].length).trim();
        if (!prompt) {
          ctx.ui.notify('Usage: /image-gen generate <prompt>', 'error');
          return;
        }
        const cwd = ctx.cwd ?? sessionCwd;
        const commandController = new AbortController();
        const forwardAbort = () => commandController.abort(ctx.signal?.reason);
        ctx.signal?.addEventListener('abort', forwardAbort, { once: true });
        const dialogController = new AbortController();
        const cancellationDialog =
          ctx.mode === 'tui'
            ? ctx.ui
                .select('Generating image… Esc cancels', ['Cancel generation'], {
                  signal: dialogController.signal,
                })
                .then(() => {
                  if (!dialogController.signal.aborted) commandController.abort();
                })
            : undefined;
        try {
          const result = await runGenerate(
            { prompt },
            cwd,
            commandController.signal,
            ctx.modelRegistry as unknown as ImageModelRegistry,
            (phase) => ctx.ui.setStatus('pi-image-gen', progressMessage(phase)),
          );
          ctx.ui.notify(formatCommandSummary(result), 'info');
        } catch (error) {
          console.error(`[pi-image-gen] /image-gen generate failed: ${toLogSummary(error)}`);
          ctx.ui.notify(`image generation failed: ${errorMessageForUser(error)}`, 'error');
        } finally {
          ctx.signal?.removeEventListener('abort', forwardAbort);
          dialogController.abort();
          await cancellationDialog;
          ctx.ui.setStatus('pi-image-gen', undefined);
        }
        return;
      }

      const saveDefaults = async (
        update: Pick<ImageGenSettings, 'defaultProvider' | 'defaultModel'>,
      ): Promise<boolean> => {
        try {
          await updateProjectImageGenSettings(ctx.cwd, isProjectTrusted(ctx), update);
          await publishSettings(loadImageGenSettings(ctx.cwd, isProjectTrusted(ctx)));
          return true;
        } catch (error) {
          const message =
            error instanceof SettingsWriteError
              ? error.message
              : 'Could not update project settings.';
          ctx.ui.notify(message, 'error');
          return false;
        }
      };

      if (tokens[0] === 'setup') {
        if (!ctx.hasUI) {
          ctx.ui.notify('Guided setup needs an interactive Pi host. Use /image-gen list, then /image-gen use <provider> <model>.', 'error');
          return;
        }
        const login = discoverLoginRoutes(ctx.modelRegistry as unknown as ImageModelRegistry, settings);
        const routes = listProviderRoutes(settings).filter(
          (route) => route.configuredBySettings ||
            (route.id === 'codex-subscription' && login.codex) ||
            (route.id === 'meta-subscription' && login.meta),
        );
        if (routes.length === 0) {
          ctx.ui.notify('No configured API-key or custom routes were found. Configure authentication, then run /image-gen setup again.', 'error');
          return;
        }
        const routeChoice = await ctx.ui.select(
          'Choose an image provider',
          routes.map((route) => `${route.id} — ${route.label}`),
        );
        if (!routeChoice) return;
        const routeId = routeChoice.split(' — ')[0]!;
        const route = routes.find((candidate) => candidate.id === routeId)!;
        const models = route.modelIds.length > 0 ? route.modelIds : [];
        if (models.length === 0) {
          ctx.ui.notify(`Provider ${routeId} accepts pass-through model ids. Use /image-gen use ${routeId} <model>.`, 'info');
          return;
        }
        const model = await ctx.ui.select('Choose an image model', models);
        if (!model) return;
        if (!(await saveDefaults({ defaultProvider: routeId, defaultModel: model }))) return;
        ctx.ui.notify(`Using ${routeId} with ${model}.`, 'info');
        return;
      }

      if (tokens[0] === 'set' && tokens[1] === 'provider') {
        if (tokens.length !== 3) {
          ctx.ui.notify('Usage: /image-gen set provider <provider>', 'error');
          return;
        }
        const provider = canonicalProviderRouteId(tokens[2]!, settings);
        if (!provider) {
          const detail = tokens[2] === 'meta' ? ' Use meta-api or meta-subscription.' : '';
          ctx.ui.notify(`Unknown provider route "${tokens[2]}".${detail} Run /image-gen list.`, 'error');
          return;
        }
        if (!(await saveDefaults({ defaultProvider: provider }))) return;
        const current = trimmedSetting(settings.defaultModel);
        const pairing = current ? resolveModel(current, settings) : undefined;
        const warning = pairing && 'error' in pairing ? ` ${pairing.error}` : '';
        ctx.ui.notify(`Default provider set to ${provider}.${warning}`, warning ? 'warning' : 'info');
        return;
      }

      if (tokens[0] === 'set' && tokens[1] === 'model') {
        if (tokens.length !== 3) {
          ctx.ui.notify('Usage: /image-gen set model <model>', 'error');
          return;
        }
        if (!trimmedSetting(settings.defaultProvider)) {
          ctx.ui.notify(
            'Set a provider first, or use /image-gen use <provider> <model> to select both.',
            'error',
          );
          return;
        }
        const model = tokens[2]!;
        const pairing = resolveModel(model, { ...settings, defaultModel: model });
        if ('error' in pairing) {
          ctx.ui.notify(pairing.error, 'error');
          return;
        }
        if (!(await saveDefaults({ defaultModel: model }))) return;
        ctx.ui.notify(`Default model set to ${model}.`, 'info');
        return;
      }

      if (tokens[0] === 'use') {
        if (tokens.length !== 3) {
          ctx.ui.notify('Usage: /image-gen use <provider> <model>', 'error');
          return;
        }
        const provider = canonicalProviderRouteId(tokens[1]!, settings);
        if (!provider) {
          const detail = tokens[1] === 'meta' ? ' Use meta-api or meta-subscription.' : '';
          ctx.ui.notify(`Unknown provider route "${tokens[1]}".${detail} Run /image-gen list.`, 'error');
          return;
        }
        const model = tokens[2]!;
        const pairing = resolveModel(model, {
          ...settings,
          defaultProvider: provider,
          defaultModel: model,
        });
        if ('error' in pairing) {
          ctx.ui.notify(pairing.error, 'error');
          return;
        }
        if (!(await saveDefaults({ defaultProvider: provider, defaultModel: model }))) return;
        ctx.ui.notify(`Using ${provider} with ${model}.`, 'info');
        return;
      }

      if (tokens.length > 0 && tokens[0] !== 'list') {
        ctx.ui.notify(
          'Usage: /image-gen [list|doctor|setup|reload|set provider <id>|set model <id>|use <provider> <model>|generate <prompt>]',
          'error',
        );
        return;
      }

      const registry = ctx.modelRegistry as unknown as ImageModelRegistry;
      const loginStatus = discoverLoginRoutes(registry, settings);
      const routes = listProviderRoutes(settings).map((route) => ({
        ...route,
        configured:
          route.configuredBySettings ||
          (route.id === 'codex-subscription' && loginStatus.codex) ||
          (route.id === 'meta-subscription' && loginStatus.meta),
      }));
      const configured = routes.filter((route) => route.configured);
      const defaultModel = trimmedSetting(settings.defaultModel);
      const resolvedDefault = defaultModel ? resolveModel(defaultModel, settings) : undefined;
      const defaultProvider = describeDefaultProvider(settings, resolvedDefault, loginStatus.meta);
      const defaultProblem = resolvedDefault && 'error' in resolvedDefault ? resolvedDefault.error : undefined;
      const lines = [
        `Output directory: ${typeof settings.outputDir === 'string' && settings.outputDir.trim() ? settings.outputDir : '.pi/images'}`,
        `Default provider: ${defaultProvider}`,
        `Default model: ${defaultModel ?? '(not set)'}`,
        ...(defaultProblem ? [`  ! ${defaultProblem}`] : []),
        '',
        'Configured providers:',
        ...(configured.length > 0
          ? configured.map(
              (route) =>
                `  - ${route.label} (${route.id}; ${route.authentication === 'subscription' ? 'Pi login' : route.authentication})`,
            )
          : [
              '  (none — set OPENAI_API_KEY / GEMINI_API_KEY / DASHSCOPE_API_KEY / OPENROUTER_API_KEY / ARK_API_KEY / META_API_KEY, or use /login for Meta/Codex)',
            ]),
        '',
        'Available providers and models:',
        ...routes.flatMap((route) => [
          `  ${route.label} (${route.id}) [${route.configured ? 'configured' : 'not configured'}]`,
          ...(route.modelIds.length > 0
            ? route.modelIds.map((model) => `    - ${model}`)
            : route.acceptsAnyModel
              ? ['    - <model-id> (pass-through; provider catalog is not fixed)']
              : ['    - (no models declared)']),
        ]),
      ];
      ctx.ui.notify(lines.join('\n'), 'info');
    },
  });
}

export function imageGenCompletions(prefix: string, settings: ImageGenSettings): Array<{ value: string; label: string }> | null {
  const commands = ['list', 'doctor', 'setup', 'reload', 'generate', 'set provider', 'set model', 'use'];
  const raw = prefix.trimStart();
  const routes = listProviderRoutes(settings);
  const candidates = [...commands];
  for (const route of routes) {
    candidates.push(`set provider ${route.id}`);
    candidates.push(`use ${route.id}`);
    for (const model of route.modelIds) candidates.push(`use ${route.id} ${model}`);
  }
  const selected = trimmedSetting(settings.defaultProvider);
  const selectedRouteId = selected ? (canonicalProviderRouteId(selected, settings) ?? selected) : undefined;
  const selectedRoute = routes.find((route) => route.id === selectedRouteId);
  for (const model of selectedRoute?.modelIds ?? []) candidates.push(`set model ${model}`);
  const unique = [...new Set(candidates)]
    .filter((value) => value.startsWith(raw))
    .slice(0, 50)
    .map((value) => ({ value, label: value }));
  return unique.length > 0 ? unique : null;
}

export async function diagnoseImageGen(
  settings: ImageGenSettings,
  cwd: string,
  registry?: ImageModelRegistry,
): Promise<string[]> {
  const lines = ['pi-image-gen doctor'];
  const model = trimmedSetting(settings.defaultModel);
  const provider = trimmedSetting(settings.defaultProvider);
  if (!model) lines.push('ERROR: defaultModel is not set.');
  if (!provider) lines.push('WARN: defaultProvider is not set; legacy automatic routing is active.');
  if (model) {
    const resolved = resolveModel(model, settings);
    if ('error' in resolved) lines.push(`ERROR: ${resolved.error}`);
    else {
      const login = registry ? discoverLoginRoutes(registry, settings) : { codex: false, meta: false };
      const loginReady = resolved.provider.builtIn && (
        (resolved.provider.id === 'codex' && login.codex) ||
        (resolved.provider.id === 'meta' && login.meta && canUseMetaOAuth(resolved.provider))
      );
      const authReady = resolved.provider.builtIn && resolved.provider.id === 'codex'
        ? login.codex
        : resolved.provider.authMode === 'oauth'
          ? loginReady
          : resolved.provider.authMode === 'api-key'
            ? Boolean(resolved.provider.apiKey)
            : loginReady || resolved.provider.customAuth?.type === 'none' || Boolean(resolved.provider.apiKey);
      lines.push(`OK: ${resolved.provider.id}/${resolved.requestedId} resolves.`);
      lines.push(authReady ? 'OK: authentication is configured or resolved at request time.' : 'ERROR: authentication is not configured for the selected route.');
    }
  }
  if (settings.requestTimeoutMs !== undefined &&
      (!Number.isInteger(settings.requestTimeoutMs) || settings.requestTimeoutMs < 1_000 || settings.requestTimeoutMs > 900_000)) {
    lines.push('ERROR: requestTimeoutMs must be an integer from 1000 to 900000.');
  } else {
    lines.push(`OK: request timeout is ${settings.requestTimeoutMs ?? 120_000}ms.`);
  }
  const rawCustom = settings.customProviders as unknown;
  if (rawCustom !== undefined && (typeof rawCustom !== 'object' || rawCustom === null || Array.isArray(rawCustom))) {
    lines.push('ERROR: customProviders must be an object.');
  } else if (rawCustom && typeof rawCustom === 'object') {
    for (const [id, raw] of Object.entries(rawCustom as Record<string, unknown>)) {
      if (isReservedProviderRouteId(id)) {
        lines.push(`ERROR: custom provider ${id} uses a reserved route id.`);
        continue;
      }
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        lines.push(`ERROR: customProviders.${id} must be an object.`);
        continue;
      }
      const route = listProviderRoutes({ ...settings, customProviders: { [id]: raw as never } })
        .find((candidate) => candidate.id === id);
      lines.push(route ? `OK: custom provider ${id} is valid.` : `ERROR: custom provider ${id} is malformed or uses a reserved id.`);
    }
  }
  const configured = typeof settings.outputDir === 'string' && settings.outputDir.trim() ? settings.outputDir : '.pi/images';
  const output = isAbsolute(configured) ? configured : resolve(cwd, configured);
  let probe = output;
  while (true) {
    let info;
    try {
      info = await stat(probe);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        lines.push('ERROR: the configured output path cannot be inspected.');
        break;
      }
      try {
        const linkInfo = await lstat(probe);
        if (linkInfo.isSymbolicLink()) {
          lines.push('ERROR: the configured output path contains a dangling symbolic link.');
          break;
        }
      } catch (linkError) {
        if ((linkError as NodeJS.ErrnoException).code !== 'ENOENT') {
          lines.push('ERROR: the configured output path cannot be inspected.');
          break;
        }
      }
      const parent = dirname(probe);
      if (parent === probe) {
        lines.push('ERROR: no existing parent was found for the configured output directory.');
        break;
      }
      probe = parent;
      continue;
    }
    if (!info.isDirectory()) {
      lines.push('ERROR: the configured output path contains an existing non-directory component.');
      break;
    }
    try {
      await access(probe, fsConstants.W_OK | fsConstants.X_OK);
      lines.push('OK: output directory or its nearest existing parent is writable.');
    } catch {
      lines.push('ERROR: the configured output directory or its nearest existing parent is not writable.');
    }
    break;
  }
  if (!lines.some((line) => line.startsWith('ERROR'))) lines.push('PASS: no blocking configuration problems found.');
  return lines;
}

function progressMessage(phase: 'loading-inputs' | 'waiting-provider' | 'saving-output'): string {
  if (phase === 'loading-inputs') return 'Loading and validating image inputs…';
  if (phase === 'waiting-provider') return 'Waiting for the image provider…';
  return 'Saving generated image output…';
}

function trimmedSetting(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.trim() || undefined;
}

function discoverLoginRoutes(
  registry: ImageModelRegistry,
  settings: ImageGenSettings,
): { codex: boolean; meta: boolean } {
  try {
    const available = registry.getAvailable();
    const isOAuth = (model: (typeof available)[number]): boolean => {
      if (!registry.isUsingOAuth) return false;
      try {
        return registry.isUsingOAuth(model);
      } catch {
        return false;
      }
    };
    const codex = available.some(
      (model) => model.provider === 'openai-codex' && isOAuth(model),
    );
    const metaRoute = resolveModel('muse-image-1.0', {
      ...settings,
      defaultProvider: 'meta-subscription',
    });
    const officialMetaRoute = !('error' in metaRoute) && canUseMetaOAuth(metaRoute.provider);
    const meta =
      officialMetaRoute &&
      available.some((model) => model.provider === 'meta' && isOAuth(model));
    return { codex, meta };
  } catch {
    return { codex: false, meta: false };
  }
}

function describeDefaultProvider(
  settings: ImageGenSettings,
  resolved: ReturnType<typeof resolveModel> | undefined,
  hasMetaLogin: boolean,
): string {
  const selected = trimmedSetting(settings.defaultProvider);
  if (settings.defaultProvider !== undefined && !selected) return '(invalid: blank)';
  if (selected) return canonicalProviderRouteId(selected, settings) ?? `${selected} (invalid)`;
  if (!resolved || 'error' in resolved) return '(not set)';
  const provider = resolved.provider;
  if (!provider.builtIn) return `${provider.id} (inferred)`;
  if (provider.id === 'codex') return 'codex-subscription (inferred)';
  if (provider.id === 'meta') {
    return `${hasMetaLogin ? 'meta-subscription' : 'meta-api'} (inferred)`;
  }
  return `${provider.id}-api (inferred)`;
}

/**
 * The verified quality vocabulary is specific to OpenAI's **gpt-image**
 * family. Other OpenAI-wire models served under the same API use a different
 * vocabulary — DALL·E 3, for instance, takes `standard`/`hd` — so matching the
 * wire format (or even the built-in `openai` provider) is not enough; we must
 * see a gpt-image model id.
 *
 * This holds for two routes to gpt-image:
 *   - the built-in OpenAI provider (remote ids in the `gpt-image-*` family), and
 *   - OpenRouter, whose remote id embeds the underlying model (`openai/gpt-image-2`).
 *
 * It deliberately excludes `openai/dall-e-3` (built-in openai, but non-gpt-image)
 * and OpenRouter routes to non-OpenAI models (`bytedance-seed/seedream-4.5`, …).
 */
function honorsGptImageQuality(api: ApiStyle, remoteId: string): boolean {
  if (api !== 'openai' && api !== 'openrouter' && api !== 'codex') return false;
  return /(?:^|\/)gpt-image/i.test(remoteId);
}

/**
 * Derive the provider-dependent schema shape from settings.
 *
 * `quality` is exposed (as a constrained enum) ONLY when the resolved model is a
 * built-in-routed OpenAI gpt-image model — via the built-in `openai`, Codex, or
 * OpenRouter provider (see {@link honorsGptImageQuality}). For everything else — Gemini,
 * DashScope/Qwen, Ark/Seedream (no such knob), non-gpt-image OpenAI models like
 * DALL·E 3 (different vocabulary), and any custom provider (unknown vocabulary) —
 * `quality` is omitted so the model never sees a knob whose legal values we can't
 * guarantee. When the default model is unset or fails to resolve, we fall back to
 * the fully-featured schema so the tool stays usable and `execute` can surface a
 * friendly config error.
 */
export function resolveImageToolCapabilities(
  settings: ImageGenSettings,
  discovered?: Partial<ImageModelCapabilities>,
): ImageToolCapabilities {
  const defaultModel = trimmedSetting(settings.defaultModel);
  if (!defaultModel) return { api: null, quality: QUALITY_VALUES, model: null };
  const resolved = resolveModel(defaultModel, settings);
  if ('error' in resolved) return { api: null, quality: QUALITY_VALUES, model: null };
  const { provider } = resolved;
  const quality =
    provider.builtIn && honorsGptImageQuality(provider.api, resolved.remoteId)
      ? (resolved.capabilities?.qualityValues ?? QUALITY_VALUES)
      : !provider.builtIn &&
          resolved.customQualityValues &&
          (provider.api === 'openai' || provider.api === 'openrouter')
        ? (resolved.capabilities?.qualityValues ?? null)
        : null;
  const model = resolved.capabilities
    ? provider.builtIn || resolved.capabilitiesIncludeRegistry
      ? { ...(discovered ?? {}), ...resolved.capabilities }
      : {
          ...genericAdvertisedCapabilities(provider.api),
          ...(discovered ?? {}),
          ...(resolved.declaredCapabilities ?? {}),
        }
    : discovered
      ? { ...genericCapabilitiesForApi('openrouter'), ...discovered }
      : null;
  return {
    api: provider.api,
    quality,
    model: model ? capabilitiesForApi(model, provider.api) : null,
  };
}

/**
 * Fallback description for the `size` parameter when the active model has no
 * capability contract (custom providers without a registry match). Models
 * with a contract get a precise description from {@link capabilitySizeDescription}.
 */
function genericAdvertisedCapabilities(api: ApiStyle): ImageModelCapabilities {
  const capabilities = genericCapabilitiesForApi(api);
  if (api === 'gemini') {
    // `aspectRatios: ['auto']` is an internal validation fallback, not a model
    // declaration. Unknown partial Gemini contracts must keep both sizing
    // controls free-form unless the user explicitly narrows either field.
    delete capabilities.aspectRatios;
  }
  return capabilities;
}

export function sizeDescription(api: ApiStyle | null): string {
  if (api === 'ark') {
    return 'Image size such as "2048x2048". Seedream 5.0 / 5.0-lite / 4.5 require 2K or larger — "1024x1024" fails with InvalidParameter; only Seedream 4.0 accepts 1K sizes.';
  }
  if (api === 'meta') {
    return 'Image size passed to Meta\'s image_generation tool. Official cookbook examples include "1024x1024", "1536x1024", and "1024x1536"; the provider validates the complete supported set.';
  }
  return 'Image size hint such as "1024x1024". Provider-specific; ignored if unsupported.';
}

/** Capability-independent part of the `image` parameter description. */
const IMAGE_PARAM_BASE =
  'Optional reference image(s) for image-to-image / edit / style transfer / character preservation. Each entry MUST be either (a) a regular image file inside the session cwd — absolute or relative — or (b) a public http(s) URL. Symlinks, Base64 strings, and data: URIs are rejected; write raw image bytes to a file under cwd first. For a single image pass ["path"]. Multi-image conditioning is supported by OpenAI GPT Image models, Gemini, Qwen sync models, and Meta Muse Image. To iterate on a previous output inside cwd, pass that file path here.';

/**
 * Build the `image_generate` parameter schema for the resolved capabilities.
 * The invariant params are always present; everything else is shaped by the
 * active model's contract so the LLM sees exactly the knobs the provider
 * honors, with the documented values as ADVICE in enums and descriptions:
 * - `size` carries the model's documented form and limits in its description
 *   (never a schema pattern — the provider validates; private deployments may
 *   diverge from the cloud docs) and is hidden for Gemini-style models;
 * - `aspectRatio` / `imageSize` appear only for models that honor them
 *   (imageSize only when more than one tier exists);
 * - `n` carries the documented ceiling in its description (no `maximum`) and
 *   is hidden for models with no count knob;
 * - `image` spells out the model's documented reference-image contract;
 * - `quality` appears only when {@link resolveImageToolCapabilities} says the
 *   active provider honors it.
 */
export function buildImageToolParameters(caps: ImageToolCapabilities) {
  const model = caps.model;
  const aspectRatios = model && hasAspectRatioKnob(model) ? model.aspectRatios : undefined;
  const declaredImageSizes = model?.imageSizes;
  const tieredImageSizes = (declaredImageSizes?.length ?? 0) > 1 ? declaredImageSizes : undefined;
  const genericGemini = caps.api === 'gemini' && !aspectRatios;
  const genericImageSize = genericGemini && !declaredImageSizes;
  const showSize = !aspectRatios && !genericGemini;
  const sizeText = showSize
    ? ((model ? capabilitySizeDescription(model) : null) ?? sizeDescription(caps.api))
    : null;
  return Type.Object({
    prompt: Type.String({
      description: 'Text prompt describing what to generate or how to edit.',
    }),
    image: Type.Optional(
      Type.Array(Type.String(), {
        maxItems: MAX_REFERENCE_IMAGE_INPUTS,
        description: model
          ? `${IMAGE_PARAM_BASE} ${referenceImageDescription(model)}`
          : IMAGE_PARAM_BASE,
      }),
    ),
    ...(caps.api !== 'meta' && caps.api !== 'ark' && (!model || model.nMax > 1)
      ? {
          n: Type.Optional(
            Type.Integer({
              minimum: 1,
              maximum: MAX_GENERATED_IMAGES,
              // Model/provider ceilings remain advisory in the description,
              // while the extension-wide safety ceiling is enforced above.
              // A private deployment may still differ below that global ceiling.
              description: model
                ? `Number of images. Default 1 (integer; ${model.nMaxSource === 'extension' ? 'this extension supports' : 'the active model documents'} up to ${model.nMax}).`
                : `Number of images. Default 1 (integer; this extension supports up to ${MAX_GENERATED_IMAGES}).`,
            }),
          ),
        }
      : {}),
    ...(showSize && sizeText
      ? {
          size: Type.Optional(
            model?.sizes
              ? StringEnum(model.sizes, { description: sizeText })
              : Type.String({ description: sizeText }),
          ),
        }
      : {}),
    ...(aspectRatios || genericGemini
      ? {
          aspectRatio: Type.Optional(
            aspectRatios
              ? StringEnum(aspectRatios, {
                  description: 'Aspect ratio for the active model (it has no pixel-size knob).',
                })
              : Type.String({ description: 'Provider-supported aspect ratio such as "1:1" or "16:9".' }),
          ),
          ...(tieredImageSizes || genericImageSize
            ? {
                imageSize: Type.Optional(
                  tieredImageSizes
                    ? StringEnum(tieredImageSizes, {
                        description:
                          'Output resolution tier for the active model (uppercase "K"). Omit for the default tier.',
                      })
                    : Type.String({ description: 'Provider-supported output resolution tier such as "1K" or "2K".' }),
                ),
              }
            : {}),
        }
      : {}),
    ...(caps.quality
      ? {
          quality: Type.Optional(
            StringEnum(caps.quality, {
              description: caps.quality.includes('low')
                ? `Quality level honored by the active provider. Allowed values: ${caps.quality.join(', ')}. Use "low" for fast drafts/thumbnails and a higher quality for final assets or dense text.`
                : `Quality level honored by the active provider. Allowed values: ${caps.quality.join(', ')}. Choose the value that matches the requested output.`,
            }),
          ),
        }
      : {}),
    ...(model?.outputFormats?.length
      ? { outputFormat: Type.Optional(StringEnum(model.outputFormats, { description: 'Output image encoding.' })) }
      : {}),
    ...(model?.backgroundValues?.length
      ? { background: Type.Optional(StringEnum(model.backgroundValues, { description: 'Background behavior. Transparent output requires a format that preserves alpha.' })) }
      : {}),
    ...(model?.supportsOutputCompression
      ? { outputCompression: Type.Optional(Type.Integer({ minimum: 0, maximum: 100, description: 'JPEG/WebP compression level from 0 to 100.' })) }
      : {}),
    ...(model?.supportsMask
      ? { mask: Type.Optional(Type.String({ description: 'Mask image path or public URL for precise editing. Requires at least one image edit target; transparent mask regions are replaced.' })) }
      : {}),
    ...(model?.supportsNegativePrompt
      ? { negativePrompt: Type.Optional(Type.String({ description: 'Provider-native description of content to avoid.' })) }
      : {}),
    ...(model?.supportsSeed
      ? { seed: Type.Optional(Type.Integer({ minimum: 0, maximum: 2_147_483_647, description: 'Provider seed for more reproducible results; exact identity is not guaranteed.' })) }
      : {}),
    ...(model?.supportsPromptEnhance
      ? { promptEnhance: Type.Optional(Type.Boolean({ description: 'Allow provider-native prompt enhancement.' })) }
      : {}),
    ...(model?.supportsThinking
      ? { enableThinking: Type.Optional(Type.Boolean({ description: 'Enable provider-side image reasoning; may increase latency.' })) }
      : {}),
    ...(model?.supportsWatermark
      ? { watermark: Type.Optional(Type.Boolean({ description: 'Add the provider AI watermark. Default false.' })) }
      : {}),
    ...(model?.supportsSeries
      ? { seriesMaxImages: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_GENERATED_IMAGES, description: 'Maximum related images for a Seedream series; this is not the same as independent n variants.' })) }
      : {}),
    filename: Type.Optional(Type.String({ description: 'Filename prefix (without extension).' })),
    outputDir: Type.Optional(
      Type.String({
        description:
          'Directory to write images into. Relative paths resolve against the session cwd.',
      }),
    ),
  });
}

/**
 * Build the tool's prompt guidelines for the resolved capabilities. Most bullets
 * are provider-independent; the `quality` tip is included only when the schema
 * actually exposes a `quality` param, so guidance never references a knob the
 * model cannot use.
 */
export function buildImageGuidelines(caps: ImageToolCapabilities): string[] {
  const showN =
    caps.api !== 'meta' && caps.api !== 'ark' && (!caps.model || caps.model.nMax > 1);
  const guidelines = [
    'Use image_generate for bitmap assets: photos, illustrations, textures, sprites, product/UI mockups, concept art. Do NOT use it for icons, logos, or diagrams that should match existing repo-native SVG/vector/CSS/canvas assets — edit or write those directly instead.',
    'Generate vs edit: with no `image`, or when `image` entries are only style/composition/mood references, this is a fresh generation. To modify an existing image while preserving most of it, pass that image and describe the change as an edit.',
    ...(showN
      ? [
          '`n` produces variants of ONE prompt, not distinct assets. For several different assets, make one image_generate call per asset with its own prompt (do not raise `n` to cover distinct subjects).',
        ]
      : []),
    'For edits and multi-image conditioning, label each reference by role (e.g. "Image 1: edit target; Image 2: style reference") and restate invariants every iteration ("change only X; keep Y unchanged") to reduce drift.',
    'For text inside an image, quote the exact string verbatim and specify placement; spell uncommon words letter-by-letter when accuracy matters.',
  ];
  guidelines.push(
    caps.quality?.includes('low')
      ? 'Prefer one targeted change per iteration over rewriting the whole prompt. Use `quality: "low"` for fast drafts and a higher `quality` for final assets or dense text.'
      : caps.quality
        ? `Prefer one targeted change per iteration over rewriting the whole prompt. Choose quality from the active values: ${caps.quality.join(', ')}.`
        : 'Prefer one targeted change per iteration over rewriting the whole prompt.',
  );
  if (caps.model && hasAspectRatioKnob(caps.model)) {
    guidelines.push(
      'The active model has no pixel-`size` knob — set `aspectRatio` (and `imageSize` where offered) instead; passing `size` is rejected.',
    );
  }
  guidelines.push(
    'The active model is fixed in settings — there is no `model` parameter. If generation fails on model/size, run /image-gen list and tell the user which knob (defaultModel or size) to adjust.',
  );
  return guidelines;
}

/**
 * Format a generated-image result as text the LLM can paste verbatim into its
 * reply. Uses inline markdown image syntax with the file stem as the alt text.
 */
export function formatToolResultText(result: ImageGenResult): string {
  const lines: string[] = [
    `Generated ${result.images.length} image(s) via ${result.provider} (${result.model}). Show each one to the user as inline markdown — copy the lines below verbatim into your reply:`,
    '',
    ...result.images.flatMap((img) => {
      const alt = altFromPath(img.path);
      const md = `![${alt}](${markdownImageUrl(img.path)})`;
      const dimensions = img.dimensions ? ` (${img.dimensions.width}×${img.dimensions.height})` : '';
      return img.revisedPrompt ? [`${md}${dimensions}`, `> revised prompt: ${img.revisedPrompt}`] : [`${md}${dimensions}`];
    }),
  ];
  if (result.metadata?.requestId) lines.push('', `Request ID: ${result.metadata.requestId}`);
  if (result.metadata?.usage) lines.push(`Usage: ${formatNumericMetadata(result.metadata.usage)}`);
  if (result.metadata?.cost != null) lines.push(`Cost: ${result.metadata.cost}`);
  if (result.metadata) lines.push(`Duration: ${result.metadata.durationMs}ms`);
  return lines.join('\n');
}

/**
 * Markdown-safe image URL for a saved absolute path — valid CommonMark for
 * any host renderer (desktop, TUI, CLI alike):
 * - Windows drive-letter paths (`C:\…`) become percent-encoded
 *   `file:///C:/…` URLs — markdown URL sanitizers read `C:` as an unknown
 *   URI scheme and strip the img `src` otherwise.
 * - POSIX paths stay bare absolute paths; only markdown/URL-unsafe
 *   characters are percent-escaped, so clean paths stay byte-identical.
 * Hand-rolled (not pathToFileURL) so the Windows case behaves the same on
 * every OS and stays testable off-Windows.
 */
export function markdownImageUrl(absolutePath: string): string {
  const drive = /^([A-Za-z]:)[\\/]/.exec(absolutePath)?.[1];
  if (!drive) return escapeMarkdownUnsafe(absolutePath);
  const segments = absolutePath
    .slice(3)
    .split(/[\\/]+/)
    .filter(Boolean)
    .map(encodeUrlSegment);
  return `file:///${drive}/${segments.join('/')}`;
}

/**
 * file:// URLs must be ASCII, so Windows path segments get full
 * percent-encoding; ( ) additionally need escaping (encodeURIComponent
 * leaves them) or they unbalance the markdown link destination.
 */
function encodeUrlSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/[()]/g, hexEscape);
}

/**
 * Escape just the characters that break a bare path inside a markdown link
 * destination or a URL parse: whitespace, # ? % < > and ( ). Everything else
 * — including CJK — passes through byte-identical, so POSIX paths that render
 * inline today keep their exact current output.
 */
function formatNumericMetadata(metadata: Record<string, number>): string {
  return Object.entries(metadata)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}=${value}`)
    .join(', ');
}

function escapeMarkdownUnsafe(path: string): string {
  return path.replace(/[\s#%()?<>]/g, hexEscape);
}

function hexEscape(ch: string): string {
  return `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`;
}

/**
 * Format a generated-image result as a plain-text summary for `ctx.ui.notify`,
 * which renders a status line rather than markdown. Lists the saved absolute
 * paths (and any revised prompt) without `![](…)` syntax, which notify would
 * otherwise show literally.
 */
export function formatCommandSummary(result: ImageGenResult): string {
  const header = `Generated ${result.images.length} image(s) via ${result.provider} (${result.model}):`;
  const lines = result.images.flatMap((img) =>
    img.revisedPrompt
      ? [`  ${img.path}`, `    revised prompt: ${img.revisedPrompt}`]
      : [`  ${img.path}`],
  );
  const metadata = result.metadata
    ? [
        `  duration: ${result.metadata.durationMs}ms`,
        ...(result.metadata.requestId ? [`  request id: ${result.metadata.requestId}`] : []),
        ...(result.metadata.usage ? [`  usage: ${formatNumericMetadata(result.metadata.usage)}`] : []),
        ...(result.metadata.cost != null ? [`  cost: ${result.metadata.cost}`] : []),
      ]
    : [];
  return [header, ...lines, ...metadata].join('\n');
}

/**
 * Derive a markdown `alt` from the saved file path. We use the filename without
 * its extension so the user-supplied `filename` (or our auto-generated stamp)
 * shows up in the rendered image label, not the model id.
 */
export function altFromPath(absolutePath: string): string {
  const segments = absolutePath.split(/[\\/]/);
  const base = segments[segments.length - 1] ?? 'image';
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  // Escape `]` so the markdown link doesn't break if the filename has one.
  return stem.replace(/\]/g, '\\]') || 'image';
}
