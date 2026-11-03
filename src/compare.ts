import { configuredImageRoutes, normalizeImageGenSettings } from './config.js';
import { errorMessageForUser, ImageGenError } from './errors.js';
import { generateImage, type GenerateImageOptions } from './generate.js';
import type { CompareImageParams, ImageCompareResult } from './types.js';

/** Explicit fan-out over configured routes. Never changes defaults or uses fallback. */
export async function compareImages(
  params: CompareImageParams,
  options: GenerateImageOptions,
): Promise<ImageCompareResult> {
  const settings = normalizeImageGenSettings(options.settings);
  const routes = configuredImageRoutes(settings, 'compare');
  if (!routes.length) {
    throw new ImageGenError('Configure pi-image-gen.compare with at least one provider/model pair before comparing images.', 'image comparison routes missing');
  }
  const { modelCapabilities: _defaultCapabilities, ...shared } = options;
  const entries: ImageCompareResult['entries'] = [];
  for (const [index, route] of routes.entries()) {
    if (options.signal?.aborted) {
      entries.push({ route, status: 'cancelled', error: 'Comparison cancelled; this route was not started.' });
      continue;
    }
    try {
      const result = await generateImage({
        prompt: params.prompt,
        ...(params.image ? { image: params.image } : {}),
        ...(params.filename ? { filename: `${params.filename}-${index + 1}` } : {}),
        ...(params.outputDir ? { outputDir: params.outputDir } : {}),
      }, {
        ...shared,
        settings: { ...settings, defaultProvider: route.provider, defaultModel: route.model, fallback: [] },
      });
      entries.push({ route, status: 'success', result });
    } catch (error) {
      const partial = error instanceof ImageGenError ? error.partial : undefined;
      entries.push({
        route,
        status: options.signal?.aborted ? 'cancelled' : 'failed',
        error: errorMessageForUser(error),
        ...(partial && partial.images.length > 0 ? { partialImages: [...partial.images] } : {}),
      });
    }
  }
  return { entries };
}
