/**
 * The typography tokens (design bible §02), shared with a platform that
 * cannot read them from `apps/web/src/styles.css` — the identical
 * "authored there, copied here, kept in sync by hand" arrangement
 * `colors.ts` documents for the color ramp.
 *
 * Geist is the app's own face on BOTH platforms now. `apps/web` self-hosts
 * the two variable-weight files from `public/fonts/`; `apps/mobile` loads
 * the SAME two files (copied to this package's `assets/fonts/`, so one
 * directory serves both consumers and neither platform can pick up a
 * different revision of the face) through `expo-font` at boot
 * (`apps/mobile/app/_layout.tsx`). Until that load resolves the family
 * names below are simply absent from the OS and React Native falls back to
 * the platform default — the pre-Geist look — which is why the layout
 * keeps its splash up until `useFonts` settles.
 *
 * ## Why a scale, not free-form sizes
 *
 * `scripts/check-typography.mjs` enforces exactly this set for every
 * numeric `fontSize:` literal under `apps/mobile` — a size that is not on
 * the scale fails the run. Use one of these tokens (or the raw numbers
 * behind them) rather than inventing an eleventh size: weight, not size,
 * carries hierarchy, and a scale that grows by exception is the 700-size
 * sprawl the bible's §21 ledger started with.
 */

/** Geist Sans — body copy and headings alike (`styles.css`'s `--font-sans`). */
export const fontSans = 'Geist';

/** Geist Mono — card references, timestamps, ids (`styles.css`'s `--font-mono`). */
export const fontMono = 'Geist Mono';

/**
 * The mobile type scale — the set `scripts/check-typography.mjs`'s
 * `MOBILE_SCALE` enforces for every numeric `fontSize:` literal under
 * `apps/mobile` (keep the two in sync by hand, like every other
 * cross-platform literal). 12 is the floor the typography pass set for
 * anything a person reads by scanning, so there is deliberately no 11px
 * micro-label rung on mobile.
 *
 *   xs     ·  12 — metadata, badges, dense cells
 *   sm     ·  13 — secondary body, list metadata
 *   body   ·  14 — body copy, list rows, buttons
 *   base   ·  15 — emphasized body, section headings
 *   lg     ·  18 — screen titles on dense screens
 *   xl     ·  20 — screen titles (`ScreenHeader`)
 *   2xl    ·  24 — hero numerals, empty-state titles
 */
export const typeScale = {
  xs: 12,
  sm: 13,
  body: 14,
  base: 15,
  lg: 18,
  xl: 20,
  '2xl': 24,
} as const;

export type TypeScaleName = keyof typeof typeScale;
