import { ImageGenError } from '../errors.js';
import type { SpriteGenerateParams, SpritePlan, NormalizedSpriteSettings, SpriteGenerationSettings } from './types.js';

export const HARD_MAX_SPRITE_FRAMES = 16;
export const DEFAULT_SPRITE_SETTINGS: NormalizedSpriteSettings = {
  enabled: false,
  defaultRows: 2,
  defaultColumns: 3,
  defaultFormat: 'apng',
  frameDurationMs: 120,
  strictValidation: true,
  outputDir: '.pi/images/sprites',
  maxFrames: HARD_MAX_SPRITE_FRAMES,
};

export function normalizeSpriteSettings(raw: SpriteGenerationSettings | undefined): NormalizedSpriteSettings {
  if (!isRecord(raw)) return { ...DEFAULT_SPRITE_SETTINGS };
  const maxFrames = boundedInteger(raw.maxFrames, 1, HARD_MAX_SPRITE_FRAMES) ?? DEFAULT_SPRITE_SETTINGS.maxFrames;
  const requestedRows = boundedInteger(raw.defaultRows, 1, HARD_MAX_SPRITE_FRAMES) ?? DEFAULT_SPRITE_SETTINGS.defaultRows;
  const requestedColumns = boundedInteger(raw.defaultColumns, 1, HARD_MAX_SPRITE_FRAMES) ?? DEFAULT_SPRITE_SETTINGS.defaultColumns;
  const [defaultRows, defaultColumns] = requestedRows * requestedColumns <= maxFrames
    ? [requestedRows, requestedColumns]
    : [1, Math.min(DEFAULT_SPRITE_SETTINGS.defaultColumns, maxFrames)];
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : false,
    defaultRows,
    defaultColumns,
    defaultFormat: raw.defaultFormat === 'apng' || raw.defaultFormat === 'frames' ? raw.defaultFormat : DEFAULT_SPRITE_SETTINGS.defaultFormat,
    frameDurationMs: boundedInteger(raw.frameDurationMs, 20, 10_000) ?? DEFAULT_SPRITE_SETTINGS.frameDurationMs,
    strictValidation: typeof raw.strictValidation === 'boolean' ? raw.strictValidation : DEFAULT_SPRITE_SETTINGS.strictValidation,
    outputDir: typeof raw.outputDir === 'string' && raw.outputDir.trim() ? raw.outputDir.trim() : DEFAULT_SPRITE_SETTINGS.outputDir,
    maxFrames,
  };
}

export function planSprite(params: SpriteGenerateParams, settings: NormalizedSpriteSettings): SpritePlan {
  if (!settings.enabled) {
    throw new ImageGenError('Sprite generation is disabled. Set pi-image-gen.spriteGeneration.enabled to true, then run /image-gen reload.', 'sprite generation disabled');
  }
  if (typeof params.prompt !== 'string' || !params.prompt.trim()) {
    throw new ImageGenError('Sprite prompt must not be blank.', 'sprite prompt blank');
  }
  if (params.prompt.length > 20_000) {
    throw new ImageGenError('Sprite prompt is too long (maximum 20000 characters).', 'sprite prompt too long');
  }
  const rows = params.rows ?? settings.defaultRows;
  const columns = params.columns ?? settings.defaultColumns;
  if (!boundedInteger(rows, 1, HARD_MAX_SPRITE_FRAMES) || !boundedInteger(columns, 1, HARD_MAX_SPRITE_FRAMES)) {
    throw new ImageGenError(`Sprite rows and columns must be integers from 1 to ${HARD_MAX_SPRITE_FRAMES}.`, 'sprite grid invalid');
  }
  const capacity = rows * columns;
  const frameCount = params.frameCount ?? capacity;
  if (!Number.isInteger(frameCount) || frameCount !== capacity) {
    throw new ImageGenError('frameCount must equal rows × columns; unused cells are not supported.', 'sprite frame count invalid');
  }
  if (capacity > settings.maxFrames || capacity > HARD_MAX_SPRITE_FRAMES) {
    throw new ImageGenError(`Sprite grid exceeds the configured maximum of ${settings.maxFrames} frames.`, 'sprite grid too large');
  }
  const duration = params.frameDurationMs ?? settings.frameDurationMs;
  if (!boundedInteger(duration, 20, 10_000)) {
    throw new ImageGenError('frameDurationMs must be an integer from 20 to 10000.', 'sprite frame duration invalid');
  }
  const align = params.align ?? defaultAlignment(params.assetType);
  const scaleStrategy = params.scaleStrategy ?? 'fit';
  const componentMode = params.componentMode ?? defaultComponentMode(params.assetType);
  const format = params.format ?? settings.defaultFormat;
  const action = params.action ?? (capacity === 1 ? 'single' : 'walk');
  const assetType = params.assetType ?? 'character';
  const view = params.view ?? 'side';
  if (!['center', 'bottom', 'feet'].includes(align) || !['fit', 'preserve'].includes(scaleStrategy) || !['largest', 'all'].includes(componentMode) || !['apng', 'frames'].includes(format) || !['single', 'idle', 'walk', 'run', 'cast', 'attack', 'shoot', 'jump', 'hurt', 'hover', 'charge', 'explode', 'death'].includes(action) || !['player', 'npc', 'creature', 'character', 'prop', 'spell', 'projectile', 'impact', 'fx'].includes(assetType) || !['topdown', 'side', 'three-quarter'].includes(view)) {
    throw new ImageGenError('One or more sprite enum parameters are invalid.', 'sprite enum parameter invalid');
  }
  if (params.strictValidation !== undefined && typeof params.strictValidation !== 'boolean') {
    throw new ImageGenError('strictValidation must be a boolean.', 'sprite strictValidation invalid');
  }
  if (format === 'apng' && frameCount < 2) {
    throw new ImageGenError('APNG output requires at least two frames. Use format "frames" for a single sprite.', 'single-frame APNG unsupported');
  }
  return { rows, columns, frameCount, align, scaleStrategy, componentMode, format, frameDurationMs: duration, strictValidation: params.strictValidation ?? settings.strictValidation, action, assetType, view };
}

function defaultAlignment(assetType: SpriteGenerateParams['assetType']): SpritePlan['align'] {
  return assetType === 'fx' || assetType === 'spell' || assetType === 'projectile' || assetType === 'impact' ? 'center' : 'feet';
}

function defaultComponentMode(assetType: SpriteGenerateParams['assetType']): SpritePlan['componentMode'] {
  return assetType === 'fx' || assetType === 'spell' || assetType === 'projectile' || assetType === 'impact' ? 'all' : 'largest';
}

function boundedInteger(value: unknown, min: number, max: number): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
