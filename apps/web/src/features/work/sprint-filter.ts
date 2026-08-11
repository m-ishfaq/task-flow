import type { SprintId } from '@taskflow/contracts';
import type { CardSummary } from './api.js';

/**
 * The sprint dimension's filter — the whole definition of "which cards show
 * on this board" (`ai/phase-10.5-sprints.md`).
 *
 * A pure module, deliberately NOT part of `sprints.tsx`: a component file
 * that also exports a function cannot fast-refresh (the `filterCardsBySprint`
 * export made every edit to the picker invalidate the whole module instead of
 * hot-updating it — exactly the failure this split exists to prevent). The
 * rule is the same one `grouping.ts` and `selection.ts` follow: pure logic in
 * `.ts`, components in `.tsx`.
 *
 * Every way the filter could be wrong is quiet — a card in no sprint
 * vanishing from the backlog view, or a card from another project appearing
 * in this one's sprint — and none of them fail loudly, which is why the
 * function ships with its own test file.
 */

/** What the board is filtered to: all (null), the backlog, or one sprint. */
export type SprintFilter = 'backlog' | SprintId | null;

/**
 * Filters the board's shared card query by the sprint dimension.
 *
 * `null` (All) passes the array through unchanged — the no-filter fast path
 * keeps the board render identical to before the sprint dimension existed.
 * The backlog is `sprint_id IS NULL` on the wire, so the filter names it
 * literally alongside real sprint ids.
 */
export function filterCardsBySprint(
  cards: readonly CardSummary[],
  sprint: SprintFilter,
): readonly CardSummary[] {
  if (sprint === null) return cards;
  return sprint === 'backlog'
    ? cards.filter((card) => card.sprintId === null)
    : cards.filter((card) => card.sprintId === sprint);
}
