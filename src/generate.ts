import { mkdir, open, unlink } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import {
  readResponseBytes,
  safeFetch,
  type TrustedHosts,
  trustedHostsFromUrls,
} from '@amaster.ai/pi-shared';
import { validateGenerateParams, validateImageCount } from './capabilities.js';
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
  resolveImageInputs,
  sniffMime,
} from './image-input.js';
import { getAdapter } from './providers/index.js';
import type {
  GeneratedImage,
  GenerateImageParams,
  ImageGenResult,
  ImageGenSettings,
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
  if (resolved.capabilities) {
    validateGenerateParams(params, resolved.capabilities, resolved.requestedId);
  }

  const adapter = getAdapter(resolved.provider.api);
  const inputs = await resolveImageInputs(params.image, options.cwd, safeFetch, options.signal);
  const runtime = options.modelRegistry ? { modelRegistry: options.modelRegistry } : undefined;
  const raws = await adapter.generate(
    resolved.provider,
    resolved.remoteId,
    params,
    fetchImpl,
    options.signal,
    inputs,
    runtime,
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

  const stamp = formatStamp(now());
  const baseFilename = sanitizeFilename(params.filename ?? `${resolved.requestedId}-${stamp}`);
  // The image URL comes from the configured provider — trust its host (and
  // subdomains) so provider-side caches on private/fake-ip networks still work.
  const trustedHosts = trustedHostsFromUrls(resolved.provider.baseUrl);
  const images: GeneratedImage[] = [];
  try {
    for (let i = 0; i < raws.length; i++) {
      // Re-check before each write: a base64 result never touches fetch, so the
      // signal has no other cancellation point here — without this an abort during
      // multi-image materialize/write would keep writing files and return success.
      if (options.signal?.aborted) throw cancelledError('image generation');
      const raw = raws[i]!;
      const fetched = await materialize(raw, options.signal, trustedHosts);
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

  return {
    model: resolved.requestedId,
    provider: providerLabel(resolved.provider),
    images,
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
