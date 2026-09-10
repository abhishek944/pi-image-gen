import { ImageGenError } from '../errors.js';
import type { ApiStyle, ImageProviderAdapter } from '../types.js';
import { arkAdapter } from './ark.js';
import { codexAdapter } from './codex.js';
import { dashscopeAdapter } from './dashscope.js';
import { geminiAdapter } from './gemini.js';
import { metaAdapter } from './meta.js';
import { openaiAdapter } from './openai.js';
import { openrouterAdapter } from './openrouter.js';

const ADAPTERS: Record<ApiStyle, ImageProviderAdapter> = {
  openai: openaiAdapter,
  gemini: geminiAdapter,
  dashscope: dashscopeAdapter,
  openrouter: openrouterAdapter,
  ark: arkAdapter,
  meta: metaAdapter,
  codex: codexAdapter,
};

export function getAdapter(api: ApiStyle): ImageProviderAdapter {
  const adapter = ADAPTERS[api];
  if (!adapter) throw new ImageGenError(`Unsupported api "${api}".`, `unsupported api "${api}"`);
  return adapter;
}
