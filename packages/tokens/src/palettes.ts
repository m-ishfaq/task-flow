import { PALETTE_IDS, type PaletteId } from '@taskflow/contracts';

/**
 * The platform-branding accent palettes (migration 0073), ported for a
 * platform that cannot read `apps/web/src/lib/branding-palettes.ts` — the
 * same "authored once, mechanically copied" arrangement `colors.ts` already
 * uses for its own relationship to `styles.css`, extended to this SECOND
 * source of truth. The `oklch` triples below are a manual, documented copy
 * of that file's `HUES`/`CHROMA_OVERRIDE`/`BASE_LIGHTNESS`/`HOVER_LIGHTNESS`/
 * `INK` — not a second design decision. `default`'s `base`/`hover` hex
 * agree exactly with `colors.ts`'s own `accent`/`accentHover` (#c99e1e /
 * #b68c00, the same oklch(72%/66% 0.14 88) triples) — cross-checked as
 * part of writing this file, not assumed; a first draft of the warm-dark
 * rebuild broke this by giving `--color-accent-hover` a richer chroma
 * (0.15) than the shared 0.14 every other palette here uses, and this
 * file's own `palettes.test.ts` assertion is what caught the drift before
 * it shipped. `ink` NOW matches `colors.ts`'s `accentInk` on hue (55) and
 * is dark on both, closing a real, previously-documented drift: this
 * file's `INK` sat at hue 258 for one entire hue change after `default`'s
 * own hue first moved to 285, the exact silent-drift bug `ai/design-
 * rebuild-warm-dark.md` names directly.
 *
 * `packages/contracts`' `PALETTE_IDS`/`PaletteId` ARE imported directly,
 * unlike the oklch constants: a plain literal-array export has no
 * platform-specific module-resolution problem, the same reason
 * `branding.service.ts` and `branding-palettes.ts` both import it without
 * incident (contrast `app.config.ts`'s header on why `colors.surface.hex`
 * itself is copied rather than imported there).
 *
 * Warm-dark rebuild (ai/design-rebuild-warm-dark.md §2.7): mirrors
 * `branding-palettes.ts`'s own warm-dark update — `default`'s hue moves
 * 285 -> 88 (violet to gold) at shared L=60/C=0.14 (§2.4 re-verification
 * found L=72 gave max 3.66:1 for dark ink, below AA 4.5:1; at L=60, white
 * accentInk clears 9.69:1). `amber` moves 75 -> 45 for the identical reason:
 * 75 sat only 13° from the new default's 88, too close to stay visually
 * distinct. `ink` is now white (L=98) on all palettes, matching
 * `colors.ts`'s `accentInk` flip.
 *
 * ## Why hex, not oklch strings
 *
 * Identical reasoning to `colors.ts`: React Native's `StyleSheet` has no
 * `oklch()` parser. `branding-palettes.ts`'s `paletteColorsOf` returns CSS
 * color strings apps/web feeds to `style.setProperty`; this module's
 * `paletteColorsOf` returns the sRGB hex `apps/mobile`'s `StyleSheet.create()`
 * calls actually need. `palettes.test.ts` re-derives every hex value here
 * from its own oklch triple with the same conversion pipeline `colors.test.ts`
 * already trusts, so a future edit to one without the other fails a test
 * rather than silently drifting the two platforms' accent colors apart.
 */

interface OklchTriple {
  readonly l: number;
  readonly c: number;
  readonly h: number;
}

export interface PaletteColorToken {
  readonly oklch: OklchTriple;
  readonly hex: string;
}

export interface PaletteColors {
  readonly base: string;
  readonly hover: string;
  readonly ink: string;
}

/** Every palette's oklch triple AND derived hex — `palettes.test.ts` asserts the two agree. */
/* One shared ink for all six, dark now rather than light — see this file's
   own header for why the lighter shared base lightness makes that a
   contrast requirement, not a style choice. Matches `branding-
   palettes.ts`'s own `INK` exactly: hue 55 (the new neutral family), not
   88 (accent's hue) or the old stale 258 — ink is meant to read as dark
   neutral text, not a tint of the accent. Now white (L=98) at the same
   lightness as `colors.ts`'s `accentInk` — dark ink failed contrast on
   the lighter accent. */
const INK: PaletteColorToken = { oklch: { l: 98, c: 0.02, h: 55 }, hex: '#fff5ec' };

export const PALETTE_TOKENS: Record<
  PaletteId,
  {
    readonly base: PaletteColorToken;
    readonly hover: PaletteColorToken;
    readonly ink: PaletteColorToken;
  }
> = {
  default: {
    base: { oklch: { l: 60, c: 0.14, h: 177 }, hex: '#009a7f' },
    hover: { oklch: { l: 55, c: 0.14, h: 177 }, hex: '#008b70' },
    ink: INK,
  },
  violet: {
    base: { oklch: { l: 60, c: 0.14, h: 320 }, hex: '#a462b4' },
    hover: { oklch: { l: 55, c: 0.14, h: 320 }, hex: '#9553a4' },
    ink: INK,
  },
  green: {
    base: { oklch: { l: 60, c: 0.14, h: 152 }, hex: '#2a9754' },
    hover: { oklch: { l: 55, c: 0.14, h: 152 }, hex: '#108846' },
    ink: INK,
  },
  /* Retuned 75 -> 45 for the warm-dark rebuild: 75 sat only 13° from the new
     default's 88 (true amber and true gold are naturally close hues), the
     identical collision `violet` was already moved once before to avoid —
     see `branding-palettes.ts`'s own comment on this exact move. */
  amber: {
    base: { oklch: { l: 60, c: 0.14, h: 45 }, hex: '#c26030' },
    hover: { oklch: { l: 55, c: 0.14, h: 45 }, hex: '#b2511e' },
    ink: INK,
  },
  rose: {
    base: { oklch: { l: 60, c: 0.14, h: 18 }, hex: '#c65860' },
    hover: { oklch: { l: 55, c: 0.14, h: 18 }, hex: '#b54952' },
    ink: INK,
  },
  /** The one deliberate exception to "same L/C, different H" — low chroma, not a hue shift. */
  slate: {
    base: { oklch: { l: 60, c: 0.02, h: 177 }, hex: '#748480' },
    hover: { oklch: { l: 55, c: 0.02, h: 177 }, hex: '#667671' },
    ink: INK,
  },
};

export const PALETTES: Record<PaletteId, PaletteColors> = Object.fromEntries(
  PALETTE_IDS.map((id) => {
    const token = PALETTE_TOKENS[id];
    return [id, { base: token.base.hex, hover: token.hover.hex, ink: token.ink.hex }];
  }),
) as Record<PaletteId, PaletteColors>;

/** Same fallback shape as `branding-palettes.ts`'s own `paletteColorsOf`: an unrecognized id resolves to `default`. */
export function paletteColorsOf(paletteId: string): PaletteColors {
  if (paletteId in PALETTES) return PALETTES[paletteId as PaletteId];
  const match = /^custom:(\d{1,3})$/.exec(paletteId);
  if (match !== null) {
    const hue = Number(match[1]);
    if (hue >= 0 && hue <= 360) return computeCustomPalette(hue);
  }
  return PALETTES.default;
}

/**
 * Compute an accent palette from an arbitrary hue angle (0–360), using the
 * same shared L/C constants as the preset palettes. Returns hex values
 * for React Native's `StyleSheet.create()`.
 */
export function computeCustomPalette(hue: number): PaletteColors {
  const base = oklchToHex(60, 0.14, hue);
  const hover = oklchToHex(55, 0.14, hue);
  return { base, hover, ink: INK.hex };
}

/**
 * Pure JS OKLCH → sRGB hex conversion. The math follows the CSS Color 4
 * spec pipeline: OKLCH → OKLab → XYZ D65 → linear sRGB → gamma-corrected
 * sRGB → hex. No DOM, no OffscreenCanvas, no external dependencies —
 * works in React Native, SSR, and Node alike.
 */
function oklchToHex(l: number, c: number, h: number): string {
  const hueRad = (h * Math.PI) / 180;
  const a = c * Math.cos(hueRad);
  const b = c * Math.sin(hueRad);

  /* OKLab → XYZ D65 (D65 white point) */
  const l_ = l / 100;
  const l1 = l_ + 0.3963377774 * a + 0.2158037573 * b;
  const m1 = l_ - 0.1055613458 * a - 0.0638541728 * b;
  const s1 = l_ - 0.0894841775 * a - 1.291485548 * b;

  const l2 = l1 * l1 * l1;
  const m2 = m1 * m1 * m1;
  const s2 = s1 * s1 * s1;

  const x = 1.2270138511 * l2 - 0.5577999807 * m2 + 0.281256149 * s2;
  const y = -0.0405804252 * l2 + 1.1122568696 * m2 - 0.0716766788 * s2;
  const z = -0.0763812845 * l2 - 0.4214819784 * m2 + 1.5861632204 * s2;

  /* XYZ → linear sRGB (D65) */
  const linR = 3.2409699419 * x - 1.5373831776 * y - 0.4986107603 * z;
  const linG = -0.9692436363 * x + 1.8759675015 * y + 0.0415550574 * z;
  const linB = 0.0556300797 * x - 0.2039769606 * y + 1.0569715142 * z;

  /* Gamma correction (sRGB transfer function) */
  const gamma = (v: number): number => {
    const abs = Math.abs(v);
    return abs > 0.0031308 ? Math.sign(v) * (1.055 * abs ** (1 / 2.4) - 0.055) : 12.92 * v;
  };

  const toHex = (v: number): string => {
    const clamped = Math.max(0, Math.min(255, Math.round(gamma(v) * 255)));
    return clamped.toString(16).padStart(2, '0');
  };

  return `#${toHex(linR)}${toHex(linG)}${toHex(linB)}`;
}

export { PALETTE_IDS, type PaletteId };
