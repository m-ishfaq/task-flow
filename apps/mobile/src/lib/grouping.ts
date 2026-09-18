/**
 * Grouping and sorting — ported from `apps/web/src/features/work/grouping.ts`,
 * the pure React-free functions that decide how a flat card array becomes
 * sections on screen. This module is the single source of truth for mobile's
 * group-by/sort-by logic, kept in step with web's version the same way
 * `work.ts`'s `groupCardsByDue` already mirrors web's `dueBucketOf`.
 *
 * Unlike web, mobile has no drag-and-drop, so `isReorderable`/`isDraggable`/
 * `fieldPatchForGroup` are omitted — they would be dead code here.
 *
 * `CardSummary` is imported from `work.ts` (mobile's own derived wire type),
 * not from web's `api.ts`, so a field the server adds, removes, or renames
 * is a compile error here rather than silent drift.
 */
import type { CardSummary } from './work.js';

// ── Types ──────────────────────────────────────────────────────────────────

export type GroupBy = 'list' | 'status' | 'assignee' | 'priority' | 'due';
export type SortBy = 'manual' | 'title' | 'due' | 'priority';

export const GROUP_BY_OPTIONS: readonly GroupBy[] = [
  'list',
  'status',
  'assignee',
  'priority',
  'due',
];
export const SORT_BY_OPTIONS: readonly SortBy[] = ['manual', 'title', 'due', 'priority'];

export const GROUP_BY_LABEL: Readonly<Record<GroupBy, string>> = {
  list: 'List',
  status: 'Status',
  assignee: 'Assignee',
  priority: 'Priority',
  due: 'Due date',
};

export const SORT_BY_LABEL: Readonly<Record<SortBy, string>> = {
  manual: 'Manual',
  title: 'Title',
  due: 'Due date',
  priority: 'Priority',
};

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
  readonly statuses: readonly { readonly statusId: string; readonly name: string; readonly color: string | null }[];
  readonly people: readonly { readonly userId: string; readonly label: string }[];
  /** Injected rather than read from `Date.now()` inside the bucketer, so "today" is a test input. */
  readonly now?: Date;
}

/** The synthetic group key for "unassigned" / "no status" / "no priority". */
export const NONE_KEY = '__none__';

// ── Priority ───────────────────────────────────────────────────────────────

type Priority = 'urgent' | 'high' | 'normal' | 'low';

const PRIORITY_ORDER: readonly Priority[] = ['urgent', 'high', 'normal', 'low'];
const PRIORITY_LABEL: Readonly<Record<Priority, string>> = {
  urgent: 'Urgent',
  high: 'High',
  normal: 'Normal',
  low: 'Low',
};

function priorityRank(priority: Priority | null): number {
  if (priority === null) return PRIORITY_ORDER.length;
  return PRIORITY_ORDER.indexOf(priority);
}

// ── Due date buckets ───────────────────────────────────────────────────────

type DueBucket = 'overdue' | 'today' | 'week' | 'later' | 'none';
const DUE_BUCKET_ORDER: readonly DueBucket[] = ['overdue', 'today', 'week', 'later', 'none'];
const DUE_BUCKET_LABEL: Readonly<Record<DueBucket, string>> = {
  overdue: 'Overdue',
  today: 'Today',
  week: 'This week',
  later: 'Later',
  none: 'No due date',
};

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

// ── Grouping ───────────────────────────────────────────────────────────────

/**
 * Groups `cards` along `groupBy`, in the order the columns should render.
 *
 * Every group named by the context appears even when empty — a status or a
 * list with no cards is still a real column. The one exception is the "none"
 * bucket (unassigned, no priority, no due date), which only appears when at
 * least one card needs it.
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

// ── Sorting ────────────────────────────────────────────────────────────────

/**
 * Orders cards within a group for every grouping BUT list.
 *
 * List keeps its `(rank, id)` order exactly as returned — that order is the
 * drag-and-drop rank on web, and re-sorting it here would fight any future
 * reorder. Every other grouping has no rank to preserve, so this is what
 * decides the order instead.
 */
export function sortCards(cards: readonly CardSummary[], sortBy: SortBy): readonly CardSummary[] {
  if (sortBy === 'manual') return cards;

  const sorted = [...cards];

  switch (sortBy) {
    case 'title':
      sorted.sort((a, b) => a.title.localeCompare(b.title));
      return sorted;

    case 'due':
      // No due date sorts last — "someday" is not "soonest".
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
