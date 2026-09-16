import type { GenerateImageParams, ImageModelCapabilities } from '../types.js';
import type { SpriteGenerateParams, SpritePlan } from './types.js';

const ACTION_PHASES: Record<SpritePlan['action'], string[]> = {
  single: ['the finished still pose'],
  idle: ['settled pose', 'gentle inhale', 'top of breathing motion', 'gentle exhale', 'returning pose', 'loop-ready settled pose'],
  walk: ['left-foot contact', 'first passing pose', 'right-foot contact', 'down/compression pose', 'second passing pose', 'recovery/up pose'],
  run: ['first contact', 'first compression', 'first airborne passing pose', 'opposite contact', 'opposite compression', 'loop-ready airborne recovery'],
  cast: ['ready pose', 'wind-up', 'energy gathering', 'release', 'follow-through', 'return to ready'],
  attack: ['ready pose', 'anticipation', 'attack start', 'impact/extreme', 'follow-through', 'recovery'],
  shoot: ['ready aim', 'draw/charge', 'full aim', 'release', 'recoil', 'return to aim'],
  jump: ['crouch anticipation', 'takeoff', 'rising pose', 'apex', 'falling pose', 'landing compression'],
  hurt: ['neutral lead-in', 'impact reaction', 'maximum recoil', 'recovery start', 'recovery', 'return to neutral'],
  hover: ['lowest hover point', 'rising', 'upper transition', 'highest hover point', 'falling', 'lower transition'],
  charge: ['ready pose', 'energy starts', 'energy builds', 'maximum charge', 'release anticipation', 'loop-ready charged pose'],
  explode: ['initial spark', 'rapid expansion', 'main burst', 'maximum burst', 'dissipation', 'final fading particles'],
  death: ['standing/active pose', 'initial collapse', 'falling', 'ground impact', 'settling', 'final still pose'],
};

export function buildSpritePrompt(params: SpriteGenerateParams, plan: SpritePlan): string {
  const phases = actionPhases(plan.action, plan.frameCount);
  const refs = (params.image ?? []).map((_, index) =>
    `Image ${index + 1}: ${index === 0 ? 'canonical identity, costume, palette, and rendering-style reference' : 'supporting visual reference; preserve compatible identity and geometry only'}.`,
  );
  return [
    `Task: Create one transparent ${plan.rows}-row by ${plan.columns}-column sprite sheet containing exactly ${plan.frameCount} ordered frame${plan.frameCount === 1 ? '' : 's'} of one coherent ${plan.action} action.`,
    `Subject request: ${params.prompt.trim()}`,
    `Asset and camera: ${plan.assetType}; ${plan.view} view; fixed viewing direction and camera distance in every cell.`,
    ...(refs.length ? ['Reference roles:', ...refs] : []),
    `Grid contract: read frames left-to-right across each row, then top-to-bottom. Every cell has equal size. Do not add unused cells.`,
    'Pose contract:',
    ...phases.map((phase, index) => `Frame ${index + 1}: ${phase}.`),
    `Geometry: preserve identity, silhouette, proportions, equipment, palette, rendering style, standing-equivalent scale, body root, and shared baseline. Change only the pose and action effects needed for the ordered motion.`,
    'Containment: keep each pose fully inside the central safe area of its own cell with generous transparent padding. Nothing may touch or cross a cell boundary.',
    'Transparency: the background must be genuinely transparent with usable alpha, not a painted transparency pattern.',
    'Forbidden content: no labels, numbers, text, guides, borders, grid lines, boxes, checkerboard, floor, scenery, cast shadows, or cell separators.',
    `Output: return one image containing exactly this ${plan.rows} by ${plan.columns} sheet and no other content.`,
  ].join('\n\n');
}

export function spriteGenerationControls(
  params: SpriteGenerateParams,
  plan: SpritePlan,
  caps: ImageModelCapabilities | null,
): Pick<GenerateImageParams, 'size' | 'aspectRatio' | 'imageSize' | 'quality' | 'outputFormat' | 'background'> {
  const controls: Pick<GenerateImageParams, 'size' | 'aspectRatio' | 'imageSize' | 'quality' | 'outputFormat' | 'background'> = {};
  if (params.quality) controls.quality = params.quality;
  if (params.size) controls.size = params.size;
  else if (!caps?.aspectRatios && supportsSize(caps, '1536x1024') && plan.columns / plan.rows === 1.5) controls.size = '1536x1024';
  if (params.aspectRatio) controls.aspectRatio = params.aspectRatio;
  else if (caps?.aspectRatios) {
    const exact = ratioString(plan.columns, plan.rows);
    if (caps.aspectRatios.includes(exact)) controls.aspectRatio = exact;
  }
  if (params.imageSize) controls.imageSize = params.imageSize;
  else if ((caps?.imageSizes?.length ?? 0) > 1) {
    const imageSize = caps!.imageSizes!.includes('2K') ? '2K' : caps!.imageSizes!.at(-1);
    if (imageSize) controls.imageSize = imageSize;
  }
  if (caps?.outputFormats?.includes('png')) controls.outputFormat = 'png';
  if (caps?.backgroundValues?.includes('transparent')) controls.background = 'transparent';
  return controls;
}

function actionPhases(action: SpritePlan['action'], count: number): string[] {
  const known = ACTION_PHASES[action];
  if (count === 1) return [known[0] ?? `${action} pose`];
  if (count === known.length) return known;
  return Array.from({ length: count }, (_, index) => {
    const progress = Math.round((index / count) * 100);
    return `${action} phase ${index + 1} at about ${progress}% of the motion, transitioning smoothly to the next frame${index === count - 1 && action !== 'death' ? ' and back to frame 1' : ''}`;
  });
}

function ratioString(width: number, height: number): string {
  const divisor = gcd(width, height);
  return `${width / divisor}:${height / divisor}`;
}

function gcd(a: number, b: number): number {
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

function supportsSize(caps: ImageModelCapabilities | null, size: string): boolean {
  if (!caps) return false;
  if (caps.sizes) return caps.sizes.includes(size);
  if (!caps.sizeRange) return false;
  const match = /^(\d+)x(\d+)$/.exec(size);
  if (!match) return false;
  const width = Number(match[1]);
  const height = Number(match[2]);
  const area = width * height;
  return area >= caps.sizeRange.minArea && area <= caps.sizeRange.maxArea;
}
