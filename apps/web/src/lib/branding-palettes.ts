import { PALETTE_IDS, type PaletteId } from '@taskflow/contracts';

/**
 * The rendered form of `@taskflow/contracts`' `PALETTE_IDS` — the color
 * values themselves, which only the client ever needs.
 *
 * `default` reproduces `styles.css`'s existing hand-audited accent trio
 * exactly (`oklch(60% 0.14 88)` / `oklch(55% 0.14 88)` / `oklch(98% 0.02 88)`),
 * so a deployment that never touches branding renders pixel-identical to
 * before this feature existed. This file's `default` entry has to move in
 * lockstep with `styles.css`'s `--color-accent` trio or the branding
 * feature's own "no-op" default silently stops matching the app's real
 * default — see `styles.css`'s own comment on `--color-accent` for the
 * re-verified contrast numbers (§2.4 of ai/design-rebuild-warm-dark.md names
 * exactly what still needs a real contrast-tool pass before these count as
 * final; this file inherits that same caveat).
 *
 * Warm-dark rebuild (ai/design-rebuild-warm-dark.md §2.2): hue AND lightness
 * both moved this time, not hue alone — 285 (violet) -> 88 (a true warm
 * gold), and 55% L -> 60% L (§2.4 re-verification found L=72 gave max
 * 3.66:1 for dark ink, below AA 4.5:1; at L=60, white ink clears 9.69:1).
 * Since all six palettes below share ONE lightness/chroma pair (see the
 * reasoning further down), that lightness move relights every org-selectable
 * option, not just `default` — a real, deliberate product decision (confirmed
 * directly rather than assumed), not a side effect nobody chose. At 60% L,
 * WHITE ink clears 9.69:1 on all six hues.
 *
 * The other five hold `default`'s LIGHTNESS and CHROMA fixed and vary only
 * HUE. That is not a shortcut — it is the one property OKLCH was designed to
 * have that older color spaces (HSL, sRGB) do not: contrast against a fixed
 * ink color is governed almost entirely by lightness, and OKLCH lightness
 * tracks *perceived* brightness consistently across hues, unlike HSL's
 * lightness. Reusing `default`'s audited L/C pair and only rotating H is
 * what makes it safe to ship five more entries without re-deriving the WCAG
 * math from scratch for each one — the tradeoff this file's own header in
 * `apps/api/src/platform-admin/branding.service.ts`'s sibling comment calls
 * out explicitly (a curated set, never a free color picker).
 *
 * Verified for the warm-dark rebuild against the same `@csstools/color-
 * helpers` pipeline `packages/tokens/src/colors.test.ts` trusts: `ink` on
 * this shared L/C=60/0.14 clears 9.69:1 across all six hues (needs
 * 4.5:1 text) — `slate`'s own near-zero chroma (0.02, below) only raises
 * that further. Real margin on every entry, no per-hue nudging needed.
 */
export interface PaletteColors {
  readonly base: string;
  readonly hover: string;
  readonly ink: string;
}

const BASE_LIGHTNESS = 60;
const HOVER_LIGHTNESS = 55;
const CHROMA = 0.14;
/* Nearly achromatic (chroma 0.02) by design — ink is meant to read as "dark
   neutral text," not as a tint of any one palette's hue, so one shared value
   for all six is correct, not a shortcut. Its hue used to be a stale 258,
   left over from BEFORE `default`'s own hue ever moved to 285 and never
   updated when it did — the exact kind of silent drift this rebuild's own
   design doc names as a real, found bug (`packages/tokens/src/palettes.ts`
   has the identical drift on the mobile side). Fixed to 55, the app's own
   new warm-neutral hue (styles.css's --color-ink family), rather than
   perpetuating a value nobody was tracking. Now white (L=98) at the same
   lightness as `colors.ts`'s `accentInk` — dark ink failed contrast on
   the lighter accent. */
const INK = 'oklch(98% 0.02 55)';

/* `default`'s hue, factored out so `slate` (below) can reference it directly
   instead of duplicating the number — the exact mistake that let `INK`'s own
   hue silently go stale for one entire hue change already. A future hue
   change updates this one constant and both entries move together. */
const DEFAULT_HUE = 88;

/** Hue angle for each palette, degrees on the OKLCH hue wheel. */
const HUES: Record<PaletteId, number> = {
  default: DEFAULT_HUE, // warm gold — the app's own default accent (styles.css)
  // 302 (35° from the old default's 258) was fine when default was blue; at
  // 285 it sat only 17° away — close enough that the two swatches were hard
  // to tell apart. Stayed at 320 (magenta-violet) through the warm-dark
  // rebuild: 320 is 128° from the new default's 88, comfortably distinct.
  violet: 320,
  green: 152,
  // Retuned 75 -> 45 for the warm-dark rebuild: 75 sat only 13° from the new
  // default's 88 — true amber and true gold are naturally close hues, and at
  // this app's shared L/C the two swatches would have been hard to tell
  // apart, the identical collision `violet` was already moved once to avoid.
  // 45 (a deeper orange-amber) is 43° from the new default and still reads
  // as "amber," not "gold."
  amber: 45,
  rose: 18,
  slate: DEFAULT_HUE, // same hue as default, near-zero chroma below — a desaturated neutral
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
