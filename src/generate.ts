import { RasterError, validateResize } from './node/raster.js';
import { generateImageCore } from './core/engine.js';
import { canonicalProviderRouteId, configuredImageRoutes, normalizeImageGenSettings } from './config.js';
import { prepareImageRequest } from './core/prepare.js';
import { legacyNumericUsage } from './core/usage.js';
import { desktopRoute, desktopTimeout } from './desktop/configuration.js';
import { ImageCoreError } from './core/outcome.js';
import { cancelledError, errorMessageForUser, ImageGenError, type RetainedPartialFailure } from './errors.js';
import { desktopHost } from './desktop/host.js';
import { desktopSink } from './desktop/output-sink.js';
import type { GenerateImageOptions } from './desktop/options.js';
import type { ImageCallResult } from './core/protocol.js';
import type { GeneratedImage } from './types.js';
import type { GenerateImageParams, ImageGenResult, ImageRouteAttempt, ImageRouteSelection } from './types.js';

export type { GenerateImageOptions } from './desktop/options.js';

/** Existing desktop API; filesystem/auth/security stay outside the shared portable engine. */
export async function generateImage(
  params: GenerateImageParams,
  options: GenerateImageOptions,
): Promise<ImageGenResult> {
  if (options.signal?.aborted) throw cancelledError('image generation');
  try { validateResize(params.resize); }
  catch (error) { throw new ImageGenError(error instanceof RasterError ? error.message : 'Invalid resize.', 'invalid resize'); }
  const settings = normalizeImageGenSettings(options.settings);
  const fallbacks = configuredImageRoutes(settings, 'fallback');
  const primary = desktopRoute(params, { ...options, settings });
  const primarySelection: ImageRouteSelection = {
    provider: settings.defaultProvider
      ? canonicalProviderRouteId(settings.defaultProvider, settings) ?? settings.defaultProvider
      : primary.provider.id,
    model: primary.requestedId,
  };
  const selections = [primarySelection, ...fallbacks];
  const attempts: ImageRouteAttempt[] = [];
  let accumulated: RetainedPartialFailure | undefined;
  for (const [index, selection] of selections.entries()) {
    if (options.signal?.aborted) throw cancelledError('image generation');
    const { modelCapabilities, ...shared } = options;
    const attemptOptions: GenerateImageOptions = index === 0
      ? { ...options, settings }
      : { ...shared, settings: { ...settings, defaultProvider: selection.provider, defaultModel: selection.model } };
    try {
      const result = await generateSingleImage(params, attemptOptions);
      if (attempts.length) {
        attempts.push({ route: selection, status: 'success' });
        return { ...result, attempts };
      }
      return result;
    } catch (error) {
      attempts.push({ route: selection, status: 'failed', error: errorMessageForUser(error) });
      if (options.retainPartialOutputs && error instanceof ImageGenError && error.partial) {
        accumulated = mergeRetainedPartial(accumulated, error.partial);
      }
      if (options.signal?.aborted || !(error instanceof ImageGenError) || !error.fallbackReason || index === selections.length - 1) {
        if (attempts.length === 1) throw error;
        throw new ImageGenError(
          `${errorMessageForUser(error)} Attempted routes: ${attempts.map((attempt) => `${attempt.route.provider}/${attempt.route.model}`).join(', ')}. No further fallback was attempted.`,
          error instanceof ImageGenError ? error.logSummary : 'image fallback failed',
          undefined,
          options.retainPartialOutputs ? accumulated : undefined,
        );
      }
    }
  }
  throw new ImageGenError('No image route is configured.', 'image route missing');
}

/** Combine retained receipts across failed attempts; latest attempt owns timing and accounting. */
function mergeRetainedPartial(
  current: RetainedPartialFailure | undefined,
  next: RetainedPartialFailure,
): RetainedPartialFailure {
  return {
    images: [...(current?.images ?? []), ...next.images],
    dispatched: (current?.dispatched ?? false) || next.dispatched,
    uncertain: (current?.uncertain ?? false) || next.uncertain,
    storageUncertain: (current?.storageUncertain ?? false) || next.storageUncertain,
    durationMs: next.durationMs,
    ...(next.requestId !== undefined ? { requestId: next.requestId }
      : current?.requestId !== undefined ? { requestId: current.requestId } : {}),
    ...(next.reportedUsage !== undefined ? { reportedUsage: next.reportedUsage }
      : current?.reportedUsage !== undefined ? { reportedUsage: current.reportedUsage } : {}),
    ...(next.tokenUsage !== undefined ? { tokenUsage: next.tokenUsage }
      : current?.tokenUsage !== undefined ? { tokenUsage: current.tokenUsage } : {}),
    costDetails: next.costDetails,
  };
}

/** Shape confirmed receipts plus safe outcome metadata for a retaining caller. */
function retainedPartial(images: readonly GeneratedImage[], error: ImageCoreError): RetainedPartialFailure {
  const metadata = error.metadata;
  return {
    images: [...images],
    dispatched: error.outcome.dispatched,
    uncertain: error.outcome.uncertain,
    storageUncertain: error.outcome.storageUncertain,
    durationMs: metadata.durationMs,
    ...(metadata.requestId ? { requestId: metadata.requestId } : {}),
    ...(metadata.reportedUsage ? { reportedUsage: metadata.reportedUsage } : {}),
    ...(metadata.tokenUsage ? { tokenUsage: metadata.tokenUsage } : {}),
    costDetails: metadata.cost,
  };
}

/** One dispatch only; orchestration above never changes provider adapter semantics. */
async function generateSingleImage(params: GenerateImageParams, options: GenerateImageOptions): Promise<ImageGenResult> {
  const route = desktopRoute(params, options);
  const { outputDir: _outputDir, resize: _resize, ...args } = params;
  const request = prepareImageRequest(args, {}, route);
  const sink = desktopSink(params, options, route.requestedId);
  let result: ImageCallResult<GeneratedImage>;
  try {
    result = await generateImageCore(request, desktopHost(request, options, sink));
  } catch (error) {
    const retain = options.retainPartialOutputs === true;
    if (!retain) {
      await sink.cleanup();
    }
    if (error instanceof ImageCoreError) {
      const partial = retain ? retainedPartial(sink.retained(), error) : undefined;
      if (error.logSummary === 'image generation timed out') {
        const seconds = Math.round(desktopTimeout(options.settings.requestTimeoutMs) / 1000);
        throw new ImageGenError(`Image generation exceeded the ${seconds} second request timeout. Increase pi-image-gen.requestTimeoutMs if this provider normally needs longer.`, error.logSummary, undefined, partial);
      }
      // Retaining callers keep confirmed files and report their receipts; the
      // desktop default still cleans up partial batches.
      throw new ImageGenError(error.message, error.logSummary, error.fallbackReason, partial);
    }
    throw error;
  }
  // Original storage is committed. Optional local processing must stay outside rollback.
  const metadata = result.metadata;
  const usage = legacyNumericUsage(metadata.reportedUsage);
  return {
    model: route.requestedId,
    provider: route.provider.builtIn ? route.provider.id : `${route.provider.id} (custom)`,
    images: await sink.resizeSaved(result.images),
    metadata: {
      durationMs: metadata.durationMs,
      ...(metadata.requestId ? { requestId: metadata.requestId } : {}),
      ...(usage ? { usage } : {}),
      ...(metadata.reportedUsage ? { reportedUsage: metadata.reportedUsage } : {}),
      ...(metadata.tokenUsage ? { tokenUsage: metadata.tokenUsage } : {}),
      costDetails: metadata.cost,
      // Preserve the public numeric reported-cost contract; never disguise an estimate as actual.
      ...(metadata.cost.kind === 'reported' && metadata.cost.basis === 'provider-response'
        ? { cost: metadata.cost.amount } : {}),
    },
  };
}
