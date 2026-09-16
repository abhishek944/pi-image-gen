/// <reference path="../upng-js.d.ts" />
import { inflateSync } from 'node:zlib';
import UPNG from 'upng-js';
import { ImageGenError } from '../errors.js';
import type { SpritePlan, SpriteValidationIssue } from './types.js';

export type RasterFrame = {
  rgba: Uint8Array;
  width: number;
  height: number;
  anchorX: number;
  anchorY: number;
};

export type RasterResult = {
  frames: RasterFrame[];
  normalizedSheet: Uint8Array;
  animation?: Uint8Array;
  issues: SpriteValidationIssue[];
  metrics: Record<string, number | number[] | string | boolean>;
};

type Bounds = { left: number; top: number; right: number; bottom: number; width: number; height: number; area: number; centroidX: number; centroidY: number; feetX: number };
type SourceFrame = { rgba: Uint8Array; bounds?: Bounds; sourceClipped: boolean; components: number; transparentRatio: number };
const ALPHA_THRESHOLD = 8;
const MAX_DECODED_PIXELS = 8_388_608;

export function processSpriteSheet(bytes: Uint8Array, plan: SpritePlan): RasterResult {
  let decoded: ReturnType<typeof UPNG.decode>;
  let rgbaBuffer: ArrayBuffer;
  let prepared: { bytes: Uint8Array; width: number; height: number };
  try {
    prepared = preparePngForDecode(bytes);
    decoded = UPNG.decode(toArrayBuffer(prepared.bytes));
    rgbaBuffer = UPNG.toRGBA8(decoded)[0]!;
  } catch (error) {
    if (error instanceof ImageGenError) throw error;
    throw new ImageGenError('The generated sprite sheet is not a readable PNG. The raw output was preserved; choose a model route that can return PNG.', 'sprite sheet PNG decode failed');
  }
  const width = prepared.width;
  const height = prepared.height;
  if (width % plan.columns !== 0 || height % plan.rows !== 0) {
    throw new ImageGenError(`The generated sheet dimensions (${width}×${height}) do not divide evenly into the requested ${plan.rows}×${plan.columns} grid. The raw output was preserved.`, 'sprite sheet dimensions do not match grid');
  }
  const cellWidth = width / plan.columns;
  const cellHeight = height / plan.rows;
  if (cellWidth < 8 || cellHeight < 8) {
    throw new ImageGenError('The generated sprite cells are too small to process safely. The raw output was preserved.', 'sprite cells too small');
  }
  const sheet = new Uint8Array(rgbaBuffer);
  const transparentPixels = countTransparent(sheet);
  const sources: SourceFrame[] = [];
  for (let index = 0; index < plan.frameCount; index++) {
    const row = Math.floor(index / plan.columns);
    const column = index % plan.columns;
    const cell = extractCell(sheet, width, column * cellWidth, row * cellHeight, cellWidth, cellHeight);
    sources.push(segmentFrame(cell, cellWidth, cellHeight, plan.componentMode));
  }

  const issues: SpriteValidationIssue[] = [];
  const empty = indexesWhere(sources, (frame) => !frame.bounds);
  if (empty.length) issues.push(issue('empty-frame', 'error', empty, 'One or more cells contain no meaningful foreground alpha.'));
  const clipped = indexesWhere(sources, (frame) => frame.sourceClipped);
  if (clipped.length) issues.push(issue('source-clipping', plan.strictValidation ? 'error' : 'warning', clipped, 'Foreground touches a source-cell edge.'));
  const opaqueCells = indexesWhere(sources, (frame) => frame.transparentRatio < 0.05);
  if (opaqueCells.length) issues.push(issue('missing-alpha', 'error', opaqueCells, 'Every source cell must contain a meaningful transparent background.'));
  const transparencyRatio = transparentPixels / (width * height);

  const fitScale = sharedSafeScale(sources, cellWidth, cellHeight, plan.align);
  const scale = plan.scaleStrategy === 'preserve' ? Math.min(1, fitScale) : fitScale;
  const frames = sources.map((source) => normalizeFrame(source, cellWidth, cellHeight, scale, plan.align));
  const outputClipped = indexesWhere(frames, (frame) => touchesEdge(frame.rgba, frame.width, frame.height));
  if (outputClipped.length) issues.push(issue('output-clipping', 'error', outputClipped, 'Normalized foreground touches an output edge.'));
  const emptyOutputs = indexesWhere(frames, (frame) => countTransparent(frame.rgba) === frame.width * frame.height);
  if (emptyOutputs.length) issues.push(issue('empty-normalized-frame', 'error', emptyOutputs, 'Normalization removed all foreground from one or more frames.'));

  const similarities: number[] = [];
  const differences: number[] = [];
  for (let index = 0; index < frames.length; index++) {
    const next = frames[(index + 1) % frames.length]!;
    const similarity = alphaIoU(frames[index]!.rgba, next.rgba);
    similarities.push(roundMetric(similarity));
    differences.push(roundMetric(1 - similarity));
  }
  if (frames.length > 1) {
    const duplicatePairs = similarities
      .map((value, index) => ({ value, index }))
      .filter(({ value }) => value > 0.985)
      .flatMap(({ index }) => [index, (index + 1) % frames.length]);
    if (duplicatePairs.length && plan.action !== 'idle') {
      issues.push(issue('near-duplicate-poses', plan.strictValidation ? 'error' : 'warning', [...new Set(duplicatePairs)], 'Adjacent registered alpha silhouettes are nearly identical.'));
    }
    const adjacent = differences.slice(0, -1);
    const meanMotion = adjacent.reduce((sum, value) => sum + value, 0) / adjacent.length;
    if (meanMotion < 0.015 && plan.action !== 'idle') issues.push(issue('insufficient-motion', plan.strictValidation ? 'error' : 'warning', undefined, 'The sequence contains too little visible motion.'));
    const medianMotion = median(adjacent);
    const spikeIndex = adjacent.findIndex((value) => value > Math.max(0.2, medianMotion * 4));
    if (spikeIndex >= 0) issues.push(issue('motion-spike', plan.strictValidation ? 'error' : 'warning', [spikeIndex, spikeIndex + 1], 'One transition changes much more than the rest of the sequence.'));
    const closure = differences.at(-1)!;
    const maxAdjacent = Math.max(...adjacent, 0);
    if (plan.action !== 'death' && closure > Math.max(0.75, maxAdjacent * 2)) issues.push(issue('loop-discontinuity', plan.strictValidation ? 'error' : 'warning', [frames.length - 1, 0], 'The final frame does not transition smoothly back to the first.'));
  }

  const normalizedSheet = encodePng(composeSheet(frames, plan.columns, plan.rows), cellWidth * plan.columns, cellHeight * plan.rows);
  let accepted = !issues.some((entry) => entry.severity === 'error');
  let animation: Uint8Array | undefined;
  if (accepted && plan.format === 'apng') {
    try {
      const candidate = encodeApng(frames, plan.frameDurationMs);
      verifyApng(candidate, frames);
      animation = candidate;
    } catch {
      issues.push(issue('apng-encoding', 'error', undefined, 'The local APNG did not reproduce the normalized frames exactly. PNG frames were preserved.'));
      accepted = false;
    }
  }
  return {
    frames,
    normalizedSheet,
    ...(animation ? { animation } : {}),
    issues,
    metrics: {
      sourceWidth: width,
      sourceHeight: height,
      cellWidth,
      cellHeight,
      frameCount: frames.length,
      transparentBackgroundRatio: roundMetric(transparencyRatio),
      sharedScale: roundMetric(scale),
      sourceForegroundAreaRatios: sources.map((frame) => roundMetric((frame.bounds?.area ?? 0) / (cellWidth * cellHeight))),
      sourceTransparentRatios: sources.map((frame) => roundMetric(frame.transparentRatio)),
      connectedComponents: sources.map((frame) => frame.components),
      adjacentAlphaIoU: similarities,
      adjacentAlphaDifference: differences,
      strictValidation: plan.strictValidation,
      accepted,
    },
  };
}

export function encodePng(rgba: Uint8Array, width: number, height: number): Uint8Array {
  return new Uint8Array(UPNG.encode([toArrayBuffer(rgba)], width, height, 0));
}

function encodeApng(frames: RasterFrame[], delay: number): Uint8Array {
  return new Uint8Array(UPNG.encode(frames.map((frame) => toArrayBuffer(frame.rgba)), frames[0]!.width, frames[0]!.height, 0, frames.map(() => delay)));
}

function verifyApng(bytes: Uint8Array, frames: RasterFrame[]): void {
  const parsed = inspectPng(bytes);
  if (!parsed.chunkTypes.includes('acTL') || parsed.chunkTypes.filter((type) => type === 'fcTL').length !== frames.length) {
    throw new Error('APNG frame structure mismatch');
  }
  const decoded = UPNG.decode(toArrayBuffer(bytes));
  const rgbaFrames = UPNG.toRGBA8(decoded);
  if (rgbaFrames.length !== frames.length) throw new Error('APNG decoded frame count mismatch');
  for (let index = 0; index < frames.length; index++) {
    const actual = new Uint8Array(rgbaFrames[index]!);
    const expected = frames[index]!.rgba;
    if (actual.length !== expected.length || actual.some((value, offset) => value !== expected[offset])) {
      throw new Error('APNG changed normalized pixels');
    }
  }
}

function segmentFrame(rgba: Uint8Array, width: number, height: number, mode: SpritePlan['componentMode']): SourceFrame {
  const labels = new Int32Array(width * height);
  labels.fill(-1);
  const components: Array<{ pixels: number[]; bounds: Bounds }> = [];
  for (let pixel = 0; pixel < width * height; pixel++) {
    if (labels[pixel] !== -1 || rgba[pixel * 4 + 3]! <= ALPHA_THRESHOLD) continue;
    const id = components.length;
    const queue = [pixel];
    labels[pixel] = id;
    const pixels: number[] = [];
    let q = 0;
    while (q < queue.length) {
      const current = queue[q++]!;
      pixels.push(current);
      const x = current % width;
      const y = Math.floor(current / width);
      for (const neighbor of [x > 0 ? current - 1 : -1, x + 1 < width ? current + 1 : -1, y > 0 ? current - width : -1, y + 1 < height ? current + width : -1]) {
        if (neighbor >= 0 && labels[neighbor] === -1 && rgba[neighbor * 4 + 3]! > ALPHA_THRESHOLD) {
          labels[neighbor] = id;
          queue.push(neighbor);
        }
      }
    }
    components.push({ pixels, bounds: boundsFromPixels(pixels, width) });
  }
  const minimumArea = Math.max(4, Math.floor(width * height * 0.00005));
  const meaningful = components.filter((component) => component.pixels.length >= minimumArea);
  const transparentRatio = countTransparent(rgba) / (width * height);
  if (!meaningful.length) return { rgba: new Uint8Array(rgba.length), sourceClipped: false, components: components.length, transparentRatio };
  const largest = meaningful.reduce((best, candidate) => candidate.pixels.length > best.pixels.length ? candidate : best);
  const proximity = Math.max(2, Math.floor(Math.min(width, height) * 0.04));
  const retained = mode === 'all' ? meaningful : meaningful.filter((component) => component === largest || component.pixels.length >= largest.pixels.length * 0.02 || boundsDistance(component.bounds, largest.bounds) <= proximity);
  const clean = new Uint8Array(rgba.length);
  for (const component of retained) for (const pixel of component.pixels) clean.set(rgba.subarray(pixel * 4, pixel * 4 + 4), pixel * 4);
  const allPixels = retained.flatMap((component) => component.pixels);
  const bounds = boundsFromPixels(allPixels, width);
  return { rgba: clean, bounds, sourceClipped: bounds.left <= 1 || bounds.top <= 1 || bounds.right >= width - 2 || bounds.bottom >= height - 2, components: meaningful.length, transparentRatio };
}

function sharedSafeScale(sources: SourceFrame[], width: number, height: number, align: SpritePlan['align']): number {
  const targetX = width / 2;
  const targetY = align === 'center' ? height / 2 : height * 0.94;
  const limits = {
    left: targetX - width * 0.04,
    right: width * 0.96 - targetX,
    top: targetY - height * 0.04,
    bottom: height * 0.96 - targetY,
  };
  let scale = Infinity;
  for (const source of sources) {
    if (!source.bounds) continue;
    const anchorX = align === 'feet' ? source.bounds.feetX : source.bounds.centroidX;
    const anchorY = align === 'center' ? source.bounds.centroidY : source.bounds.bottom;
    const extents = {
      left: anchorX - source.bounds.left,
      right: source.bounds.right + 1 - anchorX,
      top: anchorY - source.bounds.top,
      bottom: source.bounds.bottom + 1 - anchorY,
    };
    for (const side of ['left', 'right', 'top', 'bottom'] as const) {
      if (extents[side] > 0) scale = Math.min(scale, limits[side] / extents[side]);
    }
  }
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

function normalizeFrame(source: SourceFrame, width: number, height: number, scale: number, align: SpritePlan['align']): RasterFrame {
  const output = new Uint8Array(width * height * 4);
  if (!source.bounds) return { rgba: output, width, height, anchorX: width / 2, anchorY: height / 2 };
  const sourceAnchorX = align === 'feet' ? source.bounds.feetX : source.bounds.centroidX;
  const sourceAnchorY = align === 'center' ? source.bounds.centroidY : source.bounds.bottom;
  const anchorX = width / 2;
  const anchorY = align === 'center' ? height / 2 : height * 0.94;
  const offsetX = anchorX - sourceAnchorX * scale;
  const offsetY = anchorY - sourceAnchorY * scale;
  for (let y = 0; y < height; y++) {
    const sy = Math.floor((y - offsetY) / scale);
    if (sy < 0 || sy >= height) continue;
    for (let x = 0; x < width; x++) {
      const sx = Math.floor((x - offsetX) / scale);
      if (sx < 0 || sx >= width) continue;
      const sourceOffset = (sy * width + sx) * 4;
      if (source.rgba[sourceOffset + 3]! <= ALPHA_THRESHOLD) continue;
      output.set(source.rgba.subarray(sourceOffset, sourceOffset + 4), (y * width + x) * 4);
    }
  }
  return { rgba: output, width, height, anchorX, anchorY };
}

function boundsFromPixels(pixels: number[], width: number): Bounds {
  let left = Infinity, top = Infinity, right = -1, bottom = -1, sumX = 0, sumY = 0;
  for (const pixel of pixels) {
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y); sumX += x; sumY += y;
  }
  const lowerStart = bottom - Math.max(1, Math.floor((bottom - top + 1) * 0.12));
  const lower = pixels.filter((pixel) => Math.floor(pixel / width) >= lowerStart);
  const feetX = lower.reduce((sum, pixel) => sum + pixel % width, 0) / Math.max(1, lower.length);
  return { left, top, right, bottom, width: right - left + 1, height: bottom - top + 1, area: pixels.length, centroidX: sumX / pixels.length, centroidY: sumY / pixels.length, feetX };
}

function extractCell(sheet: Uint8Array, sheetWidth: number, left: number, top: number, width: number, height: number): Uint8Array {
  const output = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const start = ((top + y) * sheetWidth + left) * 4;
    output.set(sheet.subarray(start, start + width * 4), y * width * 4);
  }
  return output;
}

function composeSheet(frames: RasterFrame[], columns: number, rows: number): Uint8Array {
  const width = frames[0]!.width;
  const height = frames[0]!.height;
  const sheet = new Uint8Array(width * columns * height * rows * 4);
  const sheetWidth = width * columns;
  frames.forEach((frame, index) => {
    const left = (index % columns) * width;
    const top = Math.floor(index / columns) * height;
    for (let y = 0; y < height; y++) {
      const target = ((top + y) * sheetWidth + left) * 4;
      sheet.set(frame.rgba.subarray(y * width * 4, (y + 1) * width * 4), target);
    }
  });
  return sheet;
}

function alphaIoU(a: Uint8Array, b: Uint8Array): number {
  let intersection = 0, union = 0;
  for (let offset = 3; offset < a.length; offset += 4) {
    const aa = a[offset]! > ALPHA_THRESHOLD;
    const ba = b[offset]! > ALPHA_THRESHOLD;
    if (aa && ba) intersection++;
    if (aa || ba) union++;
  }
  return union === 0 ? 1 : intersection / union;
}

function touchesEdge(rgba: Uint8Array, width: number, height: number): boolean {
  for (let x = 0; x < width; x++) if (rgba[x * 4 + 3]! > ALPHA_THRESHOLD || rgba[((height - 1) * width + x) * 4 + 3]! > ALPHA_THRESHOLD) return true;
  for (let y = 0; y < height; y++) if (rgba[(y * width) * 4 + 3]! > ALPHA_THRESHOLD || rgba[(y * width + width - 1) * 4 + 3]! > ALPHA_THRESHOLD) return true;
  return false;
}

function boundsDistance(a: Bounds, b: Bounds): number {
  const dx = Math.max(0, b.left - a.right - 1, a.left - b.right - 1);
  const dy = Math.max(0, b.top - a.bottom - 1, a.top - b.bottom - 1);
  return Math.hypot(dx, dy);
}

function countTransparent(rgba: Uint8Array): number {
  let count = 0;
  for (let offset = 3; offset < rgba.length; offset += 4) if (rgba[offset]! <= ALPHA_THRESHOLD) count++;
  return count;
}

function indexesWhere<T>(values: T[], predicate: (value: T) => boolean): number[] {
  return values.map((value, index) => predicate(value) ? index : -1).filter((index) => index >= 0);
}

function issue(code: string, severity: SpriteValidationIssue['severity'], indexes: number[] | undefined, message: string): SpriteValidationIssue {
  return { code, severity, ...(indexes?.length ? { frameIndexes: indexes.map((index) => index + 1) } : {}), message };
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function roundMetric(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function preparePngForDecode(bytes: Uint8Array): { bytes: Uint8Array; width: number; height: number } {
  const inspected = inspectPng(bytes);
  if (inspected.width * inspected.height > MAX_DECODED_PIXELS) {
    throw new ImageGenError(`The generated PNG exceeds the ${MAX_DECODED_PIXELS.toLocaleString()}-pixel processing ceiling. The raw output was preserved.`, 'sprite PNG decoded size too large');
  }
  const supportedPixels = inspected.colorType === 3 || (inspected.bitDepth === 8 && [2, 4, 6].includes(inspected.colorType));
  if (!supportedPixels) {
    throw new ImageGenError('The generated PNG uses an unsupported pixel format. Use an indexed-color PNG or an 8-bit color PNG with alpha/transparency.', 'sprite PNG pixel format unsupported');
  }
  if (inspected.interlace !== 0) {
    throw new ImageGenError('Interlaced PNG sheets are not supported. The raw output was preserved.', 'interlaced sprite PNG unsupported');
  }
  if (inspected.chunkTypes.includes('acTL')) {
    throw new ImageGenError('The generated sheet must be a still PNG, not an APNG. The raw output was preserved.', 'animated source sheet unsupported');
  }
  validateInflatedSize(bytes, inspected);
  const unsafeMetadata = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf']);
  const retained = inspected.chunks.filter((chunk) => !unsafeMetadata.has(chunk.type));
  return { bytes: concatBytes([bytes.subarray(0, 8), ...retained.map((chunk) => bytes.subarray(chunk.start, chunk.end))]), width: inspected.width, height: inspected.height };
}

function inspectPng(bytes: Uint8Array): { width: number; height: number; bitDepth: number; colorType: number; interlace: number; chunkTypes: string[]; chunks: Array<{ type: string; start: number; end: number }> } {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 33 || signature.some((value, index) => bytes[index] !== value)) throw new Error('invalid PNG signature');
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: Array<{ type: string; start: number; end: number }> = [];
  const chunkTypes: string[] = [];
  let offset = 8;
  let sawIend = false;
  while (offset + 12 <= bytes.length) {
    const length = view.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length || end < offset) throw new Error('invalid PNG chunk length');
    const type = view.toString('ascii', offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) throw new Error('invalid PNG chunk type');
    chunks.push({ type, start: offset, end });
    chunkTypes.push(type);
    offset = end;
    if (type === 'IEND') { sawIend = true; break; }
  }
  if (!sawIend || chunkTypes[0] !== 'IHDR' || chunkTypes.filter((type) => type === 'IHDR').length !== 1 || chunkTypes.filter((type) => type === 'IEND').length !== 1 || !chunkTypes.includes('IDAT')) throw new Error('incomplete or ambiguous PNG structure');
  const width = view.readUInt32BE(16);
  const height = view.readUInt32BE(20);
  if (width < 1 || height < 1) throw new Error('invalid PNG dimensions');
  return { width, height, bitDepth: view[24]!, colorType: view[25]!, interlace: view[28]!, chunkTypes, chunks };
}

function validateInflatedSize(bytes: Uint8Array, inspected: ReturnType<typeof inspectPng>): void {
  const channels = inspected.colorType === 2 ? 3 : inspected.colorType === 3 ? 1 : inspected.colorType === 4 ? 2 : 4;
  const rowBytes = Math.ceil(inspected.width * channels * inspected.bitDepth / 8);
  const expected = inspected.height * (rowBytes + 1);
  const idat = concatBytes(inspected.chunks.filter((chunk) => chunk.type === 'IDAT').map((chunk) => bytes.subarray(chunk.start + 8, chunk.end - 4)));
  try {
    const inflated = inflateSync(idat, { maxOutputLength: expected });
    if (inflated.length !== expected) throw new Error('unexpected inflated PNG size');
  } catch {
    throw new ImageGenError('The generated PNG has invalid or oversized compressed pixel data. The raw output was preserved.', 'sprite PNG inflate rejected');
  }
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
