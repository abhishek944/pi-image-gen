import { ImageGenError } from './errors.js';
import type { GenerateImageParams, ImageModelCapabilities } from './types.js';

/**
 * Capability-driven description helpers, shared by the tool schema builder
 * (index.ts) and the generate path (generate.ts).
 *
 * Philosophy: the capability contract is ADVICE, not a gate. The documented
 * values are rendered into the tool schema's descriptions so the LLM picks
 * valid values on the first call; anything it still gets wrong is answered
 * by the provider's own error — private deployments and gateways may
 * legitimately diverge from the cloud platform's documented limits, so
 * numeric limits (size ranges, n ceilings, reference counts/bytes) are never
 * hard-enforced client-side. The only pre-flight rejections are parameter
 * combinations OUR adapters would silently drop (see validateGenerateParams).
 */

/** Shared pixel-size matcher ("<w>x<h>" or "<w>*<h>") — also used by the DashScope adapter. */
export const SIZE_PIXEL_RE = /^(\d{2,5})\s*[x*]\s*(\d{2,5})$/i;

/** True when the model uses aspectRatio/imageSize instead of a pixel size. */
export function hasAspectRatioKnob(caps: ImageModelCapabilities): boolean {
  return Boolean(caps.aspectRatios?.length);
}

/** True when the schema should expose an `imageSize` enum for this model. */
export function hasImageSizeKnob(caps: ImageModelCapabilities): boolean {
  return hasAspectRatioKnob(caps) && (caps.imageSizes?.length ?? 0) > 1;
}

/** Human-readable ratio bound: 1/8 → "1:8", 3 → "3:1", 2.5 → "2.5:1". */
function formatRatio(value: number): string {
  if (value < 1) {
    const inverse = 1 / value;
    return `1:${Number.isInteger(inverse) ? inverse : inverse.toFixed(1)}`;
  }
  return `${Number.isInteger(value) ? value : value.toFixed(1)}:1`;
}

/**
 * `size` parameter description for a capability-bearing model. Returns null
 * when the model has no pixel-size knob (Gemini aspect-ratio models) — the
 * schema must hide the param entirely in that case. The documented limits are
 * stated as advice ("documented…"); the provider remains the authority.
 */
export function capabilitySizeDescription(caps: ImageModelCapabilities): string | null {
  if (hasAspectRatioKnob(caps)) return null;
  if (caps.sizes) {
    return `Image size. Documented values: ${caps.sizes.join(', ')}. Omit to use the model default.`;
  }
  const range = caps.sizeRange;
  if (!range) return null;
  const example = range.separator === '*' ? '2048*2048' : '2048x2048';
  const parts = [
    `Image size as "<width>${range.separator}<height>" (e.g. "${example}"). Documented limits: total pixels ${range.minArea}–${range.maxArea}`,
  ];
  if (range.minRatio != null && range.maxRatio != null) {
    parts.push(`width/height ratio ${formatRatio(range.minRatio)}–${formatRatio(range.maxRatio)}`);
  }
  if (range.divisibleBy) parts.push(`dimensions divisible by ${range.divisibleBy}`);
  if (range.maxEdge) parts.push(`longest edge at most ${range.maxEdge}px`);
  let text = `${parts.join('; ')}.`;
  if (range.tiers) {
    text += ` Alternatively a tier token: ${range.tiers.join(', ')} — do not mix the two forms.`;
  }
  if (range.allowAuto) text += ' "auto" lets the model pick.';
  text += ' Out-of-range values are rejected by the provider; omit to use the model default.';
  return text;
}

/**
 * Suffix for the `image` parameter description spelling out the active
 * model's documented reference-image contract (formats, count, byte ceiling,
 * advisory) — advisory text; the provider enforces its own limits.
 */
export function referenceImageDescription(caps: ImageModelCapabilities): string {
  const mb = Math.round(caps.inputMaxBytes / (1024 * 1024));
  let text = `The active model documents up to ${caps.maxReferenceImages} reference image(s) — formats: ${caps.inputFormats.join('/')}; each up to ${mb}MB.`;
  if (caps.inputDimAdvice) text += ` ${caps.inputDimAdvice}.`;
  return text;
}

/**
 * Pre-flight guards against parameter combinations OUR adapters would
 * silently drop — the provider never sees them, so it cannot be the backstop
 * (a pixel size passed to a Gemini aspect-ratio model, or aspectRatio/
 * imageSize passed to a pixel-size model). Documented numeric limits are
 * deliberately NOT enforced here: they are advice in the schema descriptions,
 * and the provider's own error is the backstop for anything out of range.
 */
export function validateGenerateParams(
  params: GenerateImageParams,
  caps: ImageModelCapabilities,
  modelId: string,
): void {
  if (params.n != null && (!Number.isInteger(params.n) || params.n < 1)) {
    throw new ImageGenError(`n must be a positive integer (got ${params.n}).`, 'n invalid');
  }
  if (hasAspectRatioKnob(caps)) {
    if (params.size) {
      throw new ImageGenError(
        `${modelId} has no pixel-size knob — pass aspectRatio${hasImageSizeKnob(caps) ? ' (and optionally imageSize)' : ''} instead of size.`,
        'size unsupported by model',
      );
    }
    return;
  }
  if (params.aspectRatio || params.imageSize) {
    throw new ImageGenError(
      `${modelId} does not accept aspectRatio/imageSize — use size instead.`,
      'aspect knobs unsupported by model',
    );
  }
}

/**
 * Shape-check a user-supplied capability declaration (customProviders model
 * entry). Invalid fields are dropped with a stderr warning rather than
 * flowing into the tool schema and validators — settings are a trust boundary
 * (CLAUDE.md), and pi-video-gen enforces the same at settings load. Returns a
 * clean Partial; valid fields pass through untouched.
 */
export function sanitizeCapabilities(
  explicit: Partial<ImageModelCapabilities>,
  owner: string,
): Partial<ImageModelCapabilities> {
  const clean: Partial<ImageModelCapabilities> = {};
  const drop = (key: string, value: unknown, rule: string) => {
    console.error(
      `[pi-image-gen] ignoring invalid capabilities.${key} for ${owner}: expected ${rule}, got ${JSON.stringify(value)?.slice(0, 80)}`,
    );
  };
  const stringArray = (v: unknown): v is string[] =>
    Array.isArray(v) && v.every((s) => typeof s === 'string' && s.length > 0);

  for (const [key, value] of Object.entries(explicit)) {
    if (value === undefined) continue;
    switch (key) {
      case 'nMax':
        if (Number.isInteger(value) && (value as number) >= 1) clean.nMax = value as number;
        else drop(key, value, 'an integer ≥ 1');
        break;
      case 'maxReferenceImages':
        if (Number.isInteger(value) && (value as number) >= 0)
          clean.maxReferenceImages = value as number;
        else drop(key, value, 'an integer ≥ 0');
        break;
      case 'inputMaxBytes':
        if (typeof value === 'number' && Number.isFinite(value) && value > 0)
          clean.inputMaxBytes = value;
        else drop(key, value, 'a positive number');
        break;
      case 'inputFormats':
        if (stringArray(value)) clean.inputFormats = value;
        else drop(key, value, 'an array of format labels');
        break;
      case 'sizes':
        if (stringArray(value)) clean.sizes = value;
        else drop(key, value, 'an array of size strings');
        break;
      case 'aspectRatios':
        if (stringArray(value)) clean.aspectRatios = value;
        else drop(key, value, 'an array of aspect ratios');
        break;
      case 'imageSizes':
        if (stringArray(value)) clean.imageSizes = value;
        else drop(key, value, 'an array of size tiers');
        break;
      case 'inputDimAdvice':
        if (typeof value === 'string' && value.length > 0) clean.inputDimAdvice = value;
        else drop(key, value, 'a non-empty string');
        break;
      case 'sizeRange': {
        const range = sanitizeSizeRange(value, key, owner, drop);
        if (range) clean.sizeRange = range;
        break;
      }
      default:
        drop(key, value, 'a known capabilities field');
    }
  }
  return clean;
}

function sanitizeSizeRange(
  value: unknown,
  key: string,
  owner: string,
  drop: (key: string, value: unknown, rule: string) => void,
): ImageModelCapabilities['sizeRange'] | undefined {
  if (typeof value !== 'object' || value === null) {
    drop(key, value, 'a sizeRange object');
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const separator = raw.separator === 'x' || raw.separator === '*' ? raw.separator : undefined;
  const minArea = typeof raw.minArea === 'number' && raw.minArea > 0 ? raw.minArea : undefined;
  const maxArea = typeof raw.maxArea === 'number' && raw.maxArea > 0 ? raw.maxArea : undefined;
  if (!separator || minArea == null || maxArea == null || maxArea <= minArea) {
    console.error(
      `[pi-image-gen] ignoring invalid capabilities.sizeRange for ${owner}: separator must be "x" or "*" and 0 < minArea < maxArea`,
    );
    return undefined;
  }
  const range: NonNullable<ImageModelCapabilities['sizeRange']> = { separator, minArea, maxArea };
  if (typeof raw.minRatio === 'number' || typeof raw.maxRatio === 'number') {
    // The ratio pair is checked like the area pair: an inverted pair would
    // otherwise pass the shape check and make validateSize reject everything.
    if (
      typeof raw.minRatio === 'number' &&
      typeof raw.maxRatio === 'number' &&
      raw.minRatio > 0 &&
      raw.maxRatio > raw.minRatio
    ) {
      range.minRatio = raw.minRatio;
      range.maxRatio = raw.maxRatio;
    } else {
      console.error(
        `[pi-image-gen] ignoring capabilities.sizeRange ratio bounds for ${owner}: expected 0 < minRatio < maxRatio`,
      );
    }
  }
  if (Array.isArray(raw.tiers) && raw.tiers.every((t) => typeof t === 'string' && t.length > 0)) {
    range.tiers = raw.tiers as string[];
  }
  if (raw.allowAuto === true) range.allowAuto = true;
  if (typeof raw.divisibleBy === 'number' && raw.divisibleBy > 0)
    range.divisibleBy = raw.divisibleBy;
  if (typeof raw.maxEdge === 'number' && raw.maxEdge > 0) range.maxEdge = raw.maxEdge;
  return range;
}
