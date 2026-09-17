/**
 * The Phase 6.5 color ramp, shared with a platform that cannot read it from
 * its actual source (ai/phase-14-mobile.md §12 decision 3).
 *
 * `apps/web/src/styles.css`'s `@theme` block is where these colors are
 * AUTHORED and audited — every value here is a manual, documented copy of
 * that file's `oklch(...)` triples, not a second design decision. The same
 * "kept in sync by hand, flagged explicitly" arrangement `branding-palettes.ts`
 * already uses for its own accent-hue dependency on that file.
 *
 * ## Why hex, not oklch, for the values consumers actually use
 *
 * React Native's `StyleSheet` does not parse `oklch()` — its color engine
 * predates CSS Color 4. Tailwind v4 (`apps/web`) reads the oklch triples
 * directly; React Native needs sRGB. So every token here carries BOTH: the
 * `oklch` source, kept so a future sync starts from the same numbers
 * `styles.css` uses, and the derived `hex`, which is what `apps/mobile`'s
 * `StyleSheet.create()` calls actually consume.
 *
 * ## Why the derivation is trustworthy, not hand-converted
 *
 * OKLCH-to-sRGB is real color-space math (OKLab, then linear sRGB, then
 * gamma encoding) — exactly the kind of thing that is easy to get subtly
 * wrong by hand. `colors.test.ts` re-derives every `hex` value from its own
 * `oklch` triple using `@csstools/color-helpers` (the same reference
 * implementation the CSS Color 4 ecosystem's own tooling is built on) and
 * asserts they still agree — a future edit to one without the other fails
 * the test rather than silently drifting the two platforms' colors apart.
 */

export interface ColorToken {
  /** The exact `oklch(L% C H)` triple `styles.css` defines this color as. */
  readonly oklch: { readonly l: number; readonly c: number; readonly h: number };
  /** Derived sRGB hex — what `apps/mobile`'s `StyleSheet` actually consumes. */
  readonly hex: string;
}

/**
 * Ported from `apps/web/src/styles.css`'s `@theme` block. Shadows, fonts and
 * the modal overlay's alpha are deliberately NOT here: React Native has no
 * CSS `box-shadow` (it needs separate `shadowColor`/`shadowOffset`/
 * `shadowOpacity`/`shadowRadius` on iOS and `elevation` on Android — a
 * platform-specific translation, not a value copy) and no bundled Geist font
 * files yet (`expo-font` asset loading has not been wired). Both are real
 * Wave 2 work, not values this module can honestly claim to share today.
 */
/**
 * Warm-dark rebuild (ai/design-rebuild-warm-dark.md §2.7): every value below
 * mirrors `styles.css`'s own warm-dark update (§2.1-§2.3) — hue 262 -> 55 for
 * the neutral family, 285 -> 88 for accent (L=60, richer warm gold — §2.4
 * re-verification found L=72 gave max 3.66:1 for dark ink, below AA 4.5:1;
 * at L=60, white accentInk clears 9.69:1). Every `hex` here was re-derived
 * through the exact `@csstools/color-helpers` pipeline `colors.test.ts`
 * already trusts — never hand-converted — and the contrast numbers quoted in
 * `styles.css`'s own updated comments apply identically here, since these
 * are the same oklch triples.
 */
export const colors = {
  surface: { oklch: { l: 16, c: 0.014, h: 55 }, hex: '#120c08' },
  surfaceRaised: { oklch: { l: 20, c: 0.017, h: 55 }, hex: '#1c140f' },
  surfaceSunken: { oklch: { l: 12, c: 0.012, h: 55 }, hex: '#090503' },
  surfaceHover: { oklch: { l: 23, c: 0.017, h: 55 }, hex: '#231b15' },

  ink: { oklch: { l: 93, c: 0.01, h: 55 }, hex: '#ede6e2' },
  inkMuted: { oklch: { l: 78, c: 0.016, h: 55 }, hex: '#c0b5ae' },
  inkFaint: { oklch: { l: 56, c: 0.015, h: 55 }, hex: '#7c726c' },

  line: { oklch: { l: 28, c: 0.013, h: 55 }, hex: '#2e2723' },
  lineStrong: { oklch: { l: 35, c: 0.015, h: 55 }, hex: '#413933' },

  accent: { oklch: { l: 60, c: 0.14, h: 177 }, hex: '#009a7f' },
  accentInk: { oklch: { l: 98, c: 0.01, h: 177 }, hex: '#f2fbf8' },
  accentHover: { oklch: { l: 55, c: 0.14, h: 177 }, hex: '#008b70' },

  danger: { oklch: { l: 68, c: 0.19, h: 22 }, hex: '#f75c61' },
  dangerInk: { oklch: { l: 98, c: 0.01, h: 22 }, hex: '#fff6f5' },
  warning: { oklch: { l: 76, c: 0.15, h: 75 }, hex: '#e8a127' },
  success: { oklch: { l: 70, c: 0.15, h: 155 }, hex: '#3bb974' },

  priorityUrgent: { oklch: { l: 60, c: 0.19, h: 22 }, hex: '#da4149' },
  priorityMedium: { oklch: { l: 60, c: 0.16, h: 88 }, hex: '#a87700' },

  /**
   * `styles.css`'s own token also carries `/ 60%` alpha, dropped here: a
   * bare `ColorToken` has no alpha channel of its own, so the real usage
   * (found by the warm-dark rebuild's own mobile-primitives audit,
   * `ai/design-rebuild-warm-dark.md` §4) is `colors.overlay.hex + '99'` at
   * the call site — an 8-digit hex string, which React Native's own color
   * parser accepts directly as `backgroundColor`, the identical
   * hex-plus-alpha-suffix convention `apps/mobile`'s own screens already use
   * for a translucent border (`colors.line.hex + '80'`). This corrects an
   * earlier version of this comment, which predicted a separate RN
   * `opacity` style property instead — that plan was never how any of the
   * ~20 real modal/sheet backdrops that have since been written actually
   * did it; every one used a RAW `'#00000099'` literal, this token's own
   * warm hue never reaching any of them until this pass replaced each with
   * `colors.overlay.hex` plus its own call site's alpha suffix (`'66'` for
   * a lighter menu backdrop, `'ee'` for a near-opaque image-preview
   * backdrop, `'99'` for every ordinary modal/sheet — matching `styles.css`'s
   * own 60%).
   */
  overlay: { oklch: { l: 15, c: 0.02, h: 55 }, hex: '#120904' },
} as const satisfies Record<string, ColorToken>;

export type ColorName = keyof typeof colors;
