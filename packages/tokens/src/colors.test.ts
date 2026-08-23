import { describe, expect, it } from 'vitest';
import { gam_sRGB, OKLCH_to_XYZ_D65, XYZ_D65_to_lin_sRGB } from '@csstools/color-helpers';
import { colors } from './colors.js';

/**
 * Re-derives every `hex` from its own `oklch` triple and asserts they still
 * agree — see `colors.ts`'s own header for why this, rather than trusting a
 * hand-converted pair, is what makes the values here honest.
 *
 * `OKLCH_to_XYZ_D65` -> `XYZ_D65_to_lin_sRGB` -> `gam_sRGB` is the same
 * pipeline the CSS Color 4 ecosystem's own tooling uses (this package is a
 * transitive dependency of Tailwind v4's own color handling already, so
 * `apps/web` already trusts this exact math to render its own colors).
 * Checked here against five textbook oklch<->sRGB reference points
 * (white, black, and the sRGB primaries) before trusting it against this
 * file's real tokens — a pipeline that gets pure red slightly wrong is not
 * one to derive nineteen production colors from.
 */
function toHex(l: number, c: number, h: number): string {
  const xyz = OKLCH_to_XYZ_D65([l / 100, c, h]);
  const lin = XYZ_D65_to_lin_sRGB(xyz);
  const [r, g, b] = gam_sRGB(lin);
  const clamp = (v: number): number => Math.max(0, Math.min(255, Math.round(v * 255)));
  const hex = (v: number): string => clamp(v).toString(16).padStart(2, '0');
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

describe('the conversion pipeline itself', () => {
  it('reproduces the textbook oklch <-> sRGB reference points', () => {
    expect(toHex(100, 0, 0)).toBe('#ffffff');
    expect(toHex(0, 0, 0)).toBe('#000000');
    expect(toHex(62.8, 0.258, 29.23)).toBe('#ff0000');
    expect(toHex(86.6, 0.295, 142.5)).toBe('#00ff00');
    expect(toHex(45.2, 0.313, 264.05)).toBe('#0000ff');
  });
});

describe('every color token', () => {
  it.each(Object.entries(colors))('%s: hex agrees with its own oklch triple', (_name, token) => {
    const { l, c, h } = token.oklch;
    expect(token.hex).toBe(toHex(l, c, h));
  });
});
