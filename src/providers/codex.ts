import { resolveCodexAuth } from '../codex-auth.js';
import { ImageGenError } from '../errors.js';
import type { ImageProviderAdapter, ResolvedImageInput } from '../types.js';
import { parseImagesResponse } from './openai.js';

const CODEX_IMAGES_BASE = 'https://chatgpt.com/backend-api/codex/images';

/** ChatGPT subscription image flow used by Codex CLI. */
export const codexAdapter: ImageProviderAdapter = {
  async generate(provider, remoteModelId, params, fetchImpl, signal, inputs, runtime) {
    if (!runtime?.modelRegistry) {
      throw new ImageGenError(
        'No ChatGPT Plus/Pro Codex login is available. Run /login and select ChatGPT Plus/Pro (Codex).',
        'Codex model registry unavailable',
      );
    }
    const auth = await resolveCodexAuth(runtime.modelRegistry);
    const editing = Boolean(inputs?.length);
    const url = `${CODEX_IMAGES_BASE}/${editing ? 'edits' : 'generations'}`;
    const body: Record<string, unknown> = {
      model: remoteModelId,
      ...(editing ? { images: toDataUrls(inputs ?? []) } : {}),
      prompt: params.prompt,
      background: 'auto',
      quality: params.quality ?? 'auto',
      size: params.size ?? 'auto',
    };

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { ...provider.headers, ...auth.headers },
        body: JSON.stringify(body),
        signal: signal ?? null,
        redirect: 'error',
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new ImageGenError('Request to Codex Images was cancelled.', 'Codex request cancelled');
      }
      throw new ImageGenError(
        'The Codex image service could not be reached. Retry once; if it persists, try again later.',
        'Codex request failed (network-error)',
      );
    }

    return parseImagesResponse(response, url, provider);
  },
};

function toDataUrls(inputs: ResolvedImageInput[]): Array<{ image_url: string }> {
  return inputs.map((input) => ({
    image_url: `data:${input.mimeType};base64,${Buffer.from(input.bytes).toString('base64')}`,
  }));
}
