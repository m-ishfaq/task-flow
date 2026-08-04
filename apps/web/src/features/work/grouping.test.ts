import { describe, expect, it } from 'vitest';
import {
  NONE_KEY,
  fieldPatchForGroup,
  groupCards,
  isDraggable,
  isReorderable,
  sortCards,
  type GroupingContext,
} from './grouping.js';
import type { CardSummary, Status } from './api.js';

/**
 * Grouping and sorting, tested the way `neighbours.ts` is: every way this
 * can be wrong is SILENT. A card that groups into the wrong column, or a
 * `fieldPatchForGroup` that writes the wrong field, produces a board that
 * looks plausible and is quietly showing (or moving) the wrong thing.
 */

function card(overrides: Partial<CardSummary> = {}): CardSummary {
  return {
    cardId: 'card-1',
    listId: 'list-1',
    boardId: 'board-1',
    reference: 'WEB-1',
    title: 'A card',
    rank: 'a0',
    assigneeIds: [],
    statusId: null,
    priority: null,
    dueDate: null,
    commentCount: 0,
    checklistDone: 0,
    checklistTotal: 0,
    version: 1,
    archivedAt: null,
    ...overrides,
  };
}

function status(overrides: Partial<Status> = {}): Status {
  return {
    statusId: 'status-1',
    projectId: 'project-1',
    name: 'To Do',
    category: 'not_started',
    color: '#94a3b8',
    position: 1,
    isDefault: false,
    cardCount: 0,
    ...overrides,
  };
}

const EMPTY_CONTEXT: GroupingContext = { lists: [], statuses: [], people: [] };

describe('grouping by list', () => {
  it('keeps every list as a column even when it has no cards', () => {
    const groups = groupCards([], 'list', {
      ...EMPTY_CONTEXT,
      lists: [
        { listId: 'a', name: 'Todo' },
        { listId: 'b', name: 'Doing' },
      ],
    });

    // A column disappearing the moment its last card leaves would delete it
    // from under the pointer mid-drag.
    expect(groups.map((g) => g.key)).toEqual(['a', 'b']);
    expect(groups.every((g) => g.cards.length === 0)).toBe(true);
  });

  it('sorts cards into the list named on the card', () => {
    const groups = groupCards(
      [card({ cardId: '1', listId: 'a' }), card({ cardId: '2', listId: 'b' })],
      'list',
      {
        ...EMPTY_CONTEXT,
        lists: [
          { listId: 'a', name: 'Todo' },
          { listId: 'b', name: 'Doing' },
        ],
      },
    );

    expect(groups[0]?.cards.map((c) => c.cardId)).toEqual(['1']);
    expect(groups[1]?.cards.map((c) => c.cardId)).toEqual(['2']);
  });
});

describe('grouping by status', () => {
  it('orders known statuses first and appends "No status" only when needed', () => {
    const todo = status({ statusId: 's1', name: 'To Do', position: 1 });
    const done = status({ statusId: 's2', name: 'Done', position: 2 });

    const groups = groupCards(
      [
        card({ cardId: '1', statusId: 's1' }),
        card({ cardId: '2', statusId: null }),
        card({ cardId: '3', statusId: 's2' }),
      ],
      'status',
      { ...EMPTY_CONTEXT, statuses: [todo, done] },
    );

    expect(groups.map((g) => g.label)).toEqual(['To Do', 'Done', 'No status']);
    expect(groups[2]?.cards.map((c) => c.cardId)).toEqual(['2']);
  });

  it('omits the "No status" bucket when every card is classified', () => {
    const todo = status({ statusId: 's1' });
    const groups = groupCards([card({ statusId: 's1' })], 'status', {
      ...EMPTY_CONTEXT,
      statuses: [todo],
    });

    expect(groups).toHaveLength(1);
  });
});

describe('grouping by assignee', () => {
  it('places a multi-assignee card under every one of its assignees', () => {
    /* Deliberately not "the first assignee only" — a card assigned to two
       people is real work for both, and a board grouped by assignee that
       only shows it in one person's column would make "what is on my plate"
       wrong for exactly the collaborative cards a team cares about seeing. */
    const groups = groupCards([card({ assigneeIds: ['alice', 'bob'] })], 'assignee', {
      ...EMPTY_CONTEXT,
      people: [
        { userId: 'alice', label: 'Alice' },
        { userId: 'bob', label: 'Bob' },
      ],
    });

    expect(groups[0]?.cards).toHaveLength(1);
    expect(groups[1]?.cards).toHaveLength(1);
  });

  it('buckets an empty assignee set as Unassigned', () => {
    const groups = groupCards([card({ assigneeIds: [] })], 'assignee', {
      ...EMPTY_CONTEXT,
      people: [{ userId: 'alice', label: 'Alice' }],
    });

    expect(groups.at(-1)).toMatchObject({ label: 'Unassigned' });
  });
});

describe('grouping by priority', () => {
  it('orders urgent first and appends "No priority" last', () => {
    const groups = groupCards(
      [
        card({ cardId: '1', priority: 'low' }),
        card({ cardId: '2', priority: 'urgent' }),
        card({ cardId: '3', priority: null }),
      ],
      'priority',
      EMPTY_CONTEXT,
    );

    expect(groups.map((g) => g.label)).toEqual(['Urgent', 'High', 'Normal', 'Low', 'No priority']);
    expect(groups[0]?.cards.map((c) => c.cardId)).toEqual(['2']);
    expect(groups[3]?.cards.map((c) => c.cardId)).toEqual(['1']);
  });
});

describe('grouping by due date', () => {
  const now = new Date('2026-08-04T12:00:00Z');

  it('buckets overdue, today, this week, later, and no due date', () => {
    const groups = groupCards(
      [
        card({ cardId: 'overdue', dueDate: '2026-08-01T00:00:00Z' }),
        card({ cardId: 'today', dueDate: '2026-08-04T00:00:00Z' }),
        card({ cardId: 'week', dueDate: '2026-08-08T00:00:00Z' }),
        card({ cardId: 'later', dueDate: '2026-09-01T00:00:00Z' }),
        card({ cardId: 'none', dueDate: null }),
      ],
      'due',
      { ...EMPTY_CONTEXT, now },
    );

    expect(groups.map((g) => g.key)).toEqual(['overdue', 'today', 'week', 'later', 'none']);
    expect(groups.map((g) => g.cards[0]?.cardId)).toEqual([
      'overdue',
      'today',
      'week',
      'later',
      'none',
    ]);
  });

  it('drops empty buckets rather than rendering them', () => {
    const groups = groupCards([card({ dueDate: '2026-08-04T00:00:00Z' })], 'due', {
      ...EMPTY_CONTEXT,
      now,
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.key).toBe('today');
  });
});

describe('sortCards', () => {
  it('leaves manual order untouched — it IS the rank order', () => {
    const cards = [card({ cardId: 'b' }), card({ cardId: 'a' })];
    expect(sortCards(cards, 'manual')).toBe(cards);
  });

  it('sorts by title', () => {
    const sorted = sortCards(
      [card({ cardId: '1', title: 'Zebra' }), card({ cardId: '2', title: 'Apple' })],
      'title',
    );
    expect(sorted.map((c) => c.cardId)).toEqual(['2', '1']);
  });

  it('sorts by due date, with no-due-date last regardless of direction', () => {
    const sorted = sortCards(
      [
        card({ cardId: 'none', dueDate: null }),
        card({ cardId: 'later', dueDate: '2026-09-01T00:00:00Z' }),
        card({ cardId: 'sooner', dueDate: '2026-08-04T00:00:00Z' }),
      ],
      'due',
    );
    expect(sorted.map((c) => c.cardId)).toEqual(['sooner', 'later', 'none']);
  });

  it('sorts by priority, urgent first and no-priority last', () => {
    const sorted = sortCards(
      [
        card({ cardId: 'none', priority: null }),
        card({ cardId: 'low', priority: 'low' }),
        card({ cardId: 'urgent', priority: 'urgent' }),
      ],
      'priority',
    );
    expect(sorted.map((c) => c.cardId)).toEqual(['urgent', 'low', 'none']);
  });
});

describe('the reorder/drag rule (§3.2)', () => {
  it('allows reordering only when grouped by list', () => {
    expect(isReorderable('list')).toBe(true);
    expect(isReorderable('status')).toBe(false);
    expect(isReorderable('assignee')).toBe(false);
    expect(isReorderable('priority')).toBe(false);
    expect(isReorderable('due')).toBe(false);
  });

  it('disables dragging entirely for due-date grouping', () => {
    // "This week" is a range, not a value a due date could be SET to — there
    // is no field a drop onto that bucket could write.
    expect(isDraggable('due')).toBe(false);
    expect(isDraggable('list')).toBe(true);
    expect(isDraggable('status')).toBe(true);
    expect(isDraggable('assignee')).toBe(true);
    expect(isDraggable('priority')).toBe(true);
  });
});

describe('fieldPatchForGroup', () => {
  it('returns null for list — cards.move already owns that mutation', () => {
    expect(fieldPatchForGroup('list', 'list-1')).toBeNull();
  });

  it('returns null for due — dragging is disabled, so this is never called', () => {
    expect(fieldPatchForGroup('due', 'today')).toBeNull();
  });

  it('sets the status id, or null for the "No status" bucket', () => {
    expect(fieldPatchForGroup('status', 's1')).toEqual({ statusId: 's1' });
    expect(fieldPatchForGroup('status', NONE_KEY)).toEqual({ statusId: null });
  });

  it('replaces the whole assignee set with just the target person', () => {
    // "Set", not "add" — the same semantics status and priority have, so a
    // drop means one unambiguous thing rather than leaving prior assignees
    // silently attached.
    expect(fieldPatchForGroup('assignee', 'alice')).toEqual({ assigneeIds: ['alice'] });
    expect(fieldPatchForGroup('assignee', NONE_KEY)).toEqual({ assigneeIds: [] });
  });

  it('sets the priority, or null for the "No priority" bucket', () => {
    expect(fieldPatchForGroup('priority', 'urgent')).toEqual({ priority: 'urgent' });
    expect(fieldPatchForGroup('priority', NONE_KEY)).toEqual({ priority: null });
  });
});
