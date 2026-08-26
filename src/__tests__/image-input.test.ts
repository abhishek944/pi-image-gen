import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { safeFetch } from '@amaster.ai/pi-shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyImageOutput,
  MAX_IMAGE_BYTES,
  resolveImageInputs,
  sniffMime,
  toDataUri,
} from '../image-input.js';

const PNG_BYTES = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63000100000005000115c46f250000000049454e44ae426082',
  'hex',
);
const JPEG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)]);
const tempDirs: string[] = [];

function makeTempDir(prefix = 'pi-image-input-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('resolveImageInputs', () => {
  it('returns empty when no image given', async () => {
    expect(await resolveImageInputs(undefined, '/tmp', fetch)).toEqual([]);
    expect(await resolveImageInputs([], '/tmp', fetch)).toEqual([]);
  });

  it('reads a local PNG file by absolute path and detects mime', async () => {
    const dir = makeTempDir();
    const file = join(dir, 'a.png');
    writeFileSync(file, PNG_BYTES);
    const out = await resolveImageInputs([file], dir, fetch);
    expect(out).toHaveLength(1);
    expect(out[0]?.mimeType).toBe('image/png');
    expect(Buffer.from(out[0]!.bytes).equals(PNG_BYTES)).toBe(true);
  });

  it('resolves relative paths against cwd', async () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, 'b.jpg'), JPEG_BYTES);
    const out = await resolveImageInputs(['./b.jpg'], dir, fetch);
    expect(out[0]?.mimeType).toBe('image/jpeg');
  });

  it('allows a dot-prefixed child directory whose name starts with two dots', async () => {
    const dir = makeTempDir();
    mkdirSync(join(dir, '..frames'));
    writeFileSync(join(dir, '..frames', 'frame.png'), PNG_BYTES);

    const out = await resolveImageInputs(['..frames/frame.png'], dir, fetch);

    expect(out[0]?.mimeType).toBe('image/png');
  });

  it('rejects a local path that escapes cwd', async () => {
    const cwd = makeTempDir();
    const outside = makeTempDir('pi-image-input-outside-');
    writeFileSync(join(outside, 'secret.png'), PNG_BYTES);

    await expect(resolveImageInputs([join(outside, 'secret.png')], cwd, fetch)).rejects.toThrow(
      /approved project directory/i,
    );
  });

  it('rejects a symlink even when the link itself is inside cwd', async () => {
    const cwd = makeTempDir();
    const outside = makeTempDir('pi-image-input-outside-');
    const target = join(outside, 'secret.png');
    writeFileSync(target, PNG_BYTES);
    symlinkSync(target, join(cwd, 'linked.png'));

    await expect(resolveImageInputs(['linked.png'], cwd, fetch)).rejects.toThrow(/symlink/i);
  });

  it('rejects a file whose extension claims image but whose bytes do not', async () => {
    const cwd = makeTempDir();
    writeFileSync(join(cwd, 'fake.png'), 'not really an image');
    await expect(resolveImageInputs(['fake.png'], cwd, fetch)).rejects.toThrow(/valid.*image/i);
  });

  it('rejects a data: URI with a clear error', async () => {
    const dataUri = `data:image/png;base64,${PNG_BYTES.toString('base64')}`;
    await expect(resolveImageInputs([dataUri], '/tmp', fetch)).rejects.toThrow(
      /`data:` URI is not supported/i,
    );
  });

  it('downloads an http(s) URL with the given fetch impl and respects abort signal', async () => {
    let receivedSignal: AbortSignal | null | undefined;
    const fetchImpl: typeof fetch = (async (_url, init) => {
      receivedSignal = (init as RequestInit | undefined)?.signal;
      return new Response(PNG_BYTES, {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });
    }) as typeof fetch;
    const ctrl = new AbortController();
    const out = await resolveImageInputs(
      ['https://example.com/img.png'],
      '/tmp',
      fetchImpl,
      ctrl.signal,
    );
    expect(out[0]?.mimeType).toBe('image/png');
    expect(receivedSignal).toBe(ctrl.signal);
  });

  it('blocks loopback image URLs before fetch', async () => {
    await expect(
      resolveImageInputs(['http://127.0.0.1/private.png'], '/tmp', safeFetch),
    ).rejects.toThrow(/public HTTP/i);
  });

  it('rejects and cancels a remote image that exceeds the byte ceiling', async () => {
    let cancelled = false;
    const fetchImpl: typeof fetch = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(21 * 1024 * 1024));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { 'content-type': 'image/png' } },
      )) as typeof fetch;

    await expect(
      resolveImageInputs(['https://example.com/huge.png'], '/tmp', fetchImpl),
    ).rejects.toThrow(/size ceiling/i);
    expect(cancelled).toBe(true);
  });

  it('cancels an unread image-input HTTP error body', async () => {
    let cancelled = false;
    const fetchImpl: typeof fetch = (async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { status: 404 },
      )) as typeof fetch;

    await expect(
      resolveImageInputs(['https://example.com/missing.png'], '/tmp', fetchImpl),
    ).rejects.toThrow(/404/);
    expect(cancelled).toBe(true);
  });

  it('rejects a long raw base64 blob with a clear error', async () => {
    // 600+ bytes of arbitrary content → 800+ chars base64, no internal padding.
    const blob = Buffer.alloc(600, 0xab).toString('base64');
    await expect(resolveImageInputs([blob], '/tmp', fetch)).rejects.toThrow(/raw base64 blob/i);
  });

  it('treats short non-path strings as paths and reports the failed read', async () => {
    await expect(resolveImageInputs(['nope.png'], '/tmp', fetch)).rejects.toThrow(
      /not a readable file path/,
    );
  });

  it('does not echo an unreadable absolute path in the error', async () => {
    const secretPath = '/Users/alice/secret/photo.png';
    try {
      await resolveImageInputs([secretPath], '/tmp', fetch);
      throw new Error('expected resolveImageInputs to reject');
    } catch (error) {
      expect((error as Error).message).toMatch(/approved project directory/);
      expect((error as Error).message).not.toContain(secretPath);
    }
  });

  it('identifies the failing entry in a multi-image input without echoing its value', async () => {
    const secretPath = '/Users/alice/secret/photo.png';
    const fetchImpl: typeof fetch = (async () =>
      new Response(PNG_BYTES, {
        status: 200,
        headers: { 'content-type': 'image/png' },
      })) as typeof fetch;

    try {
      await resolveImageInputs(['https://example.com/ok.png', secretPath], '/tmp', fetchImpl);
      throw new Error('expected resolveImageInputs to reject');
    } catch (error) {
      expect((error as Error).message).toMatch(/Image input #2/);
      expect((error as Error).message).not.toContain(secretPath);
    }
  });

  it('accepts arrays of file paths', async () => {
    const dir = makeTempDir();
    const a = join(dir, 'a.png');
    const b = join(dir, 'b.jpg');
    writeFileSync(a, PNG_BYTES);
    writeFileSync(b, JPEG_BYTES);
    const out = await resolveImageInputs([a, b], dir, fetch);
    expect(out).toHaveLength(2);
    expect(out[0]?.mimeType).toBe('image/png');
    expect(out[1]?.mimeType).toBe('image/jpeg');
  });
});

describe('sniffMime', () => {
  it('detects BMP and both TIFF endiannesses', () => {
    expect(sniffMime(Buffer.concat([Buffer.from([0x42, 0x4d]), Buffer.alloc(20)]))).toBe(
      'image/bmp',
    );
    expect(
      sniffMime(Buffer.concat([Buffer.from([0x49, 0x49, 0x2a, 0x00]), Buffer.alloc(20)])),
    ).toBe('image/tiff');
    expect(
      sniffMime(Buffer.concat([Buffer.from([0x4d, 0x4d, 0x00, 0x2a]), Buffer.alloc(20)])),
    ).toBe('image/tiff');
  });

  it('detects HEIC/HEIF via the ftyp brand and rejects AVIF/MP4', () => {
    const ftyp = (brand: string) =>
      Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from(`ftyp${brand}`), Buffer.alloc(8)]);
    expect(sniffMime(ftyp('heic'))).toBe('image/heic');
    expect(sniffMime(ftyp('heix'))).toBe('image/heic');
    expect(sniffMime(ftyp('mif1'))).toBe('image/heif');
    expect(sniffMime(ftyp('avif'))).toBeUndefined();
    expect(sniffMime(ftyp('mp42'))).toBeUndefined();
  });
});

describe('toDataUri', () => {
  it('round-trips bytes + mimeType', () => {
    const uri = toDataUri({ bytes: PNG_BYTES, mimeType: 'image/png' });
    expect(uri.startsWith('data:image/png;base64,')).toBe(true);
    expect(uri.endsWith(PNG_BYTES.toString('base64'))).toBe(true);
  });
});

describe('classifyImageOutput', () => {
  it('returns null for empty / undefined / whitespace', () => {
    expect(classifyImageOutput(undefined)).toBeNull();
    expect(classifyImageOutput(null)).toBeNull();
    expect(classifyImageOutput('')).toBeNull();
    expect(classifyImageOutput('   ')).toBeNull();
  });

  it('classifies http(s) URLs as kind:url', () => {
    expect(classifyImageOutput('https://cdn.test/img.png')).toEqual({
      kind: 'url',
      url: 'https://cdn.test/img.png',
    });
    expect(classifyImageOutput('http://localhost:8080/foo.jpg')).toEqual({
      kind: 'url',
      url: 'http://localhost:8080/foo.jpg',
    });
  });

  it('decodes data: URIs into kind:base64 with detected mimeType', () => {
    const dataUri = `data:image/jpeg;base64,${JPEG_BYTES.toString('base64')}`;
    const result = classifyImageOutput(dataUri);
    expect(result).toEqual({
      kind: 'base64',
      bytes: JPEG_BYTES.toString('base64'),
      mimeType: 'image/jpeg',
    });
  });

  it('detects bare base64 image bytes by sniffing magic', () => {
    const result = classifyImageOutput(PNG_BYTES.toString('base64'));
    expect(result).toEqual({
      kind: 'base64',
      bytes: PNG_BYTES.toString('base64'),
      mimeType: 'image/png',
    });
  });

  it('rejects oversized base64 before returning it for decoding', () => {
    const oversized = `${PNG_BYTES.toString('base64')}${'A'.repeat(
      Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 5,
    )}`;
    expect(classifyImageOutput(oversized)).toBeNull();
  });

  it('returns null for short or non-image base64', () => {
    expect(classifyImageOutput('aGVsbG8=')).toBeNull(); // "hello"
    expect(classifyImageOutput('not-base64-stuff!!')).toBeNull();
  });
});
