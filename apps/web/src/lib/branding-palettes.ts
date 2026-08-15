import { PALETTE_IDS, type PaletteId } from '@taskflow/contracts';

/**
 * The rendered form of `@taskflow/contracts`' `PALETTE_IDS` — the color
 * values themselves, which only the client ever needs.
 *
 * `default` reproduces `styles.css`'s existing hand-audited accent trio
 * exactly (`oklch(55% 0.17 258)` / `oklch(50% 0.17 258)` / `oklch(98% 0.01
 * 258)`), so a deployment that never touches branding renders pixel-identical
 * to before this feature existed.
 *
 * The other five hold `default`'s LIGHTNESS and CHROMA fixed and vary only
 * HUE. That is not a shortcut — it is the one property OKLCH was designed to
 * have that older color spaces (HSL, sRGB) do not: contrast against a fixed
 * white/black text color is governed almost entirely by lightness, and OKLCH
 * lightness tracks *perceived* brightness consistently across hues, unlike
 * HSL's lightness. Reusing `default`'s audited L/C pair and only rotating H
 * is what makes it safe to ship five more entries without re-deriving the
 * WCAG math from scratch for each one — the tradeoff this file's own header
 * in `apps/api/src/platform-admin/branding.service.ts`'s sibling comment
 * calls out explicitly (a curated set, never a free color picker).
 *
 * That said: this has not been spot-checked against a real contrast-ratio
 * tool for all five non-default hues, only reasoned about from OKLCH's
 * documented properties. Worth a manual check in a running browser before
 * this ships broadly.
 */
export interface PaletteColors {
  readonly base: string;
  readonly hover: string;
  readonly ink: string;
}

const BASE_LIGHTNESS = 55;
const HOVER_LIGHTNESS = 50;
const CHROMA = 0.17;
const INK = 'oklch(98% 0.01 258)';

/** Hue angle for each palette, degrees on the OKLCH hue wheel. */
const HUES: Record<PaletteId, number> = {
  default: 258, // blue — the original, unchanged
  violet: 302,
  green: 152,
  amber: 75,
  rose: 18,
  slate: 258, // same hue as default, near-zero chroma below — a desaturated neutral
};

/** `slate` is the one deliberate exception to "same L/C, different H" — it wants LOW chroma, not a hue shift. */
const CHROMA_OVERRIDE: Partial<Record<PaletteId, number>> = {
  slate: 0.02,
};

export const PALETTES: Record<PaletteId, PaletteColors> = Object.fromEntries(
  PALETTE_IDS.map((id) => {
    const hue = HUES[id];
    const chroma = CHROMA_OVERRIDE[id] ?? CHROMA;
    return [
      id,
      {
        base: `oklch(${String(BASE_LIGHTNESS)}% ${String(chroma)} ${String(hue)})`,
        hover: `oklch(${String(HOVER_LIGHTNESS)}% ${String(chroma)} ${String(hue)})`,
        ink: INK,
      },
    ];
  }),
) as Record<PaletteId, PaletteColors>;

export function paletteColorsOf(paletteId: string): PaletteColors {
  return PALETTES[(paletteId in PALETTES ? paletteId : 'default') as PaletteId];
}
