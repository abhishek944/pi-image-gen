/**
 * Stable error surface for the whole package. The implementation is portable
 * (no `node:` or pi-shared imports) so the Workers-safe core can reuse it; this
 * module stays the single import path every existing caller already uses.
 */
export {
  ImageGenError,
  type RetainedPartialFailure,
  toLogSummary,
  errorMessageForUser,
  redactUrl,
  providerLogLabel,
  cancelResponseBody,
  isAbortError,
  cancelledError,
  describeWriteError,
} from './core/errors.js';
export {
  providerLocator,
  metaSupportsPiLogin,
  providerBaseUrlLocator,
  missingKeyError,
} from './core/provider-hints.js';
export { classifyHttpError, throwHttpError } from './core/provider-http.js';
export {
  describeNetworkError,
  readBodyText,
  describeDownloadError,
  throwDownloadHttpError,
} from './core/download-errors.js';
