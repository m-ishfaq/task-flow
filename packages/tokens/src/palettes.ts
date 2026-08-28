import { PALETTE_IDS, type PaletteId } from '@taskflow/contracts';

/**
 * The platform-branding accent palettes (migration 0073), ported for a
 * platform that cannot read `apps/web/src/lib/branding-palettes.ts` — the
 * same "authored once, mechanically copied" arrangement `colors.ts` already
 * uses for its own relationship to `styles.css`, extended to this SECOND
 * source of truth. The `oklch` triples below are a manual, documented copy
 * of that file's `HUES`/`CHROMA_OVERRIDE`/`BASE_LIGHTNESS`/`HOVER_LIGHTNESS`/
 * `INK` — not a second design decision. `default`'s `base`/`hover` hex agree
 * exactly with `colors.ts`'s own `accent`/`accentHover` (both #6b5dcf /
 * #5d4dbe) — the same oklch(55%/50% 0.17 285) triple, cross-checked as part
 * of writing this file, not assumed. `ink` does NOT match `colors.ts`'s
 * `accentInk`: `branding-palettes.ts`'s own `INK` constant stays at hue 258
 * (a comment there notes the accent hue moved to 285 in a later redesign
 * pass without a matching move here) — copied faithfully as web's actual
 * current source, not silently reconciled with the unrelated static token.
 *
 * `packages/contracts`' `PALETTE_IDS`/`PaletteId` ARE imported directly,
 * unlike the oklch constants: a plain literal-array export has no
 * platform-specific module-resolution problem, the same reason
 * `branding.service.ts` and `branding-palettes.ts` both import it without
 * incident (contrast `app.config.ts`'s header on why `colors.surface.hex`
 * itself is copied rather than imported there).
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
export const PALETTE_TOKENS: Record<
  PaletteId,
  { readonly base: PaletteColorToken; readonly hover: PaletteColorToken; readonly ink: PaletteColorToken }
> = {
  default: {
    base: { oklch: { l: 55, c: 0.17, h: 285 }, hex: '#6b5dcf' },
    hover: { oklch: { l: 50, c: 0.17, h: 285 }, hex: '#5d4dbe' },
    ink: { oklch: { l: 98, c: 0.01, h: 258 }, hex: '#f4f9ff' },
  },
  violet: {
    base: { oklch: { l: 55, c: 0.17, h: 320 }, hex: '#9b49ae' },
    hover: { oklch: { l: 50, c: 0.17, h: 320 }, hex: '#8c399e' },
    ink: { oklch: { l: 98, c: 0.01, h: 258 }, hex: '#f4f9ff' },
  },
  green: {
    base: { oklch: { l: 55, c: 0.17, h: 152 }, hex: '#008c3a' },
    hover: { oklch: { l: 50, c: 0.17, h: 152 }, hex: '#007c2b' },
    ink: { oklch: { l: 98, c: 0.01, h: 258 }, hex: '#f4f9ff' },
  },
  amber: {
    base: { oklch: { l: 55, c: 0.17, h: 75 }, hex: '#a95d00' },
    hover: { oklch: { l: 50, c: 0.17, h: 75 }, hex: '#994e00' },
    ink: { oklch: { l: 98, c: 0.01, h: 258 }, hex: '#f4f9ff' },
  },
  rose: {
    base: { oklch: { l: 55, c: 0.17, h: 18 }, hex: '#c03a4a' },
    hover: { oklch: { l: 50, c: 0.17, h: 18 }, hex: '#af283d' },
    ink: { oklch: { l: 98, c: 0.01, h: 258 }, hex: '#f4f9ff' },
  },
  /** The one deliberate exception to "same L/C, different H" — low chroma, not a hue shift. */
  slate: {
    base: { oklch: { l: 55, c: 0.02, h: 285 }, hex: '#70707d' },
    hover: { oklch: { l: 50, c: 0.02, h: 285 }, hex: '#62626f' },
    ink: { oklch: { l: 98, c: 0.01, h: 258 }, hex: '#f4f9ff' },
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
  return PALETTES[(paletteId in PALETTES ? paletteId : 'default') as PaletteId];
}

export { PALETTE_IDS, type PaletteId };
