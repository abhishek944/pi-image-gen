import { describe, expect, it, vi } from 'vitest';
import {
  capabilitySizeDescription,
  hasImageSizeKnob,
  referenceImageDescription,
  sanitizeCapabilities,
  validateGenerateParams,
} from '../capabilities.js';
import { findBuiltInModel } from '../models.js';
import type { ImageModelCapabilities } from '../types.js';

function capsOf(id: string): ImageModelCapabilities {
  const caps = findBuiltInModel(id)?.capabilities;
  if (!caps) throw new Error(`no capabilities registered for ${id}`);
  return caps;
}

const QWEN3 = capsOf('qwen-image-3.0');
const GPT = capsOf('gpt-image-2');
const SEEDREAM5 = capsOf('doubao-seedream-5-0-260128');
const GEMINI_PRO = capsOf('gemini-3-pro-image');
const GEMINI_LITE = capsOf('gemini-3.1-flash-lite-image');
const GEMINI_25 = capsOf('gemini-2.5-flash-image');

describe('validateGenerateParams — numeric limits are advisory, not enforced', () => {
  it('passes sizes outside the documented window through to the provider', () => {
    // The contract documents 512*512..2048*2048 for qwen-3.0, but a private
    // deployment may differ — the provider's error is the backstop.
    validateGenerateParams({ prompt: 'p', size: '256*256' }, QWEN3, 'qwen-image-3.0');
    validateGenerateParams({ prompt: 'p', size: '8192*8192' }, QWEN3, 'qwen-image-3.0');
    validateGenerateParams({ prompt: 'p', size: 'completely-free-form' }, QWEN3, 'qwen-image-3.0');
  });

  it('passes n above the documented ceiling through to the provider', () => {
    validateGenerateParams({ prompt: 'p', n: 42 }, QWEN3, 'qwen-image-3.0');
  });

  it('still rejects a non-integer n (basic sanity, not a limit)', () => {
    expect(() => validateGenerateParams({ prompt: 'p', n: 1.5 }, QWEN3, 'q')).toThrowError(
      /positive integer/,
    );
  });

  it('passes any reference-image count through to the provider', () => {
    validateGenerateParams(
      { prompt: 'p', image: ['a', 'b', 'c', 'd', 'e', 'f'] },
      QWEN3,
      'qwen-image-3.0',
    );
  });
});

describe('validateGenerateParams — guards params our adapters would silently drop', () => {
  it('rejects a pixel size on aspect-ratio models', () => {
    expect(() =>
      validateGenerateParams({ prompt: 'p', size: '1024x1024' }, GEMINI_PRO, 'gemini-3-pro-image'),
    ).toThrowError(/no pixel-size knob/);
  });

  it('rejects aspectRatio/imageSize on pixel-size models', () => {
    expect(() =>
      validateGenerateParams({ prompt: 'p', aspectRatio: '16:9' }, QWEN3, 'qwen-image-3.0'),
    ).toThrowError(/does not accept aspectRatio\/imageSize/);
    expect(() =>
      validateGenerateParams({ prompt: 'p', imageSize: '2K' }, QWEN3, 'qwen-image-3.0'),
    ).toThrowError(/does not accept aspectRatio\/imageSize/);
  });

  it('lets the provider judge aspectRatio/imageSize values (vocabulary is advisory)', () => {
    validateGenerateParams({ prompt: 'p', aspectRatio: '9:21' }, GEMINI_PRO, 'gemini-3-pro-image');
    validateGenerateParams({ prompt: 'p', imageSize: '8K' }, GEMINI_PRO, 'gemini-3-pro-image');
  });

  it('exposes imageSize in the schema only when the model has multiple tiers', () => {
    expect(hasImageSizeKnob(GEMINI_PRO)).toBe(true);
    expect(hasImageSizeKnob(GEMINI_LITE)).toBe(false);
    expect(hasImageSizeKnob(GEMINI_25)).toBe(false);
  });
});

describe('capability descriptions', () => {
  it('builds the qwen size description with the asterisk form and documented bounds', () => {
    const text = capabilitySizeDescription(QWEN3);
    expect(text).toContain('<width>*<height>');
    expect(text).toContain('Documented limits');
    expect(text).toContain('1:8');
    expect(text).toContain('provider');
  });

  it('builds the seedream size description with tier tokens', () => {
    const text = capabilitySizeDescription(SEEDREAM5);
    expect(text).toContain('2K, 3K, 4K');
    expect(text).toContain('<width>x<height>');
  });

  it('mentions "auto" for gpt-image-2 and nothing for gemini', () => {
    expect(capabilitySizeDescription(GPT)).toContain('"auto"');
    expect(capabilitySizeDescription(GEMINI_PRO)).toBeNull();
  });

  it('describes a discrete size list as documented values', () => {
    const caps: ImageModelCapabilities = {
      sizes: ['1024x1024', '1792x1024'],
      nMax: 1,
      maxReferenceImages: 0,
      inputFormats: ['PNG'],
      inputMaxBytes: 4 * 1024 * 1024,
    };
    expect(capabilitySizeDescription(caps)).toContain('1024x1024, 1792x1024');
  });

  it('spells out the documented reference-image contract', () => {
    const text = referenceImageDescription(QWEN3);
    expect(text).toContain('documents up to 3');
    expect(text).toContain('JPG/JPEG/PNG/BMP/TIFF/WEBP/GIF');
    expect(text).toContain('10MB');
    expect(text).toContain('384 and 2048');
  });
});

describe('sanitizeCapabilities', () => {
  it('drops malformed fields with a stderr warning and keeps the valid ones', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const clean = sanitizeCapabilities(
        {
          nMax: 'six',
          maxReferenceImages: 2,
          inputMaxBytes: 0,
          inputFormats: ['PNG', 7],
          bogusField: true,
        } as unknown as Parameters<typeof sanitizeCapabilities>[0],
        'customProviders.gw model "m"',
      );
      expect(clean).toEqual({ maxReferenceImages: 2 });
      const logged = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toContain('capabilities.nMax');
      expect(logged).toContain('capabilities.inputMaxBytes');
      expect(logged).toContain('capabilities.inputFormats');
      expect(logged).toContain('capabilities.bogusField');
      expect(logged).toContain('customProviders.gw model "m"');
    } finally {
      errSpy.mockRestore();
    }
  });

  it('validates sizeRange shape and passes a valid one through', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(
        sanitizeCapabilities({ sizeRange: { separator: 'x', minArea: 100 } } as never, 'test')
          .sizeRange,
      ).toBeUndefined();
      const valid = sanitizeCapabilities(
        {
          sizeRange: {
            separator: '*',
            minArea: 262144,
            maxArea: 4194304,
            minRatio: 0.125,
            maxRatio: 8,
            tiers: ['2K'],
          },
        },
        'test',
      );
      expect(valid.sizeRange?.separator).toBe('*');
      expect(valid.sizeRange?.tiers).toEqual(['2K']);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('drops an inverted ratio pair but keeps the rest of sizeRange', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const clean = sanitizeCapabilities(
        {
          sizeRange: {
            separator: 'x',
            minArea: 100,
            maxArea: 200,
            minRatio: 8,
            maxRatio: 0.125,
          },
        },
        'test',
      );
      // An inverted pair is dropped with a warning; the valid bounds survive.
      expect(clean.sizeRange?.minArea).toBe(100);
      expect(clean.sizeRange?.minRatio).toBeUndefined();
      expect(clean.sizeRange?.maxRatio).toBeUndefined();
      const logged = errSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(logged).toContain('ratio bounds');
    } finally {
      errSpy.mockRestore();
    }
  });
});
