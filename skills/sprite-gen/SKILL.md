---
name: sprite-gen
description: "Generate one coherent sprite action sheet with the optional sprite_generate tool, then use its normalized PNG frames and APNG output."
---

# Sprite generation

Use `sprite_generate` for an ordered animation made from one coherent generated sheet. Use `image_generate` for ordinary single images.

## Availability

Call `sprite_generate` only when it is active. If it is unavailable, tell the user to set:

```json
{
  "pi-image-gen": {
    "spriteGeneration": { "enabled": true }
  }
}
```

Then ask them to run `/image-gen reload`. Do not imitate the disabled tool with several `image_generate` calls, and do not make a paid call just to test availability.

## One action per call

- Request one character, prop, projectile, or effect performing one action.
- Six frames default to a 2-row × 3-column grid in row-major order: left-to-right, then top-to-bottom.
- Do not request `n` variants. The tool intentionally makes one image request so all cells share visual context.
- The active provider and model come from `pi-image-gen.defaultProvider` and `pi-image-gen.defaultModel`. There is no per-call model parameter.

## Prompt checklist

State only details relevant to the requested asset:

1. Identity, costume, palette, proportions, equipment, and rendering style.
2. One action and, when needed, the desired phase progression.
3. `topdown`, `side`, or `three-quarter` view with fixed direction and camera distance.
4. Shared scale, body root, and baseline across cells.
5. Full containment inside each cell with transparent padding.
6. True alpha transparency. No checkerboard or painted background.
7. No labels, numbers, guides, borders, grid lines, floor, scenery, or cast shadows.

For references, label each role: `Image 1: canonical identity and costume`, `Image 2: scale and baseline`, and so on. Do not reduce a usable visual reference to prose.

## Parameters

- `assetType` and `action` select sensible prompting and alignment defaults.
- `rows`, `columns`, and `frameCount` must agree exactly. Unused cells are not supported.
- `align: "feet"` suits grounded characters; `center` suits floating effects and projectiles.
- `scaleStrategy: "fit"` computes one shared scale. `preserve` keeps source scale unless one uniform safety reduction is needed.
- `componentMode: "largest"` favors a main character. `all` preserves meaningful detached effect parts.
- `format: "apng"` writes an animation after validation. `frames` writes only normalized PNG assets.
- `strictValidation: true` blocks animation approval for clipping and serious motion findings.
- Model-aware `size`, `aspectRatio`, `imageSize`, and `quality` appear only when supported.

## Results and retries

The tool always makes at most one provider generation request and never regenerates automatically. If deterministic checks reject a generated sheet, report the issue codes, show the preserved raw sheet using the tool's returned Markdown, and ask before making another paid request.

Local checks cover frame count, alpha, clipping, shared scale, anchors, duplicate silhouettes, motion spikes, and loop closure. They cannot prove facial identity, costume accuracy, anatomy, or acting quality. Ask the user to inspect those details.

Render useful returned artifacts inline by copying the exact Markdown lines from the tool result. Also report the run directory, which contains the prompt, raw sheet, normalized sheet, frames, animation when approved, and metadata.
