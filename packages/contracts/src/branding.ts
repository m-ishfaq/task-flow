/**
 * The closed set of accent-color palette ids a deployment's branding may
 * name (migration 0073).
 *
 * Ids only, never the color values themselves. `apps/web/src/styles.css`'s
 * accent trio (`--color-accent` / `--color-accent-hover` / `--color-accent-ink`)
 * is a set of independently hand-audited OKLCH values chosen to clear
 * specific WCAG contrast ratios against white/black text — not a formula one
 * base color can be run through safely. So an operator picks a palette BY
 * NAME, and the actual `{ base, hover, ink }` triples live in
 * `apps/web/src/lib/branding-palettes.ts`, the one place anything needs to
 * render a color. This list exists only so the API can validate a
 * `paletteId` the same closed way `FLAG_NAMES` validates a flag name — it
 * has no rendering concern of its own.
 *
 * Adding a palette means adding it here AND to the web-side color table;
 * nothing enforces the two stay in sync beyond this comment, the same as
 * every other cross-package vocabulary in this file.
 */
/**
 * The single source of truth for the default product name — change here only.
 * Imported by `@taskflow/security` (webhook header fallback) and
 * `@taskflow/api` (branding cache default).
 */
export const DEFAULT_PRODUCT_NAME = 'Rinavai';

export const PALETTE_IDS = ['default', 'violet', 'green', 'amber', 'rose', 'slate'] as const;

export type PaletteId = (typeof PALETTE_IDS)[number];
