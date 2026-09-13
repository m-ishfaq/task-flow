import type { Priority } from './api.js';

/**
 * The priority color system (UI/UX redesign, Phase C) — the single place
 * every surface that shows a priority (`card-tile.tsx`'s edge bar,
 * `list-view.tsx`/`table-view.tsx`'s rows, `status-priority-section.tsx`'s
 * picker preview) reads from, so the four colors and their order can never
 * drift between surfaces the way four independent inline maps would.
 *
 * `high` and `low` reuse `--color-warning`/`--color-ink-faint` outright —
 * both already clear 3:1 against every surface tone with real margin.
 * `urgent` and `medium` are their OWN tokens (`--color-priority-urgent`,
 * `--color-priority-medium`), not `--color-danger`/`--color-accent` — see
 * `styles.css`'s own comment on `--color-priority-urgent` for the Phase E
 * audit that found the direct reuse failing 3:1 against `surface-hover`
 * (this file's own first-pass choice, corrected there) and the exact
 * numbers behind the fix. These are NON-TEXT swatch classes (`bg-*`) only:
 * pair with neutral `text-ink`/`text-ink-muted` for the label, never render
 * the swatch color as the label's own text color.
 */

export const PRIORITIES: readonly Priority[] = ['urgent', 'high', 'normal', 'low'];

export const PRIORITY_LABEL: Readonly<Record<Priority, string>> = {
  urgent: 'Urgent',
  high: 'High',
  normal: 'Normal',
  low: 'Low',
};

export const PRIORITY_SWATCH: Readonly<Record<Priority, string>> = {
  urgent: 'bg-priority-urgent',
  high: 'bg-warning',
  normal: 'bg-priority-medium',
  low: 'bg-ink-faint',
};

/**
 * A light TINT of each swatch, for a pill-style background rather than the
 * solid dot/bar `PRIORITY_SWATCH` is for (`card-tile.tsx`'s edge bar,
 * `list-view.tsx`'s row pill). `status-priority-section.tsx`'s own priority
 * picker is the first caller — its old plain white `<select>` with only a
 * tiny preview dot read as a form field, not the colored pill every other
 * priority surface in this app already is. Still governed by this file's
 * own rule above: pair with neutral `text-ink`, never the priority's own
 * hue as the label color — a /15 tint behind neutral text is what keeps
 * that rule true here too, rather than a fresh contrast decision per caller.
 */
export const PRIORITY_TINT: Readonly<Record<Priority, string>> = {
  urgent: 'bg-priority-urgent/15',
  high: 'bg-warning/15',
  normal: 'bg-priority-medium/15',
  low: 'bg-ink-faint/15',
};
