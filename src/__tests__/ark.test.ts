import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveModel } from '../config.js';
import { generateImage } from '../generate.js';

const { safeFetchMock } = vi.hoisted(() => ({ safeFetchMock: vi.fn() }));

vi.mock('@amaster.ai/pi-shared', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  safeFetch: safeFetchMock,
}));

const PNG_BYTES = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63000100000005000115c46f250000000049454e44ae426082',
  'hex',
);

function fakeJsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('ark provider (Volcengine Seedream)', () => {
  beforeEach(() => {
    safeFetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('routes seedream alias to the latest 5.0 model', () => {
    vi.stubEnv('ARK_API_KEY', 'ark-test');
    const result = resolveModel('seedream', {});
    if ('error' in result) throw new Error(result.error);
    expect(result.provider.id).toBe('ark');
    expect(result.provider.api).toBe('ark');
    expect(result.remoteId).toBe('doubao-seedream-5-0-260128');
    expect(result.provider.baseUrl).toBe('https://ark.cn-beijing.volces.com/api/v3');
    expect(result.provider.apiKey).toBe('ark-test');
  });

  it('routes seedream-4 alias to the 4.0 model', () => {
    vi.stubEnv('ARK_API_KEY', 'ark-test');
    const result = resolveModel('seedream-4', {});
    if ('error' in result) throw new Error(result.error);
    expect(result.remoteId).toBe('doubao-seedream-4-0-250828');
  });

  it('routes seedream-5-pro alias to the 5.0 pro model', () => {
    vi.stubEnv('ARK_API_KEY', 'ark-test');
    const result = resolveModel('seedream-5-pro', {});
    if ('error' in result) throw new Error(result.error);
    expect(result.provider.id).toBe('ark');
    expect(result.remoteId).toBe('doubao-seedream-5-0-pro-260628');
  });

  it('text-to-image posts to /images/generations with prompt/size as JSON (no n on the wire)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'pi-image-gen-ark-'));
    vi.stubEnv('ARK_API_KEY', 'ark-test');

    const calls: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
    const fetchImpl: typeof fetch = (async (input, init) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      calls.push({
        url,
        method: (init as RequestInit | undefined)?.method ?? 'GET',
        body: JSON.parse(String((init as RequestInit | undefined)?.body ?? '{}')),
      });
      return fakeJsonResponse({
        data: [{ b64_json: PNG_BYTES.toString('base64') }],
      });
    }) as typeof fetch;

    const result = await generateImage(
      // `quality` is passed but Seedream has no such knob — assert it's dropped.
      // Seedream 5.0's 2K floor makes 1024x1024 invalid — use 2048x2048.
      { prompt: '一只猫', size: '2048x2048', quality: 'high', filename: 'cat' },
      {
        cwd,
        settings: { defaultModel: 'seedream' },
        fetchImpl,
        now: () => new Date(Date.UTC(2026, 5, 4, 12, 0, 0)),
      },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://ark.cn-beijing.volces.com/api/v3/images/generations');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.body).toMatchObject({
      model: 'doubao-seedream-5-0-260128',
      prompt: '一只猫',
      size: '2048x2048',
      // Watermark defaults to true upstream — we always opt out.
      watermark: false,
    });
    // Seedream documents no `n` parameter — it must not reach the wire.
    expect(calls[0]?.body.n).toBeUndefined();
    expect(calls[0]?.body.image).toBeUndefined();
    expect(calls[0]?.body.quality).toBeUndefined();
    expect(result.provider).toBe('ark');
    expect(result.images).toHaveLength(1);
    expect(readFileSync(result.images[0]!.path)).toEqual(PNG_BYTES);
  });

  it('image-to-image inlines reference images as data URIs in the JSON body', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'pi-image-gen-ark-i2i-'));
    vi.stubEnv('ARK_API_KEY', 'ark-test');

    const refPath = join(cwd, 'ref.png');
    writeFileSync(refPath, PNG_BYTES);

    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl: typeof fetch = (async (input, init) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      calls.push({
        url,
        body: JSON.parse(String((init as RequestInit | undefined)?.body ?? '{}')),
      });
      return fakeJsonResponse({ data: [{ url: 'https://cdn.test/out.png' }] });
    }) as typeof fetch;

    // The url-style result triggers a second fetch for the bytes; that goes
    // through the same fetchImpl, which would push an extra entry — wrap with
    // a switch on the host so we don't conflate the two.
    const wrapped: typeof fetch = (async (input, init) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      if (url.endsWith('/images/generations')) return fetchImpl(input, init);
      return new Response(PNG_BYTES, {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });
    }) as typeof fetch;
    safeFetchMock.mockImplementation(wrapped);

    const result = await generateImage(
      { prompt: 'redraw it', image: [refPath] },
      { cwd, settings: { defaultModel: 'seedream' }, fetchImpl: wrapped },
    );

    expect(calls).toHaveLength(1);
    const sent = calls[0]?.body as { image?: unknown };
    expect(Array.isArray(sent.image)).toBe(true);
    const images = sent.image as string[];
    expect(images).toHaveLength(1);
    expect(images[0]).toMatch(/^data:image\/png;base64,/);
    expect(result.images).toHaveLength(1);
    expect(readFileSync(result.images[0]!.path)).toEqual(PNG_BYTES);
  });

  it('reports a helpful error when ARK_API_KEY is not set', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'pi-image-gen-ark-nokey-'));
    vi.stubEnv('ARK_API_KEY', undefined);
    await expect(
      generateImage(
        { prompt: 'x' },
        { cwd, settings: { defaultModel: 'seedream' }, fetchImpl: fetch },
      ),
    ).rejects.toThrow(/ARK_API_KEY|no API key|Unknown image model/i);
  });
});
