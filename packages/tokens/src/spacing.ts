/**
 * Non-color tokens ported from `apps/web/src/styles.css`'s `@theme` block —
 * see `colors.ts`'s own header for the "kept in sync by hand" arrangement
 * this shares.
 *
 * `--motion-ease`'s cubic-bezier and `--radius-card`'s rem value both
 * translate directly: React Native's `Easing.bezier(x1, y1, x2, y2)` takes
 * the identical four control points CSS does, and RN treats a plain number
 * as density-independent pixels the same way a rem (at the browser's
 * unchanged default 16px root) does — no unit conversion either.
 */

/** `--radius-card: 0.625rem` at the standard 16px root. */
export const radiusCard = 10;

export const motion = {
  /** `--motion-fast`, in ms. */
  fast: 120,
  /** `--motion-base`, in ms. */
  base: 200,
  /** `--motion-ease`. Feed straight into `Easing.bezier(...spread)` on native. */
  ease: [0.16, 1, 0.3, 1] as const,
};
