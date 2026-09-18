import type { ListSummary } from './api.js';

/**
 * A per-column background tint keyed to a list's own rank-order position,
 * not its name — the warm-dark rebuild's own real Work-module idea
 * (`ai/design-rebuild-warm-dark.md` §5). `styles.css`'s own `--column-tint-*`
 * tokens tried to key a per-column tint off a fixed five-value taxonomy
 * (backlog/todo/progress/review/done) matched against a list's own NAME —
 * found dead (that file's own header) and rejected here for the same
 * reason: lists are arbitrary, org-renamable text, not that enum, and a
 * name-heuristic would silently do nothing for a renamed or custom list.
 *
 * LEFT-TO-RIGHT COLUMN ORDER, by contrast, is "earlier workflow stage" to
 * every kanban board ever built, regardless of what any one column is
 * called — that convention is what makes it a kanban board. A column's
 * fractional position in `siblings` (its own rank order) maps to a
 * barely-perceptible warm wash that strengthens moving rightward, so the
 * board reads, at a glance, as a gradient toward "done" — real and
 * meaningful for every board, without asking what any single column means.
 *
 * Pulled into its own file (mirroring `duplicate-detect.ts`'s own precedent
 * in this same directory) purely to keep `list-column.tsx` a
 * components-only file for React Fast Refresh — this function has no
 * component of its own to live alongside.
 */
export function flowTintGradient(
  list: Pick<ListSummary, 'listId'>,
  siblings: readonly Pick<ListSummary, 'listId'>[],
): string {
  const index = siblings.findIndex((entry) => entry.listId === list.listId);
  const position = index === -1 ? 0 : index;
  const span = siblings.length > 1 ? siblings.length - 1 : 1;
  const mixPercent = Math.round((position / span) * 9);
  return [
    `linear-gradient(180deg, color-mix(in oklab, var(--color-accent) ${String(mixPercent)}%, transparent) 0%, transparent 55%)`,
    /* A real duplicate of `.column-container`'s own gradient recipe
       (`styles.css`), not a reference to it — an inline `style` always
       wins over a class for the same longhand property
       (`background-image`), so painting only the accent wash here would
       silently blank out the class's neutral background rather than
       layering on top of it. If that CSS rule's own gradient recipe ever
       changes, this copy needs the identical edit — a real, accepted
       drift risk for a two-line CSS value, not a large one. */
    'linear-gradient(180deg, color-mix(in oklab, var(--color-surface-sunken) 60%, transparent) 0%, var(--color-surface-sunken) 100%)',
  ].join(', ');
}
