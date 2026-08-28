import { describe, expect, it } from 'vitest';
import { gam_sRGB, OKLCH_to_XYZ_D65, XYZ_D65_to_lin_sRGB } from '@csstools/color-helpers';
import { PALETTE_TOKENS } from './palettes.js';

/**
 * Re-derives every palette's `hex` from its own `oklch` triple — see
 * `colors.test.ts`'s own header for why this pipeline is trusted, and
 * `palettes.ts`'s header for why this file exists as a sibling rather than
 * folding these tokens into `colors.ts` itself.
 */
function toHex(l: number, c: number, h: number): string {
  const xyz = OKLCH_to_XYZ_D65([l / 100, c, h]);
  const lin = XYZ_D65_to_lin_sRGB(xyz);
  const [r, g, b] = gam_sRGB(lin);
  const clamp = (v: number): number => Math.max(0, Math.min(255, Math.round(v * 255)));
  const hex = (v: number): string => clamp(v).toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

describe('every palette token', () => {
  const cases = Object.entries(PALETTE_TOKENS).flatMap(([paletteId, shades]) =>
    Object.entries(shades).map(([shade, token]) => [`${paletteId}.${shade}`, token] as const),
  );

  it.each(cases)('%s: hex agrees with its own oklch triple', (_name, token) => {
    const { l, c, h } = token.oklch;
    expect(token.hex).toBe(toHex(l, c, h));
  });
});

describe("the default palette's base/hover", () => {
  it("matches colors.ts's own accent/accentHover exactly", async () => {
    // Cross-check named in palettes.ts's own header: both files independently
    // author oklch(55%/50% 0.17 285) for the app's default accent, and must
    // keep agreeing or one of them drifted.
    const { colors } = await import('./colors.js');
    expect(PALETTE_TOKENS.default.base.hex).toBe(colors.accent.hex);
    expect(PALETTE_TOKENS.default.hover.hex).toBe(colors.accentHover.hex);
  });
});
