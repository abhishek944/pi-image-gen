import type { ImageGenSettings, ImageModelCapabilities, ImageModelRegistry } from '../types.js';

/** Existing desktop caller contract; no Worker or application services are required. */
export type GenerateImageOptions = {
  cwd: string;
  settings: ImageGenSettings;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  now?: () => Date;
  modelRegistry?: ImageModelRegistry;
  modelCapabilities?: ImageModelCapabilities;
  onProgress?: (phase: 'loading-inputs' | 'waiting-provider' | 'saving-output') => void;
  /**
   * Trusted serializable internal option: retain confirmed saved outputs and
   * report their receipts when generation fails, instead of the desktop default
   * partial-batch cleanup. Set only by the native factory; desktop callers omit
   * it and keep existing cleanup behavior unchanged.
   */
  retainPartialOutputs?: boolean;
};
