import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

describe('dashscope provider (Alibaba Qwen-Image)', () => {
  const tmpDirs: string[] = [];

  beforeEach(() => {
    safeFetchMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function runCapture(size: string): Promise<Record<string, unknown>> {
    const cwd = mkdtempSync(join(tmpdir(), 'pi-image-gen-dashscope-'));
    tmpDirs.push(cwd);
    vi.stubEnv('DASHSCOPE_API_KEY', 'ds-test');

    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl: typeof fetch = (async (input, init) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      calls.push({ url, body: JSON.parse(String((init as RequestInit)?.body ?? '{}')) });
      return new Response(
        JSON.stringify({
          output: {
            choices: [{ message: { content: [{ image: 'https://cdn.test/out.png' }] } }],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
    // The url-style result is downloaded through safeFetch — serve the bytes.
    safeFetchMock.mockImplementation(
      async () =>
        new Response(PNG_BYTES, { status: 200, headers: { 'content-type': 'image/png' } }),
    );

    await generateImage(
      { prompt: '一只猫', size },
      { cwd, settings: { defaultModel: 'qwen-image-3.0' }, fetchImpl },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
    );
    expect(calls[0]?.body.model).toBe('qwen-image-3.0');
    return calls[0]?.body ?? {};
  }

  it('sends the size verbatim when it already uses the asterisk form', async () => {
    const body = await runCapture('1536*1024');
    expect((body.parameters as Record<string, unknown>).size).toBe('1536*1024');
  });

  it('normalizes the x-form size to the asterisk form DashScope expects', async () => {
    const body = await runCapture('2048x2048');
    expect((body.parameters as Record<string, unknown>).size).toBe('2048*2048');
  });

  it('always opts out of the watermark', async () => {
    const body = await runCapture('2048x2048');
    expect((body.parameters as Record<string, unknown>).watermark).toBe(false);
  });
});
