import type { Priority } from './api.js';

/**
 * The priority color system (UI/UX redesign, Phase C) — the single place
 * every surface that shows a priority (`card-tile.tsx`'s edge bar,
 * `list-view.tsx`/`table-view.tsx`'s rows, `status-priority-section.tsx`'s
 * picker preview) reads from, so the four colors and their order can never
 * drift between surfaces the way four independent inline maps would.
 *
 * Reuses existing, already-audited tokens for three of the four levels
 * rather than inventing new ones — see `styles.css`'s own comment on
 * `--color-priority-urgent` for why only `urgent` needed a new token and
 * the exact contrast numbers behind all four. These are NON-TEXT swatch
 * classes (`bg-*`) only: pair with neutral `text-ink`/`text-ink-muted` for
 * the label, never render the swatch color as the label's own text color.
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
  normal: 'bg-accent',
  low: 'bg-ink-faint',
};
