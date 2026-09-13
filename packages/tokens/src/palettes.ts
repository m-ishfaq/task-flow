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
 * 285 -> 88 (violet to gold) at a higher shared lightness (55% -> 72%),
 * which relights all six palettes since they share one L/C pair by design
 * (see that file's header for why — the project owner confirmed directly
 * that this should apply to all six, not just `default`). `amber` moves
 * 75 -> 45 for the identical reason it does there: 75 sat only 13° from
 * the new default's 88, too close to stay visually distinct. `ink` was
 * ALSO fixed here, not just carried forward stale: the old value (hue
 * 258, light 98%) was already a documented drift from `branding-
 * palettes.ts`'s own then-current hue, and at the new 72% shared
 * lightness, a LIGHT ink fails contrast outright regardless — it has to
 * be dark now, the same requirement driving `colors.ts`'s `accentInk`
 * flip.
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
   neutral text, not a tint of the accent. */
const INK: PaletteColorToken = { oklch: { l: 16, c: 0.02, h: 55 }, hex: '#140b06' };

export const PALETTE_TOKENS: Record<
  PaletteId,
  {
    readonly base: PaletteColorToken;
    readonly hover: PaletteColorToken;
    readonly ink: PaletteColorToken;
  }
> = {
  default: {
    base: { oklch: { l: 72, c: 0.14, h: 88 }, hex: '#c99e1e' },
    hover: { oklch: { l: 66, c: 0.14, h: 88 }, hex: '#b68c00' },
    ink: INK,
  },
  violet: {
    base: { oklch: { l: 72, c: 0.14, h: 320 }, hex: '#cb86db' },
    hover: { oklch: { l: 66, c: 0.14, h: 320 }, hex: '#b774c7' },
    ink: INK,
  },
  green: {
    base: { oklch: { l: 72, c: 0.14, h: 152 }, hex: '#56bd78' },
    hover: { oklch: { l: 66, c: 0.14, h: 152 }, hex: '#41aa66' },
    ink: INK,
  },
  /* Retuned 75 -> 45 for the warm-dark rebuild: 75 sat only 13° from the new
     default's 88 (true amber and true gold are naturally close hues), the
     identical collision `violet` was already moved once before to avoid —
     see `branding-palettes.ts`'s own comment on this exact move. */
  amber: {
    base: { oklch: { l: 72, c: 0.14, h: 45 }, hex: '#eb8656' },
    hover: { oklch: { l: 66, c: 0.14, h: 45 }, hex: '#d77343' },
    ink: INK,
  },
  rose: {
    base: { oklch: { l: 72, c: 0.14, h: 18 }, hex: '#ef7d83' },
    hover: { oklch: { l: 66, c: 0.14, h: 18 }, hex: '#da6b71' },
    ink: INK,
  },
  /** The one deliberate exception to "same L/C, different H" — low chroma, not a hue shift. */
  slate: {
    base: { oklch: { l: 72, c: 0.02, h: 88 }, hex: '#aaa497' },
    hover: { oklch: { l: 66, c: 0.02, h: 88 }, hex: '#979285' },
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
  return PALETTES[(paletteId in PALETTES ? paletteId : 'default') as PaletteId];
}

export { PALETTE_IDS, type PaletteId };
