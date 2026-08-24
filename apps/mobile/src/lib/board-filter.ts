import { and, compare, type FilterNode } from '@taskflow/filter';
import type { Priority } from './work.js';

/**
 * A simplified board filter — status/priority/assignee/label chips, ported
 * conceptually (not verbatim) from `apps/web/src/features/work/filter/
 * filter-builder.tsx`. Web's builder is a full, arbitrarily-nested AND/OR
 * tree editor over every field `packages/filter/src/fields.ts` whitelists —
 * 1,300+ lines across the builder, its value editor, and the TQL-draft
 * round trip. A phone has no room for that, and — the same call
 * `search-button.tsx`'s own header makes for TQL text — does not need it:
 * a flat AND of the four fields people actually reach for while scanning a
 * board (status, priority, who it's assigned to, which labels) covers the
 * real daily use, and this is that subset, not a reduced port of the tree
 * editor.
 *
 * ## Building the AST directly, not hand-rolling objects
 *
 * `@taskflow/filter` is a pure package (`zod` only, no Node-only APIs — the
 * same fact `share-board-modal.tsx`'s header confirmed for
 * `@taskflow/policy`, and confirmed again here by both platforms' `expo
 * export` still bundling clean). `compare`/`and` are the SAME constructors
 * web's own builder uses (`ast.ts`'s own "for tests, the visual builder,
 * and Phase 8's parser" comment), so a node built here is guaranteed
 * shape-correct — never a hand-typed object that happens to compile against
 * a structural type today and silently stops matching the real one after a
 * server-side rename tomorrow. The SERVER still re-validates every field
 * name and operator against the real whitelist regardless
 * (`packages/filter/src/fields.ts`'s own header) — this file only has to
 * build something well-formed, not something trustworthy on its own.
 */
export interface BoardFilterSelection {
  readonly statusId: string | null;
  readonly priority: Priority | null;
  readonly assigneeIds: readonly string[];
  readonly labelIds: readonly string[];
}

export const EMPTY_BOARD_FILTER: BoardFilterSelection = {
  statusId: null,
  priority: null,
  assigneeIds: [],
  labelIds: [],
};

export function isBoardFilterEmpty(selection: BoardFilterSelection): boolean {
  return (
    selection.statusId === null &&
    selection.priority === null &&
    selection.assigneeIds.length === 0 &&
    selection.labelIds.length === 0
  );
}

/**
 * `null` means "no filter" — `work.cards.list`'s own default — rather than
 * an empty group, so an unfiltered board sends exactly what it always has.
 * A single clause is still wrapped in `and(...)`: a bare `ComparisonNode` is
 * an equally valid `FilterNode`, but wrapping unconditionally means this
 * function has one shape to reason about instead of two, and the server
 * treats a one-child group identically to the clause alone.
 */
export function buildBoardFilter(selection: BoardFilterSelection): FilterNode | null {
  const clauses: FilterNode[] = [];
  if (selection.statusId !== null) clauses.push(compare('status', 'eq', selection.statusId));
  if (selection.priority !== null) clauses.push(compare('priority', 'eq', selection.priority));
  if (selection.assigneeIds.length > 0) {
    clauses.push(compare('assignee', 'in', selection.assigneeIds));
  }
  if (selection.labelIds.length > 0) clauses.push(compare('label', 'in', selection.labelIds));

  return clauses.length === 0 ? null : and(...clauses);
}

/** A stable cache-key fragment for a filter — mirrors web's own `filterKey` in `apps/web/src/features/work/api.ts`. */
export function boardFilterKey(filter: FilterNode | null): string {
  return filter === null ? 'all' : JSON.stringify(filter);
}

function toggledInList(list: readonly string[], id: string): readonly string[] {
  return list.includes(id) ? list.filter((entry) => entry !== id) : [...list, id];
}

export function toggleAssignee(
  selection: BoardFilterSelection,
  userId: string,
): BoardFilterSelection {
  return { ...selection, assigneeIds: toggledInList(selection.assigneeIds, userId) };
}

export function toggleLabel(
  selection: BoardFilterSelection,
  labelId: string,
): BoardFilterSelection {
  return { ...selection, labelIds: toggledInList(selection.labelIds, labelId) };
}
