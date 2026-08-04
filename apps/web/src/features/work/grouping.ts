import type { CardSummary, Priority, Status } from './api.js';

/**
 * Grouping and sorting a board's cards (`ai/phase-3.5-work-ux.md` §5.6, §3.2).
 *
 * Pure and React-free, unit-tested directly. `cards.list` already returns
 * every card that matches the board's filter — grouping is a client-side
 * reshaping of that one array, not a second query, which is what keeps the
 * board and list views unable to disagree about which cards matched.
 *
 * ## The rule this file exists to enforce (§3.2)
 *
 * `rank` is scoped to a LIST. Grouping by anything else has no stored answer
 * for "the order within a group" — there is no `rank_by_status` column, and
 * there should not be one; see the plan for why. So:
 *
 *   - Dragging ACROSS groups sets the group's field — the status, the
 *     assignee, the priority a card was dropped onto.
 *   - Dragging to REORDER within a group only works when grouped by LIST,
 *     the one dimension with a real rank. Every other grouping sorts its
 *     groups by the view's `SortBy` and does not accept a reorder.
 *
 * `isReorderable` and `isDraggable` are what a board view consults instead of
 * re-deriving this rule at the call site.
 */

export type GroupBy = 'list' | 'status' | 'assignee' | 'priority' | 'due';
export type SortBy = 'manual' | 'title' | 'due' | 'priority';

export const GROUP_BY_OPTIONS: readonly GroupBy[] = ['list', 'status', 'assignee', 'priority', 'due'];
export const SORT_BY_OPTIONS: readonly SortBy[] = ['manual', 'title', 'due', 'priority'];

export interface Group {
  /** Stable across renders — a listId, a statusId, a userId, a priority name, or a due bucket name. */
  readonly key: string;
  readonly label: string;
  /** A swatch for the column header. Only status groups have one today. */
  readonly color: string | null;
  readonly cards: readonly CardSummary[];
}

export interface GroupingContext {
  readonly lists: readonly { readonly listId: string; readonly name: string }[];
  readonly statuses: readonly Status[];
  readonly people: readonly { readonly userId: string; readonly label: string }[];
  /** Injected rather than read from `Date.now()` inside the bucketer, so "today" is a test input. */
  readonly now?: Date;
}

/** The synthetic group key for "unassigned" / "no status" / "no priority". */
export const NONE_KEY = '__none__';

/** Only LIST has a stored rank to reorder within — see the file header. */
export function isReorderable(groupBy: GroupBy): boolean {
  return groupBy === 'list';
}

/**
 * Whether a card may be dragged AT ALL under this grouping.
 *
 * Due-date buckets are the one grouping excluded: "This Week" is not a value
 * a card's `dueDate` could be set TO — it is a range several different dates
 * satisfy — so there is no field a drop onto that bucket could write, unlike
 * status, assignee and priority which are each exactly one column.
 */
export function isDraggable(groupBy: GroupBy): boolean {
  return groupBy !== 'due';
}

const PRIORITY_ORDER: readonly Priority[] = ['urgent', 'high', 'normal', 'low'];
const PRIORITY_LABEL: Readonly<Record<Priority, string>> = {
  urgent: 'Urgent',
  high: 'High',
  normal: 'Normal',
  low: 'Low',
};

type DueBucket = 'overdue' | 'today' | 'week' | 'later' | 'none';
const DUE_BUCKET_ORDER: readonly DueBucket[] = ['overdue', 'today', 'week', 'later', 'none'];
const DUE_BUCKET_LABEL: Readonly<Record<DueBucket, string>> = {
  overdue: 'Overdue',
  today: 'Today',
  week: 'This week',
  later: 'Later',
  none: 'No due date',
};

/** Midnight of the given instant, in the viewer's local time zone. */
function startOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function dueBucketOf(dueDate: string | null, now: Date): DueBucket {
  if (dueDate === null) return 'none';

  const due = startOfDay(new Date(dueDate));
  const today = startOfDay(now);
  const days = Math.round((due.getTime() - today.getTime()) / 86_400_000);

  if (days < 0) return 'overdue';
  if (days === 0) return 'today';
  if (days <= 7) return 'week';
  return 'later';
}

/**
 * Groups `cards` along `groupBy`, in the order the columns should render.
 *
 * Every group named by the context appears even when empty — a status or a
 * list with no cards is still a real column, and dropping it the moment it
 * empties out would make "drag the last card away" delete the column from
 * under the pointer. The one exception is the "none" bucket (unassigned, no
 * priority, no due date), which only appears when at least one card needs it
 * — there is no vocabulary entry for "unassigned" to keep alive.
 */
export function groupCards(
  cards: readonly CardSummary[],
  groupBy: GroupBy,
  context: GroupingContext,
): readonly Group[] {
  switch (groupBy) {
    case 'list':
      return context.lists.map((list) => ({
        key: list.listId,
        label: list.name,
        color: null,
        cards: cards.filter((card) => card.listId === list.listId),
      }));

    case 'status': {
      const known = context.statuses.map((status) => ({
        key: status.statusId,
        label: status.name,
        color: status.color,
        cards: cards.filter((card) => card.statusId === status.statusId),
      }));
      const unclassified = cards.filter((card) => card.statusId === null);
      return unclassified.length === 0
        ? known
        : [...known, { key: NONE_KEY, label: 'No status', color: null, cards: unclassified }];
    }

    case 'assignee': {
      /* Multi-membership, deliberately: a card assigned to two people is real
         work for both of them, and hiding it from one person's column because
         it already appeared in another's would make "what is on my plate"
         wrong for exactly the cards a team is collaborating on. */
      const known = context.people.map((person) => ({
        key: person.userId,
        label: person.label,
        color: null,
        cards: cards.filter((card) => card.assigneeIds.includes(person.userId)),
      }));
      const unassigned = cards.filter((card) => card.assigneeIds.length === 0);
      return unassigned.length === 0
        ? known
        : [...known, { key: NONE_KEY, label: 'Unassigned', color: null, cards: unassigned }];
    }

    case 'priority': {
      const known = PRIORITY_ORDER.map((priority) => ({
        key: priority,
        label: PRIORITY_LABEL[priority],
        color: null,
        cards: cards.filter((card) => card.priority === priority),
      }));
      const none = cards.filter((card) => card.priority === null);
      return none.length === 0
        ? known
        : [...known, { key: NONE_KEY, label: 'No priority', color: null, cards: none }];
    }

    case 'due': {
      const now = context.now ?? new Date();
      const byBucket = new Map<DueBucket, CardSummary[]>();
      for (const card of cards) {
        const bucket = dueBucketOf(card.dueDate, now);
        const list = byBucket.get(bucket);
        if (list === undefined) byBucket.set(bucket, [card]);
        else list.push(card);
      }
      return DUE_BUCKET_ORDER.filter((bucket) => (byBucket.get(bucket) ?? []).length > 0).map(
        (bucket) => ({
          key: bucket,
          label: DUE_BUCKET_LABEL[bucket],
          color: null,
          cards: byBucket.get(bucket) ?? [],
        }),
      );
    }

    default: {
      const exhaustive: never = groupBy;
      throw new Error(`Unknown groupBy: ${String(exhaustive)}`);
    }
  }
}

/**
 * Orders cards within a group for every grouping BUT list.
 *
 * List keeps its `(rank, id)` order exactly as `cards.list` returned it —
 * that order is the drag-and-drop rank, and re-sorting it here would fight
 * the optimistic patch a move just applied (`board-view.tsx`). Every other
 * grouping has no rank to preserve, so this is what decides the order
 * instead.
 */
export function sortCards(cards: readonly CardSummary[], sortBy: SortBy): readonly CardSummary[] {
  if (sortBy === 'manual') return cards;

  const sorted = [...cards];

  switch (sortBy) {
    case 'title':
      sorted.sort((a, b) => a.title.localeCompare(b.title));
      return sorted;

    case 'due':
      // No due date sorts last, regardless of direction — "someday" is not
      // "soonest".
      sorted.sort((a, b) => {
        if (a.dueDate === null && b.dueDate === null) return 0;
        if (a.dueDate === null) return 1;
        if (b.dueDate === null) return -1;
        return a.dueDate.localeCompare(b.dueDate);
      });
      return sorted;

    case 'priority':
      sorted.sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority));
      return sorted;

    default: {
      const exhaustive: never = sortBy;
      throw new Error(`Unknown sortBy: ${String(exhaustive)}`);
    }
  }
}

/** Urgent first, no priority last — matching the column order `groupCards` uses. */
function priorityRank(priority: Priority | null): number {
  if (priority === null) return PRIORITY_ORDER.length;
  return PRIORITY_ORDER.indexOf(priority);
}

/**
 * The field patch a drop onto `groupKey` should write, under `groupBy`.
 *
 * `null` covers two different cases the caller does not need to tell apart:
 * grouped by list, where the EXISTING `cards.move` neighbours-based mutation
 * already owns this (see `board-view.tsx`); and grouped by due date, which
 * `isDraggable` has already refused before this would be called.
 *
 * Assignee replaces the whole set rather than adding to it — the same
 * "set", not "add", semantics status and priority have, and the one that
 * keeps a drop meaning one unambiguous thing: after this card lands in
 * Priya's column, Priya is who it is assigned to.
 */
export function fieldPatchForGroup(
  groupBy: GroupBy,
  groupKey: string,
):
  | { readonly statusId: string | null }
  | { readonly assigneeIds: readonly string[] }
  | { readonly priority: Priority | null }
  | null {
  const value = groupKey === NONE_KEY ? null : groupKey;

  switch (groupBy) {
    case 'status':
      return { statusId: value };
    case 'assignee':
      return { assigneeIds: value === null ? [] : [value] };
    case 'priority':
      return { priority: value as Priority | null };
    case 'list':
    case 'due':
      return null;
    default: {
      const exhaustive: never = groupBy;
      throw new Error(`Unknown groupBy: ${String(exhaustive)}`);
    }
  }
}
