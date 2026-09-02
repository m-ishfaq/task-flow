import type { FilterNode } from '@taskflow/filter';
import type { SavedView } from './api.js';
import type { GroupBy, SortBy } from './grouping.js';

/**
 * Deriving which saved view the board is currently showing.
 *
 * Its own module, not part of `view-tabs.tsx`: a file that exports both
 * components and plain functions breaks React Fast Refresh, and this is the
 * piece worth unit testing anyway.
 *
 * There is deliberately no stored "selected view". The URL is the single
 * description of what is on screen (§10.5), and a selected view is just the
 * observation that the URL happens to equal a saved one. Storing it instead
 * would give the board two descriptions of itself, and a link pasted into chat
 * would carry one while the tab strip showed the other.
 */

export interface BoardArrangement {
  readonly type: 'board' | 'table' | 'list' | 'insights';
  readonly groupBy: GroupBy;
  readonly sortBy: SortBy;
  readonly filter: FilterNode | null;
}

/**
 * The matching view's id, or null.
 *
 * The filter comparison is structural, via `JSON.stringify`. That is sound
 * here for a specific reason and not in general: both trees are produced by the
 * same builder and the same parser, so key ORDER is stable between them. A
 * filter hand-written into the URL with reordered keys simply fails to match,
 * which deselects a tab rather than corrupting anything.
 */
export function matchingView(
  views: readonly SavedView[],
  current: BoardArrangement,
): string | null {
  const currentFilter = JSON.stringify(current.filter);

  const match = views.find(
    (view) =>
      /* A broken view's filter reads back as null, which would otherwise
         collide with an unfiltered board and highlight a tab that cannot be
         applied. */
      !view.filterBroken &&
      view.type === current.type &&
      (view.groupBy ?? 'list') === current.groupBy &&
      (view.sortBy ?? 'manual') === current.sortBy &&
      JSON.stringify(view.filter ?? null) === currentFilter,
  );

  return match?.viewId ?? null;
}
