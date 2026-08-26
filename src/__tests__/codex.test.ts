import { describe, expect, it, vi } from 'vitest';
import { codexAdapter } from '../providers/codex.js';
import type { ResolvedProvider } from '../types.js';

const provider: ResolvedProvider = {
  id: 'openai-codex',
  api: 'codex',
  baseUrl: 'https://chatgpt.com/backend-api/codex/images',
  name: 'ChatGPT Plus/Pro (Codex)',
  builtIn: true,
};

function registry() {
  const token = `header.${Buffer.from(
    JSON.stringify({
      'https://api.openai.com/auth': { chatgpt_account_id: 'acct-123' },
    }),
  ).toString('base64url')}.signature`;
  return {
    getAvailable: () => [{ id: 'gpt-5-codex', provider: 'openai-codex' }],
    getApiKeyAndHeaders: vi.fn().mockResolvedValue({ ok: true, apiKey: token }),
  };
}

describe('codexAdapter', () => {
  it('generates through the ChatGPT Codex Images endpoint', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ b64_json: Buffer.from('png').toString('base64') }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const result = await codexAdapter.generate(
      provider,
      'gpt-image-2',
      { prompt: 'a fox', size: '1024x1024', quality: 'high' },
      fetchImpl,
      undefined,
      [],
      { modelRegistry: registry() },
    );

    expect(result).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://chatgpt.com/backend-api/codex/images/generations');
    expect(init.headers).toMatchObject({
      'ChatGPT-Account-ID': 'acct-123',
      'content-type': 'application/json',
    });
    expect(JSON.parse(String(init.body))).toEqual({
      model: 'gpt-image-2',
      prompt: 'a fox',
      background: 'auto',
      quality: 'high',
      size: '1024x1024',
    });
  });

  it('sends reference images as data URLs to the edits endpoint', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ b64_json: Buffer.from('png').toString('base64') }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await codexAdapter.generate(
      provider,
      'gpt-image-2',
      { prompt: 'make it blue' },
      fetchImpl,
      undefined,
      [{ bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png' }],
      { modelRegistry: registry() },
    );

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://chatgpt.com/backend-api/codex/images/edits');
    expect(JSON.parse(String(init.body)).images).toEqual([
      { image_url: 'data:image/png;base64,AQID' },
    ]);
  });

  it('requires Pi runtime authentication rather than an API key', async () => {
    await expect(
      codexAdapter.generate(provider, 'gpt-image-2', { prompt: 'a fox' }, vi.fn()),
    ).rejects.toThrow(/\/login.*ChatGPT Plus\/Pro/i);
  });
});
