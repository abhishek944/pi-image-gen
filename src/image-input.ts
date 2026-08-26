import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { readResponseBytes } from '@amaster.ai/pi-shared';
import { describeDownloadError, ImageGenError, throwDownloadHttpError } from './errors.js';
import type { ResolvedImageInput } from './types.js';

const MAGIC_BYTES: Array<{ mimeType: string; bytes: number[] }> = [
  { mimeType: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mimeType: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { mimeType: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] },
  // WebP: "RIFF....WEBP" — bytes 0..3 = RIFF, bytes 8..11 = WEBP
  { mimeType: 'image/webp', bytes: [0x52, 0x49, 0x46, 0x46] },
  { mimeType: 'image/bmp', bytes: [0x42, 0x4d] },
  // TIFF little-endian ("II*\0") and big-endian ("MM\0*")
  { mimeType: 'image/tiff', bytes: [0x49, 0x49, 0x2a, 0x00] },
  { mimeType: 'image/tiff', bytes: [0x4d, 0x4d, 0x00, 0x2a] },
];

// ISO-BMFF major brands (bytes 8..11 of the ftyp box) → HEIC/HEIF family.
// qwen/seedream/gemini all accept these as reference-image formats.
const FTYP_BRAND_MIME: Record<string, string> = {
  heic: 'image/heic',
  heix: 'image/heic',
  hevc: 'image/heic',
  hevx: 'image/heic',
  mif1: 'image/heif',
  msf1: 'image/heif',
};

const DATA_URI_RE = /^data:(image\/[a-z+.-]+);base64,(.+)$/i;
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_BASE64_IMAGE_CHARS = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
export const MAX_GENERATED_IMAGES = 10;

export async function resolveImageInputs(
  raw: string[] | undefined,
  cwd: string,
  fetchImpl: (input: string | URL, init?: RequestInit) => Promise<Response>,
  signal?: AbortSignal,
): Promise<ResolvedImageInput[]> {
  if (!raw || raw.length === 0) return [];
  const out: ResolvedImageInput[] = [];
  for (let index = 0; index < raw.length; index++) {
    const inputLabel = raw.length > 1 ? `Image input #${index + 1}` : 'Image input';
    out.push(await resolveOne(raw[index]!, inputLabel, cwd, fetchImpl, signal));
  }
  return out;
}

async function resolveOne(
  value: string,
  inputLabel: string,
  cwd: string,
  fetchImpl: (input: string | URL, init?: RequestInit) => Promise<Response>,
  signal?: AbortSignal,
): Promise<ResolvedImageInput> {
  const trimmed = value.trim();
  const logLabel = inputLabel.toLowerCase();
  // Every throw below is an ImageGenError so it survives the body-free log sink
  // (toLogSummary) with an actionable message; none interpolate the raw value —
  // an image input could be a giant base64 blob or a signed URL.
  if (!trimmed) {
    throw new ImageGenError(`${inputLabel} is empty.`, `${logLabel} empty`);
  }

  // Reject base64 / data: URIs — tool-call payloads don't survive megabyte-sized
  // string arguments cleanly across providers. Force callers to point us at a
  // path or URL instead, which is also what /image_generate's tool description
  // tells the model.
  if (/^data:/i.test(trimmed)) {
    throw new ImageGenError(
      `${inputLabel} as a \`data:\` URI is not supported. Pass a file path (absolute or relative to cwd) or an http(s) URL instead. If you have raw image bytes, write them to a file under .pi/uploads first and pass that path.`,
      `${logLabel} rejected (data: URI)`,
    );
  }
  // Heuristic for raw base64: long, only base64 chars. Not foolproof but
  // catches the common case where the model dumps a giant base64 blob.
  if (trimmed.length > 256 && !/[\s/\\]/.test(trimmed) && /^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) {
    throw new ImageGenError(
      `${inputLabel} looks like a raw base64 blob; this is not supported because it bloats the tool argument. Write the bytes to a file path and pass that path instead.`,
      `${logLabel} rejected (raw base64)`,
    );
  }

  if (/^https?:\/\//i.test(trimmed)) {
    // Wrap the fetch: a raw rejection can reproduce the full URL (including a
    // signed `?token=…`) in its message, which would then reach a log via the
    // plain-Error path. describeDownloadError redacts the URL and stays body-free.
    let res: Response;
    try {
      res = await fetchImpl(trimmed, { signal: signal ?? null });
    } catch (error) {
      if (error instanceof Error && /public HTTP|redirect limit/i.test(error.message)) {
        throw new ImageGenError(error.message, `${logLabel} rejected (unsafe URL)`);
      }
      throw describeDownloadError(logLabel, trimmed, { rejected: error });
    }
    if (!res.ok) {
      await throwDownloadHttpError(logLabel, trimmed, res);
    }
    // Body reads can fail after headers; keep them in the sanitized download boundary.
    let buf: Uint8Array;
    try {
      buf = await readResponseBytes(res, MAX_IMAGE_BYTES);
    } catch (error) {
      if (error instanceof Error && /size ceiling/i.test(error.message)) {
        throw new ImageGenError(error.message, `${logLabel} rejected (too large)`);
      }
      throw describeDownloadError(logLabel, trimmed, { rejected: error });
    }
    const mimeType = sniffMime(buf);
    if (!mimeType) {
      throw new ImageGenError(
        `${inputLabel} is not a valid supported image.`,
        `${logLabel} rejected (invalid image)`,
      );
    }
    return { bytes: buf, mimeType };
  }

  // Anything else — treat as a file path (absolute or relative to cwd).
  const absolute = isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed);
  const lexicalRoot = resolve(cwd);
  const root = await realpath(cwd).catch(() => resolve(cwd));
  const pathFromRoot = relative(lexicalRoot, absolute);
  if (pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`) || isAbsolute(pathFromRoot)) {
    throw new ImageGenError(
      `${inputLabel} must be inside the approved project directory.`,
      `${logLabel} rejected (outside cwd)`,
    );
  }
  let bytes: Buffer;
  try {
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) {
      throw new ImageGenError(
        `${inputLabel} must not be a symlink.`,
        `${logLabel} rejected (symlink)`,
      );
    }
    if (!info.isFile()) {
      throw new ImageGenError(
        `${inputLabel} must be a regular file.`,
        `${logLabel} rejected (not regular)`,
      );
    }
    if (info.size > MAX_IMAGE_BYTES) {
      throw new ImageGenError(
        `${inputLabel} exceeds the image size ceiling.`,
        `${logLabel} rejected (too large)`,
      );
    }
    const file = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const openedInfo = await file.stat();
      if (!openedInfo.isFile()) {
        throw new ImageGenError(
          `${inputLabel} must be a regular file.`,
          `${logLabel} rejected (not regular)`,
        );
      }
      if (openedInfo.size > MAX_IMAGE_BYTES) {
        throw new ImageGenError(
          `${inputLabel} exceeds the image size ceiling.`,
          `${logLabel} rejected (too large)`,
        );
      }
      const canonical = await realpath(absolute);
      const canonicalInfo = await lstat(canonical);
      const canonicalFromRoot = relative(root, canonical);
      if (
        canonicalFromRoot === '..' ||
        canonicalFromRoot.startsWith(`..${sep}`) ||
        isAbsolute(canonicalFromRoot) ||
        canonicalInfo.dev !== openedInfo.dev ||
        canonicalInfo.ino !== openedInfo.ino
      ) {
        throw new ImageGenError(
          `${inputLabel} must be inside the approved project directory.`,
          `${logLabel} rejected (outside cwd)`,
        );
      }
      bytes = await file.readFile();
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error instanceof ImageGenError) throw error;
    // Do NOT interpolate the resolved absolute path or the raw fs error (errno +
    // full path) — both are sensitive and would reach stderr via the plain-Error
    // path. Keep the message body-free, path-free, and actionable.
    throw new ImageGenError(
      `${inputLabel} is not a readable file path or http(s) URL. Pass an absolute path, a path relative to the session cwd, or an http(s) URL.`,
      `${logLabel} not readable`,
    );
  }
  const mimeType = sniffMime(bytes);
  if (!mimeType) {
    throw new ImageGenError(
      `${inputLabel} is not a valid supported image.`,
      `${logLabel} rejected (invalid image)`,
    );
  }
  return { bytes, mimeType };
}

export function sniffMime(bytes: Uint8Array): string | undefined {
  // ISO-BMFF (HEIC/HEIF): no fixed magic at offset 0 — the box size varies —
  // so match "ftyp" at offset 4 and read the major brand at offset 8.
  const brand = sniffFtypBrand(bytes);
  if (brand) return brand;
  for (const { mimeType, bytes: magic } of MAGIC_BYTES) {
    if (bytes.length < magic.length) continue;
    let match = true;
    for (let i = 0; i < magic.length; i++) {
      if (bytes[i] !== magic[i]) {
        match = false;
        break;
      }
    }
    if (!match) continue;
    if (mimeType === 'image/webp') {
      // RIFF prefix matched — verify WEBP at offset 8.
      if (
        bytes.length >= 12 &&
        bytes[8] === 0x57 &&
        bytes[9] === 0x45 &&
        bytes[10] === 0x42 &&
        bytes[11] === 0x50
      ) {
        return 'image/webp';
      }
      continue;
    }
    return mimeType;
  }
  return undefined;
}

/**
 * Detect HEIC/HEIF via the ISO-BMFF `ftyp` box: 4-byte box size, then the
 * literal "ftyp", then a 4-char major brand. Returns undefined for anything
 * else (including AVIF's "avif" brand, which no built-in model accepts).
 */
function sniffFtypBrand(bytes: Uint8Array): string | undefined {
  if (
    bytes.length < 12 ||
    bytes[4] !== 0x66 || // f
    bytes[5] !== 0x74 || // t
    bytes[6] !== 0x79 || // y
    bytes[7] !== 0x70 // p
  ) {
    return undefined;
  }
  const brand = String.fromCharCode(bytes[8]!, bytes[9]!, bytes[10]!, bytes[11]!);
  return FTYP_BRAND_MIME[brand];
}

export function toDataUri(input: ResolvedImageInput): string {
  const b64 = Buffer.from(input.bytes).toString('base64');
  return `data:${input.mimeType};base64,${b64}`;
}

/**
 * Classify a string returned by an image-generation API as either a URL the
 * caller should fetch, or base64 image bytes the caller already has.
 *
 * Different providers / gateways return image output in different shapes:
 *   - http(s):// URL       → fetch it
 *   - `data:image/...;base64,...`  → strip prefix, decode bytes
 *   - bare base64 string (PNG/JPEG/WebP/GIF magic bytes) → decode bytes
 *   - empty / whitespace   → invalid, return null
 *
 * Returning `null` lets adapters skip junk entries (e.g. when a provider's
 * response had `text` parts but no actual image).
 */
export function classifyImageOutput(
  value: string | undefined | null,
): { kind: 'url'; url: string } | { kind: 'base64'; bytes: string; mimeType: string } | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (/^https?:\/\//i.test(trimmed)) {
    return { kind: 'url', url: trimmed };
  }

  const dataMatch = DATA_URI_RE.exec(trimmed);
  if (dataMatch) {
    if (dataMatch[2]!.length > MAX_BASE64_IMAGE_CHARS) return null;
    return {
      kind: 'base64',
      bytes: dataMatch[2]!,
      mimeType: dataMatch[1]!.toLowerCase(),
    };
  }

  // Maybe bare base64 — try to decode and sniff. Bail cheaply on anything that
  // can't possibly be an image (too short, contains non-base64 chars).
  if (
    trimmed.length < 16 ||
    trimmed.length > MAX_BASE64_IMAGE_CHARS ||
    /[^A-Za-z0-9+/=\s]/.test(trimmed)
  ) {
    return null;
  }
  let decoded: Buffer;
  try {
    decoded = Buffer.from(trimmed, 'base64');
  } catch {
    return null;
  }
  if (decoded.length < 8) return null;
  const mimeType = sniffMime(decoded);
  if (!mimeType) return null;
  return { kind: 'base64', bytes: trimmed, mimeType };
}
