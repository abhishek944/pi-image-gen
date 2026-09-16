import type { SpriteGenerateResult } from './types.js';

export function formatSpriteToolResult(result: SpriteGenerateResult, markdownImageUrl: (path: string) => string): string {
  const lines: string[] = result.validation.accepted
    ? [`Generated and validated ${result.frames.length} sprite frame(s) via ${result.provider} (${result.model}).`]
    : ['Generated the sprite sheet, but deterministic animation validation did not approve it. No automatic retry was made.'];
  if (result.animation) lines.push(`Animation: APNG, ${result.animation.frameDurationMs} ms/frame.`);
  if (result.validation.issues.length) {
    lines.push('', 'Validation findings:', ...result.validation.issues.map((issue) => `- ${issue.severity.toUpperCase()} ${issue.code}: ${issue.message}${issue.frameIndexes ? ` Frames: ${issue.frameIndexes.join(', ')}.` : ''}`));
  }
  lines.push('', 'Show the useful artifacts to the user as inline markdown — copy these lines verbatim:', '', `![raw sprite sheet](${markdownImageUrl(result.rawSheet)})`);
  if (result.normalizedSheet) lines.push(`![normalized sprite sheet](${markdownImageUrl(result.normalizedSheet)})`);
  if (result.animation) lines.push(`![sprite animation](${markdownImageUrl(result.animation.path)})`);
  lines.push('', `Run directory: ${result.runDirectory}`);
  if (!result.validation.accepted) lines.push('Inspect identity, anatomy, costume, and motion before requesting an explicit regeneration.');
  return lines.join('\n');
}

export function spriteProgressMessage(phase: string): string {
  const messages: Record<string, string> = {
    planning: 'Planning the sprite grid…',
    'loading-inputs': 'Loading and validating sprite references…',
    'generating-sheet': 'Waiting for one coherent sprite sheet…',
    'saving-raw-sheet': 'Saving the raw sprite sheet…',
    'decoding-sheet': 'Decoding the sprite sheet…',
    'extracting-frames': 'Extracting ordered sprite frames…',
    'normalizing-frames': 'Applying shared scale and alignment…',
    'validating-animation': 'Validating sprite geometry and motion…',
    'encoding-animation': 'Encoding the APNG animation…',
    'saving-output': 'Saving sprite outputs…',
  };
  return messages[phase] ?? 'Processing sprite output…';
}
