import type { Cost, ImageTokenUsage, ReportedUsage } from './protocol.js';
import type { GeneratedImage } from '../types/desktop.js';
import type { ResolvedProvider } from '../types/provider.js';

/**
 * Compact receipts for confirmed saved outputs that survived a failed call.
 * Carried on `ImageGenError.partial` only when the caller opted into retention;
 * every field mirrors the success surface, so nothing here can leak a provider
 * body, credential, or signed URL.
 */
export type RetainedPartialFailure = {
  /** Confirmed saved files; never deleted by the retaining caller. */
  readonly images: readonly GeneratedImage[];
  readonly dispatched: boolean;
  readonly uncertain: boolean;
  readonly storageUncertain: boolean;
  readonly durationMs: number;
  readonly requestId?: string;
  readonly reportedUsage?: ReportedUsage;
  readonly tokenUsage?: ImageTokenUsage;
  readonly costDetails: Cost;
};

/**
 * Trust boundary for the whole extension, portable half. Raw provider bodies —
 * and plain `fs`/`fetch` errors, which embed absolute paths, errno strings, or
 * signed `?token=…` URLs — must reach NEITHER the user/LLM surface NOR a log.
 * So every EXPECTED failure is thrown as an `ImageGenError`, the only value
 * whose text is vetted body-free, carrying two curated views: `message`
 * (LLM-facing, "what happened + what to do") and `logSummary` (a terse
 * provider/status/category one-liner, e.g. `OpenAI HTTP 400 (bad-request)`).
 */
export class ImageGenError extends Error {
  readonly logSummary: string;
  constructor(
    message: string,
    logSummary: string,
    readonly fallbackReason?: 'missing-credentials' | 'auth' | 'not-found' | 'rate-limit',
    /** Retained receipts; present only when the caller opted into retention. */
    readonly partial?: RetainedPartialFailure,
  ) {
    super(message);
    this.name = 'ImageGenError';
    this.logSummary = logSummary.split(/[\r\n]/, 1)[0] || 'image generation failed';
  }
}

/**
 * stderr sink: an ImageGenError's curated summary, else a fixed label. Anything
 * that isn't an ImageGenError is untrusted — an Error's `message` and its
 * (writable) `name` can carry a path, errno, signed URL, or a log-injection
 * newline, and a thrown non-Error is arbitrary — so we surface a constant string
 * and never read a single byte off the value.
 */
export function toLogSummary(error: unknown): string {
  if (error instanceof ImageGenError) return error.logSummary;
  return error instanceof Error ? 'unexpected error' : 'unexpected non-error throw';
}

/** user/LLM sink: an ImageGenError's vetted message, else a fixed sentence. */
export function errorMessageForUser(error: unknown): string {
  if (error instanceof ImageGenError) return error.message;
  return 'Image generation failed unexpectedly. Retry once; if it persists, report a pi-image-gen bug.';
}

/**
 * Reduce a URL to `scheme://host/path`, dropping the query (where signed
 * `?token=…` / `?X-Amz-Signature=…` credentials live), the fragment, and any
 * userinfo. Non-parseable input collapses to `<url>` so it can't smuggle bytes.
 */
export function redactUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return '<url>';
  }
}

/** Fixed-safe provider label for stderr; custom display names are user-controlled. */
export function providerLogLabel(provider: ResolvedProvider): string {
  return provider.builtIn ? provider.name : 'Custom provider';
}

export async function cancelResponseBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // Preserve the useful HTTP classification if best-effort connection cleanup fails.
  }
}

/** Structured cancellation check; the writable name is compared, never logged. */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/** Body-free error for a cancelled operation (`what` is a fixed caller label). */
export function cancelledError(what: string): ImageGenError {
  return new ImageGenError(`${what} was cancelled.`, `${what} cancelled`);
}

/**
 * Body-free error for a filesystem write failure (creating the output dir or
 * writing an image file). The raw fs error embeds the absolute path + errno, so
 * we classify by its `.code` (validated against an errno shape) into an
 * actionable, path-free hint. `what` is a fixed caller label.
 */
export function describeWriteError(what: string, error: unknown): ImageGenError {
  const rawCode = (error as { code?: unknown } | null | undefined)?.code;
  const code = typeof rawCode === 'string' && /^E[A-Z]+$/.test(rawCode) ? rawCode : undefined;
  const reason =
    code === 'EACCES' || code === 'EPERM' || code === 'EROFS'
      ? 'permission was denied'
      : code === 'ENOSPC'
        ? 'the disk is full'
        : code === 'ENOTDIR' || code === 'ENOENT'
          ? 'the path is invalid'
          : 'of a filesystem error';
  return new ImageGenError(
    `Could not ${what} because ${reason}. Tell the user to check the configured output directory (pi-image-gen.outputDir or the tool's outputDir) points at a writable path.`,
    `${what} failed (${code ?? 'fs-error'})`,
  );
}
