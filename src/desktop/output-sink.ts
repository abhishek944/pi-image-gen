import { mkdir, unlink } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { describeWriteError } from '../errors.js';
import { desktopTimeout } from './configuration.js';
import { writeUnique } from '../node/output-files.js';
import { RasterError, resizeRaster } from '../node/raster.js';
import type { GeneratedImage, GenerateImageParams } from '../types.js';
import type { ImageStoreContext, Original } from '../core/protocol.js';
import type { GenerateImageOptions } from './options.js';

const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp',
  'image/gif': 'gif', 'image/bmp': 'bmp', 'image/tiff': 'tiff', 'image/heic': 'heic', 'image/heif': 'heif',
};

export function desktopSink(params: GenerateImageParams, options: GenerateImageOptions, model: string) {
  const configured: unknown = options.settings.outputDir;
  const target = params.outputDir ?? (typeof configured === 'string' ? configured : undefined);
  const directory = target?.trim() ? target : '.pi/images';
  const outDir = isAbsolute(directory) ? directory : resolve(options.cwd, directory);
  const saved: GeneratedImage[] = [];
  const resizeInputs: Uint8Array[] = [];
  let stem: string | undefined;
  let ready = false;
  const begin = () => { stem ??= sanitizeFilename(params.filename ?? `${model}-${formatStamp((options.now ?? (() => new Date()))())}`); };
  return {
    begin,
    /** Confirmed saved files; used for retention reporting when cleanup is skipped. */
    retained: (): GeneratedImage[] => [...saved],
    async store(output: Original, index: number, context: ImageStoreContext): Promise<GeneratedImage> {
      begin();
      if (!ready) {
        try { await mkdir(outDir, { recursive: true }); ready = true; }
        catch (error) { throw describeWriteError('create the output directory', error); }
      }
      const suffix = context.total > 1 ? `-${index + 1}` : '';
      const path = await writeUnique(outDir, `${stem}${suffix}`, MIME_TO_EXT[output.mimeType] ?? 'png',
        output.bytes, context.signal);
      const info = context.descriptor;
      const image: GeneratedImage = { path, mimeType: output.mimeType,
        ...(info.width !== undefined && info.height !== undefined
          ? { dimensions: { width: info.width, height: info.height } } : {}),
        ...(info.revisedPrompt !== undefined ? { revisedPrompt: info.revisedPrompt } : {}) };
      saved.push(image);
      if (params.resize) resizeInputs.push(output.bytes);
      return image;
    },
    /** Run only after core success, outside the original-storage rollback/deadline. */
    async resizeSaved(images: readonly GeneratedImage[]): Promise<GeneratedImage[]> {
      if (!params.resize) return [...images];
      const deadline = AbortSignal.timeout(desktopTimeout(options.settings.requestTimeoutMs));
      const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
      const resizedImages: GeneratedImage[] = [];
      for (const [index, image] of images.entries()) {
        try {
          signal.throwIfAborted();
          const resized = await resizeRaster(resizeInputs[index]!, params.resize);
          signal.throwIfAborted();
          const suffix = images.length > 1 ? `-${index + 1}` : '';
          const path = await writeUnique(outDir, `${stem}${suffix}-resized`, 'png', resized.bytes, signal);
          resizedImages.push({ ...image, path, originalPath: image.path,
            mimeType: resized.mimeType, dimensions: { width: resized.width, height: resized.height } });
        } catch (error) {
          // Core has succeeded. Local failure/cancellation must never roll back paid originals.
          resizedImages.push({ ...image, resizeError: signal.aborted ? 'Resize cancelled or timed out; the original is preserved.'
            : error instanceof RasterError ? error.message : 'Could not save the resized copy; the original is preserved.' });
        }
      }
      resizeInputs.length = 0;
      return resizedImages;
    },
    async cleanup(): Promise<void> {
      // Desktop retains its legacy local partial-batch policy; core never deletes host receipts.
      await Promise.all(saved.map(async ({ path }) => {
        try { await unlink(path); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') logCleanupFailure(error);
        }
      }));
    },
  };
}

function logCleanupFailure(error: unknown): void {
  console.error(`[pi-image-gen] cleanup failed: ${describeWriteError('remove an incomplete image file', error).logSummary}`);
}

function formatStamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
}

function sanitizeFilename(name: string): string {
  const safe = name.trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, '_');
  return safe.length ? safe.slice(0, 100) : 'image';
}
