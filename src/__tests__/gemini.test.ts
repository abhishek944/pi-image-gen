import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateImage } from '../generate.js';
import type { ImageGenSettings } from '../types.js';

const PNG_B64 = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63000100000005000115c46f250000000049454e44ae426082',
  'hex',
).toString('base64');

describe('gemini provider (Nano Banana)', () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  async function captureBody(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const cwd = mkdtempSync(join(tmpdir(), 'pi-image-gen-gemini-'));
    tmpDirs.push(cwd);
    vi.stubEnv('GEMINI_API_KEY', 'gem-test');
    const settings: ImageGenSettings = { defaultModel: 'nano-banana-pro' };

    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl: typeof fetch = (async (input, init) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      calls.push({ url, body: JSON.parse(String((init as RequestInit)?.body ?? '{}')) });
      return new Response(
        JSON.stringify({
          candidates: [
            { content: { parts: [{ inlineData: { mimeType: 'image/png', data: PNG_B64 } }] } },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;

    await generateImage({ prompt: 'a cat', ...params }, { cwd, settings, fetchImpl });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image:generateContent',
    );
    return calls[0]?.body ?? {};
  }

  it('forwards aspectRatio/imageSize into generationConfig.imageConfig', async () => {
    const body = await captureBody({ aspectRatio: '16:9', imageSize: '2K' });
    const config = body.generationConfig as Record<string, unknown>;
    expect(config.imageConfig).toEqual({ aspectRatio: '16:9', imageSize: '2K' });
  });

  it('omits imageConfig when neither knob is passed', async () => {
    const body = await captureBody({});
    const config = body.generationConfig as Record<string, unknown>;
    expect(config.imageConfig).toBeUndefined();
    expect(config.candidateCount).toBe(1);
  });
});
