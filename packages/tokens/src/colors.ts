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
export const colors = {
  surface: { oklch: { l: 17.5, c: 0.014, h: 262 }, hex: '#0d1117' },
  surfaceRaised: { oklch: { l: 21, c: 0.016, h: 262 }, hex: '#141820' },
  surfaceSunken: { oklch: { l: 13.5, c: 0.012, h: 262 }, hex: '#06080d' },
  surfaceHover: { oklch: { l: 24, c: 0.016, h: 262 }, hex: '#1b1f27' },

  ink: { oklch: { l: 93, c: 0.008, h: 262 }, hex: '#e5e8ed' },
  inkMuted: { oklch: { l: 66, c: 0.015, h: 262 }, hex: '#8d929c' },
  inkFaint: { oklch: { l: 56, c: 0.014, h: 262 }, hex: '#70757d' },

  line: { oklch: { l: 30, c: 0.012, h: 262 }, hex: '#2b2e34' },
  lineStrong: { oklch: { l: 38, c: 0.014, h: 262 }, hex: '#3e434a' },

  accent: { oklch: { l: 55, c: 0.17, h: 285 }, hex: '#6b5dcf' },
  accentInk: { oklch: { l: 98, c: 0.01, h: 285 }, hex: '#f7f8ff' },
  accentHover: { oklch: { l: 50, c: 0.17, h: 285 }, hex: '#5d4dbe' },

  danger: { oklch: { l: 55, c: 0.19, h: 22 }, hex: '#c92e3b' },
  dangerInk: { oklch: { l: 98, c: 0.01, h: 22 }, hex: '#fff6f5' },
  warning: { oklch: { l: 76, c: 0.15, h: 75 }, hex: '#e8a127' },
  success: { oklch: { l: 70, c: 0.15, h: 155 }, hex: '#3bb974' },

  priorityUrgent: { oklch: { l: 60, c: 0.19, h: 22 }, hex: '#da4149' },
  priorityMedium: { oklch: { l: 60, c: 0.17, h: 285 }, hex: '#796ce0' },

  /**
   * `styles.css`'s own token also carries `/ 60%` alpha, dropped here: a
   * single hex cannot express it, and a modal scrim is exactly where the
   * DIFFERENCE between "opaque dark color" and "60%-transparent dark color"
   * is the entire visual effect. `apps/mobile`'s own overlay usage (once a
   * modal exists to need one, Wave 2+) applies opacity as a separate RN
   * style property alongside this hex, the same way `styles.css`'s alpha is
   * a separate channel from its L/C/H.
   */
  overlay: { oklch: { l: 15, c: 0.02, h: 265 }, hex: '#070b14' },
} as const satisfies Record<string, ColorToken>;

export type ColorName = keyof typeof colors;
