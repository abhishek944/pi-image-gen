import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { capabilitiesForApi, genericCapabilitiesForApi } from '../capabilities.js';
import { resolveModel } from '../config.js';
import { cancelledError, describeWriteError, ImageGenError } from '../errors.js';
import { generateImage, type GenerateImageOptions } from '../generate.js';
import type { GenerateImageParams, ImageModelCapabilities } from '../types.js';
import { buildSpritePrompt, spriteGenerationControls } from './prompt.js';
import { encodePng, processSpriteSheet } from './raster.js';
import { normalizeSpriteSettings, planSprite } from './settings.js';
import type { SpriteGenerateParams, SpriteGenerateResult } from './types.js';

export type SpriteProgressPhase =
  | 'planning'
  | 'loading-inputs'
  | 'generating-sheet'
  | 'saving-raw-sheet'
  | 'decoding-sheet'
  | 'extracting-frames'
  | 'normalizing-frames'
  | 'validating-animation'
  | 'encoding-animation'
  | 'saving-output';

export type SpritePipelineOptions = Omit<GenerateImageOptions, 'onProgress'> & {
  modelCapabilities?: ImageModelCapabilities;
  onProgress?: (phase: SpriteProgressPhase) => void;
};

export async function runSpritePipeline(params: SpriteGenerateParams, options: SpritePipelineOptions): Promise<SpriteGenerateResult> {
  const startedAt = Date.now();
  options.onProgress?.('planning');
  const spriteSettings = normalizeSpriteSettings(options.settings.spriteGeneration);
  const plan = planSprite(params, spriteSettings);
  const modelCapabilities = options.modelCapabilities ?? resolvePipelineCapabilities(options.settings);
  validateSpriteCapabilities(params, plan, modelCapabilities);
  checkAbort(options.signal);
  const runDirectory = await reserveRunDirectory(params.outputDir ?? spriteSettings.outputDir, params.filename, options.cwd);
  let complete = false;
  let paidOutputSaved = false;
  try {
    const prompt = buildSpritePrompt(params, plan);
    await safeWrite(resolve(runDirectory, 'prompt-used.txt'), `${prompt}\n`, options.signal);
    const controls = spriteGenerationControls(params, plan, modelCapabilities ?? null);
    const generationParams: GenerateImageParams = {
      prompt,
      ...(params.image ? { image: params.image } : {}),
      n: 1,
      filename: 'raw-sheet',
      outputDir: runDirectory,
      ...controls,
    };
    options.onProgress?.('generating-sheet');
    const generated = await generateImage(generationParams, {
      cwd: options.cwd,
      settings: options.settings,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.now ? { now: options.now } : {}),
      ...(options.modelRegistry ? { modelRegistry: options.modelRegistry } : {}),
      ...(modelCapabilities ? { modelCapabilities } : {}),
      onProgress: (phase) => options.onProgress?.(
        phase === 'loading-inputs' ? 'loading-inputs' : phase === 'waiting-provider' ? 'generating-sheet' : 'saving-raw-sheet',
      ),
    });
    const rawSheet = generated.images[0]?.path;
    if (!rawSheet || generated.images.length !== 1) throw new ImageGenError('The provider did not return exactly one sprite sheet.', 'sprite provider output count invalid');
    paidOutputSaved = true;
    checkAbort(options.signal);
    options.onProgress?.('decoding-sheet');
    const rawBytes = new Uint8Array(await readFile(rawSheet));
    options.onProgress?.('extracting-frames');
    let raster: ReturnType<typeof processSpriteSheet>;
    try {
      raster = processSpriteSheet(rawBytes, plan);
    } catch (error) {
      if (!(error instanceof ImageGenError) || /cancelled/i.test(error.logSummary)) throw error;
      const rejected: SpriteGenerateResult = {
        model: generated.model,
        provider: generated.provider,
        runDirectory,
        rawSheet,
        frames: [],
        validation: {
          accepted: false,
          issues: [{ code: 'sheet-processing-failed', severity: 'error', message: error.message }],
          metrics: { accepted: false, processingCompleted: false },
        },
        metadata: resultMetadata(generated.metadata, startedAt),
      };
      await safeWrite(resolve(runDirectory, 'pipeline-meta.json'), `${JSON.stringify(sanitizedManifest(rejected, plan), null, 2)}\n`, options.signal);
      complete = true;
      return rejected;
    }
    checkAbort(options.signal);
    options.onProgress?.('normalizing-frames');
    const framesDir = resolve(runDirectory, 'frames');
    await mkdir(framesDir);
    const frames: SpriteGenerateResult['frames'] = [];
    for (let index = 0; index < raster.frames.length; index++) {
      checkAbort(options.signal);
      const frame = raster.frames[index]!;
      const path = resolve(framesDir, `frame-${String(index + 1).padStart(2, '0')}.png`);
      await safeWrite(path, encodePng(frame.rgba, frame.width, frame.height), options.signal);
      frames.push({ index: index + 1, path, width: frame.width, height: frame.height, anchorX: frame.anchorX, anchorY: frame.anchorY });
    }
    options.onProgress?.('validating-animation');
    const normalizedSheet = resolve(runDirectory, 'sheet-transparent.png');
    await safeWrite(normalizedSheet, raster.normalizedSheet, options.signal);
    let animation: SpriteGenerateResult['animation'];
    if (raster.animation) {
      options.onProgress?.('encoding-animation');
      const path = resolve(runDirectory, 'animation.apng');
      await safeWrite(path, raster.animation, options.signal);
      animation = { format: 'apng', path, frameDurationMs: plan.frameDurationMs };
    }
    const accepted = !raster.issues.some((issue) => issue.severity === 'error');
    const metadata = resultMetadata(generated.metadata, startedAt);
    const result: SpriteGenerateResult = {
      model: generated.model,
      provider: generated.provider,
      runDirectory,
      rawSheet,
      normalizedSheet,
      frames,
      ...(animation ? { animation } : {}),
      validation: { accepted, issues: raster.issues, metrics: raster.metrics },
      metadata,
    };
    options.onProgress?.('saving-output');
    await safeWrite(resolve(runDirectory, 'pipeline-meta.json'), `${JSON.stringify(sanitizedManifest(result, plan), null, 2)}\n`, options.signal);
    complete = true;
    return result;
  } catch (error) {
    if (!complete) {
      const cancelled = error instanceof ImageGenError && /cancelled/i.test(error.logSummary);
      if (cancelled && !paidOutputSaved) {
        try { await rm(runDirectory, { recursive: true, force: true }); } catch { /* best-effort cancellation cleanup */ }
      } else {
        const category = error instanceof ImageGenError ? error.logSummary : 'unexpected processing error';
        try {
          await safeWrite(resolve(runDirectory, 'pipeline-meta.json'), `${JSON.stringify({ status: cancelled ? 'cancelled' : 'failed', paidOutputSaved, category }, null, 2)}\n`);
        } catch { /* best-effort failure report; preserve the original error */ }
      }
    }
    throw error;
  }
}

function resultMetadata(generated: Awaited<ReturnType<typeof generateImage>>['metadata'], startedAt: number): NonNullable<SpriteGenerateResult['metadata']> {
  return {
    durationMs: Date.now() - startedAt,
    ...(generated?.requestId ? { requestId: generated.requestId } : {}),
    ...(generated?.usage ? { usage: generated.usage } : {}),
    ...(generated?.cost != null ? { cost: generated.cost } : {}),
    ...(generated ? { generationDurationMs: generated.durationMs } : {}),
  };
}

function resolvePipelineCapabilities(settings: SpritePipelineOptions['settings']): ImageModelCapabilities | undefined {
  const model = typeof settings.defaultModel === 'string' ? settings.defaultModel.trim() : '';
  if (!model) return undefined;
  const resolved = resolveModel(model, settings);
  if ('error' in resolved) return undefined;
  if (!resolved.capabilities) return genericCapabilitiesForApi(resolved.provider.api);
  const effective = resolved.provider.builtIn || resolved.capabilitiesIncludeRegistry
    ? resolved.capabilities
    : { ...genericCapabilitiesForApi(resolved.provider.api), ...(resolved.declaredCapabilities ?? {}) };
  return capabilitiesForApi(effective, resolved.provider.api);
}

function validateSpriteCapabilities(params: SpriteGenerateParams, plan: ReturnType<typeof planSprite>, caps?: ImageModelCapabilities): void {
  if (params.image !== undefined && !Array.isArray(params.image)) {
    throw new ImageGenError('image must be an array of safe local paths or public HTTP(S) URLs.', 'sprite references invalid');
  }
  if (caps && (params.image?.length ?? 0) > caps.maxReferenceImages) {
    throw new ImageGenError(`The active model documents at most ${caps.maxReferenceImages} reference image(s) for one request.`, 'sprite reference count exceeds model contract');
  }
  if (caps?.outputFormats?.length && !caps.outputFormats.includes('png')) {
    throw new ImageGenError('The active model is declared unable to return PNG, which sprite processing requires. Choose a PNG-capable model.', 'sprite model lacks PNG output');
  }
  if (caps?.backgroundValues?.length && !caps.backgroundValues.includes('transparent')) {
    throw new ImageGenError('The active model is declared unable to request a transparent background. Choose a model with transparent-background support.', 'sprite model lacks transparent output');
  }
  if (params.size) {
    const match = /^(\d{2,5})\s*[x*]\s*(\d{2,5})$/i.exec(params.size);
    if (match) {
      const width = Number(match[1]);
      const height = Number(match[2]);
      if (width % plan.columns !== 0 || height % plan.rows !== 0) {
        throw new ImageGenError('The requested pixel size must divide evenly by the sprite grid columns and rows.', 'sprite size does not divide grid');
      }
    }
  }
}

function sanitizedManifest(result: SpriteGenerateResult, plan: ReturnType<typeof planSprite>): Record<string, unknown> {
  return {
    status: result.validation.accepted ? 'accepted' : 'rejected',
    model: result.model,
    provider: result.provider,
    grid: { rows: plan.rows, columns: plan.columns, frameCount: plan.frameCount, order: 'row-major' },
    processing: { align: plan.align, scaleStrategy: plan.scaleStrategy, componentMode: plan.componentMode, strictValidation: plan.strictValidation },
    outputs: {
      rawSheet: result.rawSheet,
      normalizedSheet: result.normalizedSheet,
      frames: result.frames.map((frame) => frame.path),
      animation: result.animation?.path,
    },
    validation: result.validation,
    metadata: result.metadata,
  };
}

async function reserveRunDirectory(configured: string, filename: string | undefined, cwd: string): Promise<string> {
  const root = resolveOutputRoot(configured, cwd);
  if (!isAbsolute(configured)) await rejectExistingSymlinkComponents(root);
  try { await mkdir(root, { recursive: true }); } catch (error) { throw describeWriteError('create the sprite output directory', error); }
  const stem = sanitizeName(filename ?? `sprite-${formatStamp(new Date())}`);
  for (let version = 1; ; version++) {
    const candidate = resolve(root, version === 1 ? stem : `${stem}-v${version}`);
    try {
      await mkdir(candidate);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw describeWriteError('reserve the sprite run directory', error);
    }
  }
}

function resolveOutputRoot(configured: string, cwd: string): string {
  if (isAbsolute(configured)) return resolve(configured);
  const target = resolve(cwd, configured);
  const rel = relative(resolve(cwd), target);
  if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) {
    throw new ImageGenError('A relative sprite outputDir must stay inside the session working directory.', 'sprite output directory escapes cwd');
  }
  return target;
}

async function rejectExistingSymlinkComponents(target: string): Promise<void> {
  let current = target;
  while (true) {
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new ImageGenError('The relative sprite output path must not contain symbolic links.', 'sprite output path contains symlink');
      }
    } catch (error) {
      if (error instanceof ImageGenError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw describeWriteError('inspect the sprite output path', error);
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function safeWrite(path: string, data: string | Uint8Array, signal?: AbortSignal): Promise<void> {
  checkAbort(signal);
  const temp = `${path}.tmp-${randomUUID()}`;
  let created = false;
  try {
    created = true;
    await writeFile(temp, data, { flag: 'wx', signal });
    checkAbort(signal);
    await rename(temp, path);
    created = false;
  } catch (error) {
    if (created) {
      try { await unlink(temp); } catch { /* best-effort temporary-file cleanup */ }
    }
    if (signal?.aborted) throw cancelledError('sprite generation');
    throw describeWriteError('write a sprite output file', error);
  }
  checkAbort(signal);
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancelledError('sprite generation');
}

function sanitizeName(value: string): string {
  const clean = value.trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, '_').slice(0, 80);
  return clean || 'sprite';
}

function formatStamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
}
