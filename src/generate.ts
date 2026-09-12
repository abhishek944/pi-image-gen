import { mkdir, open, unlink } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import {
  readResponseBytes,
  safeFetch,
  type TrustedHosts,
  trustedHostsFromUrls,
} from '@amaster.ai/pi-shared';
import {
  capabilitiesForApi,
  genericCapabilitiesForApi,
  hasAspectRatioKnob,
  validateGenerateParams,
  validateImageCount,
} from './capabilities.js';
import { resolveModel } from './config.js';
import {
  cancelledError,
  describeDownloadError,
  describeWriteError,
  ImageGenError,
  isAbortError,
  throwDownloadHttpError,
} from './errors.js';
import {
  MAX_BASE64_IMAGE_CHARS,
  MAX_GENERATED_IMAGES,
  MAX_IMAGE_BYTES,
  MAX_TOTAL_REFERENCE_IMAGE_BYTES,
  resolveImageInputs,
  sniffMime,
} from './image-input.js';
import { getAdapter } from './providers/index.js';
import type {
  GeneratedImage,
  GenerateImageParams,
  ImageGenResult,
  ImageGenSettings,
  ImageModelCapabilities,
  ImageModelRegistry,
  RawImageResult,
  ResolvedProvider,
} from './types.js';

export type GenerateImageOptions = {
  cwd: string;
  settings: ImageGenSettings;
  fetchImpl?: typeof fetch;
  /** Cancellation signal — propagated to fetches, provider polling, and file writes. */
  signal?: AbortSignal;
  /** Override the wall-clock used for filenames. Useful for tests. */
  now?: () => Date;
  /** Pi runtime registry used by subscription-backed providers such as Codex. */
  modelRegistry?: ImageModelRegistry;
  /** Effective registration contract, including live discovery when available. */
  modelCapabilities?: ImageModelCapabilities;
  /** Sanitized phase updates for the Pi tool UI. */
  onProgress?: (phase: 'loading-inputs' | 'waiting-provider' | 'saving-output') => void;
};

const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff',
  'image/heic': 'heic',
  'image/heif': 'heif',
};

export async function generateImage(
  params: GenerateImageParams,
  options: GenerateImageOptions,
): Promise<ImageGenResult> {
  const timeoutMs = validatedTimeout(options.settings.requestTimeoutMs);
  const deadline = deadlineSignal(options.signal, timeoutMs);
  try {
    return await generateImageInternal(params, { ...options, signal: deadline.signal });
  } catch (error) {
    if (deadline.timedOut()) {
      throw new ImageGenError(
        `Image generation exceeded the ${Math.round(timeoutMs / 1000)} second request timeout. Increase pi-image-gen.requestTimeoutMs if this provider normally needs longer.`,
        'image generation timed out',
      );
    }
    throw error;
  } finally {
    deadline.cleanup();
  }
}

async function generateImageInternal(
  params: GenerateImageParams,
  options: GenerateImageOptions,
): Promise<ImageGenResult> {
  const startedAt = Date.now();
  if (options.signal?.aborted) throw cancelledError('image generation');
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());

  const configuredModel: unknown = options.settings.defaultModel;
  const requested = typeof configuredModel === 'string' ? configuredModel.trim() : '';
  if (!requested) {
    // Config errors are ImageGenErrors so they survive the body-free log sink
    // with their actionable text — none of them carry secrets/user content.
    throw new ImageGenError(
      'pi-image-gen.defaultModel is not set. Run /image-gen list, then /image-gen use <provider> <model> (for example, /image-gen use gemini-api nano-banana).',
      'defaultModel not set',
    );
  }

  const resolved = resolveModel(requested, options.settings);
  if ('error' in resolved) throw new ImageGenError(resolved.error, 'model did not resolve');

  validateImageCount(params);
  if (
    (resolved.provider.api === 'ark' || resolved.provider.api === 'meta') &&
    params.n != null &&
    params.n !== 1
  ) {
    throw new ImageGenError(
      `${resolved.requestedId} generates one image per request and does not accept n greater than 1.`,
      'n unsupported by provider API',
    );
  }
  // Pre-flight guards only against parameter combinations our adapters would
  // silently drop (see capabilities.ts) — documented numeric limits are
  // schema-description advice, and the provider's error is the backstop.
  const effectiveCapabilities = options.modelCapabilities ??
    (resolved.capabilities
      ? capabilitiesForApi(resolved.capabilities, resolved.provider.api)
      : genericCapabilitiesForApi(resolved.provider.api));
  const validationCapabilities = resolved.provider.api === 'gemini' &&
      !hasAspectRatioKnob(effectiveCapabilities)
    ? { ...effectiveCapabilities, aspectRatios: ['auto'] }
    : effectiveCapabilities;
  validateGenerateParams(params, validationCapabilities, resolved.requestedId);

  const adapter = getAdapter(resolved.provider.api);
  options.onProgress?.('loading-inputs');
  const inputs = await awaitWithAbort(
    resolveImageInputs(params.image, options.cwd, safeFetch, options.signal),
    options.signal,
  );
  const referenceBytes = inputs.reduce((total, input) => total + input.bytes.byteLength, 0);
  const masks = params.mask
    ? await awaitWithAbort(
        resolveImageInputs(
          [params.mask],
          options.cwd,
          safeFetch,
          options.signal,
          MAX_TOTAL_REFERENCE_IMAGE_BYTES - referenceBytes,
        ),
        options.signal,
      )
    : [];
  if (options.signal?.aborted) throw cancelledError('image generation');
  const runtime = {
    ...(options.modelRegistry ? { modelRegistry: options.modelRegistry } : {}),
    ...(masks[0] ? { mask: masks[0] } : {}),
  };
  options.onProgress?.('waiting-provider');
  const raws = await awaitWithAbort(
    adapter.generate(
      resolved.provider,
      resolved.remoteId,
      params,
      fetchImpl,
      options.signal,
      inputs,
      runtime,
    ),
    options.signal,
  );
  if (raws.length > MAX_GENERATED_IMAGES) {
    throw new ImageGenError(
      `Provider returned too many images (maximum ${MAX_GENERATED_IMAGES}).`,
      'provider returned too many images',
    );
  }

  if (options.signal?.aborted) throw cancelledError('image generation');

  const configuredOutputDir: unknown = options.settings.outputDir;
  const outDir = resolveOutputDir(
    params.outputDir ?? (typeof configuredOutputDir === 'string' ? configuredOutputDir : undefined),
    options.cwd,
  );
  try {
    await mkdir(outDir, { recursive: true });
  } catch (error) {
    // The raw fs error embeds the absolute outDir + errno — classify it into a
    // path-free, actionable hint instead of letting it reach a sink verbatim.
    throw describeWriteError('create the output directory', error);
  }
  if (options.signal?.aborted) throw cancelledError('image generation');

  const stamp = formatStamp(now());
  const baseFilename = sanitizeFilename(params.filename ?? `${resolved.requestedId}-${stamp}`);
  // The image URL comes from the configured provider — trust its host (and
  // subdomains) so provider-side caches on private/fake-ip networks still work.
  const trustedHosts = trustedHostsFromUrls(resolved.provider.baseUrl);
  const images: GeneratedImage[] = [];
  options.onProgress?.('saving-output');
  try {
    for (let i = 0; i < raws.length; i++) {
      // Re-check before each write: a base64 result never touches fetch, so the
      // signal has no other cancellation point here — without this an abort during
      // multi-image materialize/write would keep writing files and return success.
      if (options.signal?.aborted) throw cancelledError('image generation');
      const raw = raws[i]!;
      const fetched = await awaitWithAbort(
        materialize(raw, options.signal, trustedHosts),
        options.signal,
      );
      if (options.signal?.aborted) throw cancelledError('image generation');
      const ext = MIME_TO_EXT[fetched.mimeType] ?? 'png';
      const suffix = raws.length > 1 ? `-${i + 1}` : '';
      const path = await writeUnique(
        outDir,
        `${baseFilename}${suffix}`,
        ext,
        fetched.bytes,
        options.signal,
      );
      const image: GeneratedImage = { path, mimeType: fetched.mimeType };
      const dimensions = readImageDimensions(fetched.bytes, fetched.mimeType);
      if (dimensions) image.dimensions = dimensions;
      if (raw.revisedPrompt) image.revisedPrompt = raw.revisedPrompt;
      images.push(image);
    }
  } catch (error) {
    try {
      await Promise.all(
        images.map(async ({ path }) => {
          try {
            await unlink(path);
          } catch (cleanupError) {
            if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') throw cleanupError;
          }
        }),
      );
    } catch (cleanupError) {
      logCleanupFailure('remove an incomplete image batch', cleanupError);
    }
    throw error;
  }

  const rawMetadata = raws.find((raw) => raw.metadata)?.metadata;
  const providerMetadata = sanitizeGenerationMetadata(rawMetadata);
  return {
    model: resolved.requestedId,
    provider: providerLabel(resolved.provider),
    images,
    metadata: {
      durationMs: Date.now() - startedAt,
      ...providerMetadata,
    },
  };
}

function providerLabel(provider: ResolvedProvider): string {
  return provider.builtIn ? provider.id : `${provider.id} (custom)`;
}

function logCleanupFailure(operation: string, error: unknown): void {
  console.error(
    `[pi-image-gen] cleanup failed: ${describeWriteError(operation, error).logSummary}`,
  );
}

function resolveOutputDir(configured: string | undefined, cwd: string): string {
  const target = configured && configured.trim().length > 0 ? configured : '.pi/images';
  return isAbsolute(target) ? target : resolve(cwd, target);
}

function formatStamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
}

function sanitizeFilename(name: string): string {
  const trimmed = name
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '_');
  return trimmed.length > 0 ? trimmed.slice(0, 100) : 'image';
}

/**
 * Atomically write `bytes` to a non-clobbering path for `<stem>.<ext>` in `dir`,
 * returning the absolute path actually written.
 *
 * Uses the `wx` open flag (O_EXCL) so the "does it exist?" check and the create
 * are a single syscall: if the name is already taken the write fails with
 * `EEXIST` and we try `-v2`, `-v3`, … A prior `existsSync`→`writeFile` version
 * had a TOCTOU race — concurrent calls with the same `filename` could observe
 * the same free name and clobber each other, breaking the README's
 * "never overwrites" contract. O_EXCL closes that window: only one racer can
 * create any given name, the losers retry the next suffix.
 *
 * So two calls with `filename: "hero"` yield `hero.png` then `hero-v2.png` — the
 * earlier output is preserved rather than silently replaced.
 */
async function writeUnique(
  dir: string,
  stem: string,
  ext: string,
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<string> {
  for (let v = 1; ; v++) {
    if (signal?.aborted) throw cancelledError('image generation');
    const candidate = resolve(dir, v === 1 ? `${stem}.${ext}` : `${stem}-v${v}.${ext}`);
    let created = false;
    try {
      // `wx`: create-and-fail-if-exists in one atomic operation (no TOCTOU gap).
      const file = await open(candidate, 'wx');
      created = true;
      try {
        await file.writeFile(bytes, { signal });
      } finally {
        await file.close();
      }
      if (signal?.aborted) throw cancelledError('image generation');
      return candidate;
    } catch (error) {
      if (created) {
        try {
          await unlink(candidate);
        } catch (cleanupError) {
          if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') {
            logCleanupFailure('remove the incomplete image file', cleanupError);
          }
        }
      }
      if (signal?.aborted || isAbortError(error)) {
        throw cancelledError('image generation');
      }
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      // Disk full / permission / invalid path — the raw fs error embeds the
      // absolute candidate path + errno, so classify it into a path-free hint.
      throw describeWriteError('write the image file', error);
    }
  }
}

function sanitizeGenerationMetadata(
  metadata: RawImageResult['metadata'],
): Omit<NonNullable<ImageGenResult['metadata']>, 'durationMs'> {
  if (!metadata) return {};
  const requestId = typeof metadata.requestId === 'string' &&
      /^[A-Za-z0-9._:/-]{1,200}$/.test(metadata.requestId)
    ? metadata.requestId
    : undefined;
  const usageEntries = Object.entries(metadata.usage ?? {})
    .filter(([name, value]) => /^[A-Za-z0-9_.:-]{1,64}$/.test(name) && Number.isFinite(value))
    .slice(0, 50);
  const usage = usageEntries.length > 0 ? Object.fromEntries(usageEntries) : undefined;
  const cost = typeof metadata.cost === 'number' && Number.isFinite(metadata.cost) && metadata.cost >= 0
    ? metadata.cost
    : undefined;
  return {
    ...(requestId ? { requestId } : {}),
    ...(usage ? { usage } : {}),
    ...(cost != null ? { cost } : {}),
  };
}

function validatedTimeout(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1_000 && value <= 900_000
    ? value
    : 120_000;
}

async function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    void promise.catch(() => {});
    throw cancelledError('image generation');
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(cancelledError('image generation'));
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function deadlineSignal(parent: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  timedOut: () => boolean;
  cleanup: () => void;
} {
  const controller = new AbortController();
  let didTimeOut = false;
  const onAbort = () => controller.abort(parent?.reason);
  if (parent?.aborted) onAbort();
  else parent?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    didTimeOut = true;
    controller.abort(new Error('request timeout'));
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => didTimeOut,
    cleanup: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onAbort);
    },
  };
}

function readImageDimensions(bytes: Uint8Array, mimeType: string): { width: number; height: number } | undefined {
  if (mimeType === 'image/png' && bytes.byteLength >= 24) {
    return {
      width: Buffer.from(bytes).readUInt32BE(16),
      height: Buffer.from(bytes).readUInt32BE(20),
    };
  }
  if (mimeType === 'image/webp' && bytes.byteLength >= 30) {
    const view = Buffer.from(bytes);
    const chunk = view.toString('ascii', 12, 16);
    if (chunk === 'VP8X') {
      const width = 1 + view[24]! + (view[25]! << 8) + (view[26]! << 16);
      const height = 1 + view[27]! + (view[28]! << 8) + (view[29]! << 16);
      return { width, height };
    }
    if (chunk === 'VP8 ' && view[23] === 0x9d && view[24] === 0x01 && view[25] === 0x2a) {
      return { width: view.readUInt16LE(26) & 0x3fff, height: view.readUInt16LE(28) & 0x3fff };
    }
    if (chunk === 'VP8L' && view[20] === 0x2f) {
      const bits = view.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
  }
  if ((mimeType === 'image/jpeg' || mimeType === 'image/jpg') && bytes.byteLength >= 4) {
    const view = Buffer.from(bytes);
    let offset = 2;
    while (offset + 9 < view.length) {
      if (view[offset] !== 0xff) break;
      const marker = view[offset + 1]!;
      const length = view.readUInt16BE(offset + 2);
      if (length < 2 || offset + length + 2 > view.length) break;
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        return { width: view.readUInt16BE(offset + 7), height: view.readUInt16BE(offset + 5) };
      }
      offset += length + 2;
    }
  }
  return undefined;
}

async function materialize(
  raw: RawImageResult,
  signal: AbortSignal | undefined,
  trustedHosts: TrustedHosts,
): Promise<{ bytes: Uint8Array; mimeType: string }> {
  if (raw.data.kind === 'base64') {
    if (raw.data.bytes.length > MAX_BASE64_IMAGE_CHARS) {
      throw new ImageGenError(
        'Provider returned an image that exceeds the size ceiling.',
        'generated image rejected (too large)',
      );
    }
    const bytes = Buffer.from(raw.data.bytes, 'base64');
    const sniffedMimeType = sniffMime(bytes);
    if (bytes.byteLength > MAX_IMAGE_BYTES || !sniffedMimeType) {
      throw new ImageGenError(
        'Provider returned invalid or oversized image bytes.',
        'generated image rejected (invalid or too large)',
      );
    }
    return {
      bytes,
      mimeType: sniffedMimeType,
    };
  }
  if (!raw.data.url || !/^https?:\/\//i.test(raw.data.url)) {
    // Do not echo the reference back: a malformed value could be a giant blob or
    // carry a token. State the shape problem without reproducing the value.
    throw new ImageGenError(
      'Provider returned a non-URL image reference. The response shape may have changed.',
      'non-URL image reference',
    );
  }
  // Wrap the fetch: a raw rejection can reproduce the signed CDN URL in its
  // message and reach a log via the plain-Error path. describeDownloadError
  // redacts the URL (dropping ?token=…) and interpolates no raw fetch text.
  let res: Response;
  try {
    res = await safeFetch(raw.data.url, { signal: signal ?? null }, { trustedHosts });
  } catch (error) {
    if (error instanceof Error && /public HTTP|redirect limit/i.test(error.message)) {
      throw new ImageGenError(error.message, 'generated image rejected (unsafe URL)');
    }
    throw describeDownloadError('generated image', raw.data.url, { rejected: error });
  }
  if (!res.ok) {
    await throwDownloadHttpError('generated image', raw.data.url, res);
  }
  // Body reads can fail after headers; keep them in the sanitized download boundary.
  let buf: Uint8Array;
  try {
    buf = await readResponseBytes(res, MAX_IMAGE_BYTES);
  } catch (error) {
    if (error instanceof Error && /size ceiling/i.test(error.message)) {
      throw new ImageGenError(error.message, 'generated image rejected (too large)');
    }
    throw describeDownloadError('generated image', raw.data.url, { rejected: error });
  }
  const mimeType = sniffMime(buf);
  if (!mimeType) {
    throw new ImageGenError(
      'Provider returned a file that is not a supported image.',
      'generated image rejected (invalid image)',
    );
  }
  return { bytes: buf, mimeType };
}
