import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dueBucketOf, formatDueDate, groupCardsByDue, type CardSummary } from './work.js';

/**
 * `formatDueDate` (Wave 2, "My Tasks") — ported from `apps/web/src/lib/
 * format.ts`'s function of the same name, verbatim logic. The clock is
 * pinned with `vi.setSystemTime` because `isToday`/`isTomorrow`/`isPast`
 * all read the real system clock internally; an unpinned test would pass
 * today and fail exactly one year from now on the leap-day case, or drift
 * flaky near midnight.
 */

const NOW = new Date('2026-06-15T12:00:00.000Z');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('formatDueDate', () => {
  it('returns null for no due date', () => {
    expect(formatDueDate(null)).toBeNull();
  });

  it('labels a due date of today as "Today", not overdue', () => {
    expect(formatDueDate('2026-06-15T09:00:00.000Z')).toEqual({
      label: 'Today',
      overdue: false,
    });
  });

  it('labels tomorrow as "Tomorrow"', () => {
    expect(formatDueDate('2026-06-16T09:00:00.000Z')).toEqual({
      label: 'Tomorrow',
      overdue: false,
    });
  });

  it('labels a date further out with a day/month format, not overdue', () => {
    expect(formatDueDate('2026-06-20T09:00:00.000Z')).toEqual({
      label: '20 Jun',
      overdue: false,
    });
  });

  it('flags a past date as overdue', () => {
    expect(formatDueDate('2026-06-10T09:00:00.000Z')).toEqual({
      label: '10 Jun',
      overdue: true,
    });
  });

  it('does not flag EARLIER today as overdue — the isToday carve-out', () => {
    // Before "now" (12:00) but still today.
    expect(formatDueDate('2026-06-15T01:00:00.000Z')?.overdue).toBe(false);
  });
});

function card(overrides: Partial<CardSummary> = {}): CardSummary {
  return {
    cardId: 'card-default',
    listId: 'list-1',
    boardId: 'board-1',
    projectId: 'project-1',
    reference: 'WEB-1',
    title: 'A card',
    rank: '0a',
    assigneeIds: [],
    statusId: null,
    priority: null,
    dueDate: null,
    sprintId: null,
    commentCount: 0,
    checklistDone: 0,
    checklistTotal: 0,
    version: 1,
    archivedAt: null,
    ...overrides,
  };
}

describe('dueBucketOf', () => {
  it('buckets a null due date as "none"', () => {
    expect(dueBucketOf(null, NOW)).toBe('none');
  });

  it('buckets a past date as "overdue"', () => {
    expect(dueBucketOf('2026-06-10T09:00:00.000Z', NOW)).toBe('overdue');
  });

  it('buckets today as "today"', () => {
    expect(dueBucketOf('2026-06-15T23:00:00.000Z', NOW)).toBe('today');
  });

  it('buckets within a week as "week"', () => {
    expect(dueBucketOf('2026-06-20T09:00:00.000Z', NOW)).toBe('week');
  });

  it('buckets more than a week out as "later"', () => {
    expect(dueBucketOf('2026-06-25T09:00:00.000Z', NOW)).toBe('later');
  });
});

describe('groupCardsByDue', () => {
  it('groups cards into buckets, in overdue-first display order', () => {
    const groups = groupCardsByDue(
      [
        card({ cardId: 'later', dueDate: '2026-06-25T09:00:00.000Z' }),
        card({ cardId: 'overdue', dueDate: '2026-06-10T09:00:00.000Z' }),
        card({ cardId: 'today', dueDate: '2026-06-15T09:00:00.000Z' }),
      ],
      NOW,
    );

    expect(groups.map((group) => group.bucket)).toEqual(['overdue', 'today', 'later']);
    expect(groups[0]?.cards.map((c) => c.cardId)).toEqual(['overdue']);
  });

  it('omits an empty bucket entirely, unlike a board column', () => {
    const groups = groupCardsByDue([card({ dueDate: null })], NOW);
    expect(groups).toEqual([{ bucket: 'none', label: 'No due date', cards: [expect.anything()] }]);
  });

  it('returns no groups for no cards', () => {
    expect(groupCardsByDue([], NOW)).toEqual([]);
  });
});
