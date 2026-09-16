import type { GenerationMetadata } from '../types.js';

export type SpriteOutputFormat = 'apng' | 'frames';
export type SpriteAlignment = 'center' | 'bottom' | 'feet';
export type SpriteScaleStrategy = 'fit' | 'preserve';
export type SpriteComponentMode = 'largest' | 'all';

export type SpriteGenerationSettings = {
  enabled?: boolean;
  defaultRows?: number;
  defaultColumns?: number;
  defaultFormat?: SpriteOutputFormat;
  frameDurationMs?: number;
  strictValidation?: boolean;
  outputDir?: string;
  maxFrames?: number;
};

export type NormalizedSpriteSettings = {
  enabled: boolean;
  defaultRows: number;
  defaultColumns: number;
  defaultFormat: SpriteOutputFormat;
  frameDurationMs: number;
  strictValidation: boolean;
  outputDir: string;
  maxFrames: number;
};

export type SpriteGenerateParams = {
  prompt: string;
  image?: string[];
  assetType?: 'player' | 'npc' | 'creature' | 'character' | 'prop' | 'spell' | 'projectile' | 'impact' | 'fx';
  action?: 'single' | 'idle' | 'walk' | 'run' | 'cast' | 'attack' | 'shoot' | 'jump' | 'hurt' | 'hover' | 'charge' | 'explode' | 'death';
  view?: 'topdown' | 'side' | 'three-quarter';
  rows?: number;
  columns?: number;
  frameCount?: number;
  align?: SpriteAlignment;
  scaleStrategy?: SpriteScaleStrategy;
  componentMode?: SpriteComponentMode;
  format?: SpriteOutputFormat;
  frameDurationMs?: number;
  strictValidation?: boolean;
  size?: string;
  aspectRatio?: string;
  imageSize?: string;
  quality?: string;
  filename?: string;
  outputDir?: string;
};

export type SpriteValidationIssue = {
  code: string;
  severity: 'warning' | 'error';
  frameIndexes?: number[];
  message: string;
};

export type SpriteFrameResult = {
  index: number;
  path: string;
  width: number;
  height: number;
  anchorX: number;
  anchorY: number;
};

export type SpriteGenerateResult = {
  model: string;
  provider: string;
  runDirectory: string;
  rawSheet: string;
  normalizedSheet?: string;
  frames: SpriteFrameResult[];
  animation?: {
    format: 'apng';
    path: string;
    frameDurationMs: number;
  };
  validation: {
    accepted: boolean;
    issues: SpriteValidationIssue[];
    metrics: Record<string, number | number[] | string | boolean>;
  };
  metadata?: GenerationMetadata & { generationDurationMs?: number };
};

export type SpritePlan = {
  rows: number;
  columns: number;
  frameCount: number;
  align: SpriteAlignment;
  scaleStrategy: SpriteScaleStrategy;
  componentMode: SpriteComponentMode;
  format: SpriteOutputFormat;
  frameDurationMs: number;
  strictValidation: boolean;
  action: NonNullable<SpriteGenerateParams['action']>;
  assetType: NonNullable<SpriteGenerateParams['assetType']>;
  view: NonNullable<SpriteGenerateParams['view']>;
};
