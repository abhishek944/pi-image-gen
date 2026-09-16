import { StringEnum } from '@earendil-works/pi-ai';
import { Type, type TObject } from 'typebox';
import { hasAspectRatioKnob } from '../capabilities.js';
import { MAX_REFERENCE_IMAGE_INPUTS } from '../image-input.js';
import type { ImageToolCapabilities } from '../extension.js';
import { HARD_MAX_SPRITE_FRAMES } from './settings.js';

export function buildSpriteToolParameters(caps: ImageToolCapabilities): TObject {
  const model = caps.model;
  const aspectRatios = model && hasAspectRatioKnob(model) ? model.aspectRatios : undefined;
  const genericGemini = caps.api === 'gemini' && !aspectRatios;
  const declaredImageSizes = model?.imageSizes;
  const imageSizes = (declaredImageSizes?.length ?? 0) > 1 ? declaredImageSizes : undefined;
  const genericImageSize = genericGemini && !declaredImageSizes;
  return Type.Object({
    prompt: Type.String({ description: 'Identity, style, and one action to render as a coherent sprite sequence.' }),
    image: Type.Optional(Type.Array(Type.String(), { maxItems: MAX_REFERENCE_IMAGE_INPUTS, description: 'Optional reference image paths or public HTTP(S) URLs. Uses the same safe input rules as image_generate.' })),
    assetType: Type.Optional(StringEnum(['player', 'npc', 'creature', 'character', 'prop', 'spell', 'projectile', 'impact', 'fx'] as const)),
    action: Type.Optional(StringEnum(['single', 'idle', 'walk', 'run', 'cast', 'attack', 'shoot', 'jump', 'hurt', 'hover', 'charge', 'explode', 'death'] as const)),
    view: Type.Optional(StringEnum(['topdown', 'side', 'three-quarter'] as const)),
    rows: Type.Optional(Type.Integer({ minimum: 1, maximum: HARD_MAX_SPRITE_FRAMES, description: 'Grid rows. Defaults to the configured value (2).' })),
    columns: Type.Optional(Type.Integer({ minimum: 1, maximum: HARD_MAX_SPRITE_FRAMES, description: 'Grid columns. Defaults to the configured value (3).' })),
    frameCount: Type.Optional(Type.Integer({ minimum: 1, maximum: HARD_MAX_SPRITE_FRAMES, description: 'Must exactly equal rows × columns.' })),
    align: Type.Optional(StringEnum(['center', 'bottom', 'feet'] as const, { description: 'Shared alignment anchor. Grounded characters default to feet; effects default to center.' })),
    scaleStrategy: Type.Optional(StringEnum(['fit', 'preserve'] as const, { description: 'fit uses one shared scale for all frames; preserve keeps source scale unless one uniform reduction prevents clipping.' })),
    componentMode: Type.Optional(StringEnum(['largest', 'all'] as const, { description: 'largest favors one main character; all preserves meaningful detached effect components.' })),
    format: Type.Optional(StringEnum(['apng', 'frames'] as const, { description: 'APNG animation or normalized PNG frames only.' })),
    frameDurationMs: Type.Optional(Type.Integer({ minimum: 20, maximum: 10_000 })),
    strictValidation: Type.Optional(Type.Boolean({ description: 'When true, clipping and animation-quality findings prevent APNG approval.' })),
    ...(!aspectRatios && !genericGemini ? { size: Type.Optional(Type.String({ description: 'Provider-supported sheet size. A 2×3 grid prefers 1536x1024 when supported.' })) } : {}),
    ...(aspectRatios || genericGemini ? { aspectRatio: Type.Optional(aspectRatios ? StringEnum(aspectRatios, { description: 'Provider-supported sheet aspect ratio.' }) : Type.String({ description: 'Provider-supported sheet aspect ratio such as "3:2".' })) } : {}),
    ...(imageSizes || genericImageSize ? { imageSize: Type.Optional(imageSizes ? StringEnum(imageSizes, { description: 'Provider-supported output resolution tier.' }) : Type.String({ description: 'Provider-supported output resolution tier such as "2K".' })) } : {}),
    ...(caps.quality ? { quality: Type.Optional(StringEnum(caps.quality, { description: 'Provider-supported quality level.' })) } : {}),
    filename: Type.Optional(Type.String({ description: 'Run-directory name prefix. Existing runs are never overwritten.' })),
    outputDir: Type.Optional(Type.String({ description: 'Sprite output root. Relative paths must remain under the session working directory.' })),
  });
}

export function buildSpriteGuidelines(): string[] {
  return [
    'Use sprite_generate only for one coherent sprite action sheet. Use image_generate for ordinary single images.',
    'Six frames default to a 2-row by 3-column row-major grid. Never request independent n variants for animation frames.',
    'Label reference-image roles and state identity, fixed camera, shared scale/baseline, containment, and true transparency requirements.',
    'A call makes one image-generation request and never retries automatically. If validation rejects the result, show the preserved raw sheet and ask before generating again.',
    'Deterministic validation checks alpha, geometry, clipping, scale, and silhouette motion; the user must still inspect identity, anatomy, costume, and acting.',
  ];
}
