import { describe, expect, it } from 'vitest';
import {
  altFromPath,
  formatCommandSummary,
  formatToolResultText,
  markdownImageUrl,
} from '../index.js';
import type { ImageGenResult } from '../types.js';

describe('altFromPath', () => {
  it('uses the filename without extension', () => {
    expect(altFromPath('/Users/foo/.pi/images/white.png')).toBe('white');
  });

  it('handles relative paths', () => {
    expect(altFromPath('a/b/c/photo.jpeg')).toBe('photo');
  });

  it('handles Windows paths', () => {
    expect(altFromPath('C:\\Users\\foo\\bar.png')).toBe('bar');
  });

  it('preserves filename when there is no extension', () => {
    expect(altFromPath('/tmp/Makefile')).toBe('Makefile');
  });

  it('escapes literal ] inside the filename', () => {
    expect(altFromPath('/tmp/weird]name.png')).toBe('weird\\]name');
  });

  it('falls back to "image" for empty path', () => {
    expect(altFromPath('')).toBe('image');
  });
});

describe('formatToolResultText', () => {
  function makeResult(overrides: Partial<ImageGenResult> = {}): ImageGenResult {
    return {
      model: 'qwen-image-2.0',
      provider: 'amaster (custom)',
      images: [],
      ...overrides,
    };
  }

  it('emits inline markdown using the file stem as alt', () => {
    const text = formatToolResultText(
      makeResult({
        images: [{ path: '/Users/me/.pi/images/white.png', mimeType: 'image/png' }],
      }),
    );
    expect(text).toContain('![white](/Users/me/.pi/images/white.png)');
    expect(text).toContain('Show each one to the user as inline markdown');
    // Does not include the model id in the alt text.
    expect(text).not.toContain('![qwen-image-2.0]');
  });

  it('emits one markdown line per image, in order', () => {
    const text = formatToolResultText(
      makeResult({
        images: [
          { path: '/tmp/first.png', mimeType: 'image/png' },
          { path: '/tmp/second.jpg', mimeType: 'image/jpeg' },
        ],
      }),
    );
    const idxFirst = text.indexOf('![first](/tmp/first.png)');
    const idxSecond = text.indexOf('![second](/tmp/second.jpg)');
    expect(idxFirst).toBeGreaterThan(-1);
    expect(idxSecond).toBeGreaterThan(-1);
    expect(idxFirst).toBeLessThan(idxSecond);
  });

  it('shows revised_prompt as a quoted note under the image', () => {
    const text = formatToolResultText(
      makeResult({
        images: [
          {
            path: '/tmp/cat.png',
            mimeType: 'image/png',
            revisedPrompt: 'a cute cat, photorealistic',
          },
        ],
      }),
    );
    expect(text).toContain('![cat](/tmp/cat.png)');
    expect(text).toContain('> revised prompt: a cute cat, photorealistic');
  });

  it('header reports image count, provider, and model', () => {
    const text = formatToolResultText(
      makeResult({
        images: [
          { path: '/a.png', mimeType: 'image/png' },
          { path: '/b.png', mimeType: 'image/png' },
        ],
      }),
    );
    expect(text).toContain('Generated 2 image(s) via amaster (custom) (qwen-image-2.0)');
  });

  it('rewrites Windows paths as file:/// URLs (regression: raw C:\\… loses the img src)', () => {
    const text = formatToolResultText(
      makeResult({
        images: [
          { path: 'C:\\Users\\tester\\workspace\\images\\result.png', mimeType: 'image/png' },
        ],
      }),
    );
    expect(text).toContain('![result](file:///C:/Users/tester/workspace/images/result.png)');
    expect(text).not.toContain('C:\\Users');
  });
});

describe('markdownImageUrl', () => {
  it('rewrites Windows drive paths as file:/// URLs', () => {
    expect(markdownImageUrl('C:\\Users\\tester\\images\\result.png')).toBe(
      'file:///C:/Users/tester/images/result.png',
    );
    expect(markdownImageUrl('C:/Users/tester/images/result.png')).toBe(
      'file:///C:/Users/tester/images/result.png',
    );
  });

  it('percent-encodes spaces, CJK, # and parens', () => {
    expect(markdownImageUrl('D:\\我的 图片\\cat (1)#v2.png')).toBe(
      'file:///D:/%E6%88%91%E7%9A%84%20%E5%9B%BE%E7%89%87/cat%20%281%29%23v2.png',
    );
  });

  it('leaves clean POSIX absolute paths byte-identical (they already render inline)', () => {
    expect(markdownImageUrl('/Users/me/.pi/images/white.png')).toBe(
      '/Users/me/.pi/images/white.png',
    );
  });

  it('escapes markdown-unsafe chars in POSIX paths but leaves CJK untouched', () => {
    expect(markdownImageUrl('/Users/me/my 图/cat (1)#v2.png')).toBe(
      '/Users/me/my%20图/cat%20%281%29%23v2.png',
    );
  });

  it('pads control-char escapes to two hex digits', () => {
    expect(markdownImageUrl('/tmp/a\tb.png')).toBe('/tmp/a%09b.png');
  });
});

describe('formatCommandSummary', () => {
  function makeResult(overrides: Partial<ImageGenResult> = {}): ImageGenResult {
    return {
      model: 'gpt-image-2',
      provider: 'openai',
      images: [],
      ...overrides,
    };
  }

  it('lists raw paths WITHOUT markdown image syntax (notify renders plain text)', () => {
    const text = formatCommandSummary(
      makeResult({
        images: [{ path: '/Users/me/.pi/images/white.png', mimeType: 'image/png' }],
      }),
    );
    expect(text).toContain('/Users/me/.pi/images/white.png');
    // notify() shows a status line, not markdown — the literal `![](…)` would
    // leak to the user, so the command summary must not contain it.
    expect(text).not.toContain('![');
    expect(text).not.toContain('](');
  });

  it('reports image count, provider, and model in the header', () => {
    const text = formatCommandSummary(
      makeResult({
        images: [
          { path: '/a.png', mimeType: 'image/png' },
          { path: '/b.png', mimeType: 'image/png' },
        ],
      }),
    );
    expect(text).toContain('Generated 2 image(s) via openai (gpt-image-2)');
  });

  it('includes the revised prompt as an indented note, not a quote line', () => {
    const text = formatCommandSummary(
      makeResult({
        images: [{ path: '/tmp/cat.png', mimeType: 'image/png', revisedPrompt: 'a cute cat' }],
      }),
    );
    expect(text).toContain('/tmp/cat.png');
    expect(text).toContain('revised prompt: a cute cat');
    expect(text).not.toContain('> revised prompt');
  });
});
