import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  dueBucketOf,
  formatBytes,
  formatDueDate,
  groupCardsByDue,
  type CardSummary,
} from './work.js';

/**
 * `formatDueDate` (Wave 2, "My Tasks") — ported from `apps/web/src/lib/
 * format.ts`'s function of the same name, verbatim logic. The clock is
 * pinned with `vi.setSystemTime` because `isToday`/`isTomorrow`/`isPast`
 * all read the real system clock internally; an unpinned test would pass
 * today and fail exactly one year from now on the leap-day case, or drift
 * flaky near midnight.
 *
 * ## `vi.setSystemTime` pins the CLOCK, not the TIME ZONE
 *
 * `startOfDay`/`isToday`/`isTomorrow` all bucket by the LOCAL calendar
 * day, and this suite never controls which local time zone the process
 * running it is in — CI, a contributor's laptop, and this sandbox can all
 * disagree. A fixture built from an arbitrary UTC hour near a day
 * boundary (`...T23:00:00.000Z`, `...T01:00:00.000Z`, `...T09:00:00.000Z`)
 * silently lands on a DIFFERENT local calendar day than intended the
 * moment the offset pushes it across midnight — which, for a due date only
 * a few hours from `NOW`'s own UTC clock time, is not a rare edge case:
 * `...T23:00:00.000Z` broke at any positive UTC offset (most of Europe,
 * Africa, Asia, Australia), and `...T01:00:00.000Z` broke at any offset at
 * or past UTC-2 (effectively all of the Americas) — found only because a
 * contributor outside UTC actually ran the suite, not by inspection.
 *
 * The fix below is not "pick a safer-looking hour" — that is exactly the
 * reasoning that produced the broken fixtures in the first place, just
 * with a different, still-arbitrary margin. It is to make each fixture's
 * relationship to `NOW` OFFSET-INVARIANT by construction:
 *
 *   - "Same day as `NOW`" fixtures reuse `NOW`'s own instant. Two
 *     identical timestamps land on the same local calendar day in every
 *     time zone there is — not "most", all of them — so there is nothing
 *     left to reason about.
 *   - "N days from `NOW`" fixtures keep `NOW`'s exact clock time
 *     (`T12:00:00.000Z`) and only change the calendar date. Shifting a
 *     fixed UTC offset onto two timestamps that already share a
 *     clock-time preserves their day-count difference exactly, for the
 *     same reason `x + k` and `y + k` are exactly `x - y` apart for any
 *     `k` — so the "how many days apart" assertions (`overdue`/`today`/
 *     "not overdue") hold in every zone too.
 *   - "Earlier today" reuses `NOW` minus ONE MINUTE, not eleven hours —
 *     the smaller the delta, the narrower the band of offsets where `NOW`
 *     itself sits close enough to ITS OWN local midnight for a delta of
 *     that size to cross it. A one-minute delta only fails at an offset of
 *     EXACTLY ±12:00 — a rounding error's width of exposure compared to
 *     the eleven-hour original, and about as far as this can be pushed
 *     without controlling the process time zone directly.
 *
 * One honest residual, deliberately not chased further: the exact LABEL
 * TEXT for a due date several days from `NOW` (`'20 Jun'`, `'10 Jun'`)
 * still depends on which calendar date `NOW` itself falls on locally, and
 * at UTC+12 and beyond (`Pacific/Auckland` in June, `Pacific/Kiritimati`,
 * `Pacific/Chatham`) `NOW` has already rolled onto the 16th — shifting
 * every label by one day. Closing that fully would mean deriving the
 * expected label from `NOW` with the same arithmetic the implementation
 * uses, which would make the assertion restate the code under test rather
 * than check it independently — a worse trade for a handful of Pacific
 * time zones than accepting the gap and naming it here.
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
    expect(formatDueDate(NOW.toISOString())).toEqual({
      label: 'Today',
      overdue: false,
    });
  });

  it('labels tomorrow as "Tomorrow"', () => {
    expect(formatDueDate('2026-06-16T12:00:00.000Z')).toEqual({
      label: 'Tomorrow',
      overdue: false,
    });
  });

  it('labels a date further out with a day/month format, not overdue', () => {
    expect(formatDueDate('2026-06-20T12:00:00.000Z')).toEqual({
      label: '20 Jun',
      overdue: false,
    });
  });

  it('flags a past date as overdue', () => {
    expect(formatDueDate('2026-06-10T12:00:00.000Z')).toEqual({
      label: '10 Jun',
      overdue: true,
    });
  });

  it('does not flag EARLIER today as overdue — the isToday carve-out', () => {
    // One minute before "now", not eleven hours — see this describe
    // block's own header on why the delta's SIZE is what keeps this
    // robust across time zones, not the direction.
    expect(formatDueDate(new Date(NOW.getTime() - 60_000).toISOString())?.overdue).toBe(false);
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
    labelColors: [],
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
    // The SAME instant as `NOW` — see this file's own header above (the
    // "offset-invariant by construction" section). This was originally
    // `...T23:00:00.000Z`, which rolled onto the next LOCAL day at any
    // positive UTC offset and bucketed as "week" instead, outside UTC.
    expect(dueBucketOf(NOW.toISOString(), NOW)).toBe('today');
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
        // `later`/`overdue` keep a wide, multi-day margin from `NOW` in
        // every real time zone; `today` reuses `NOW`'s own instant for the
        // same reason `dueBucketOf`'s "today" test does — see this file's
        // own header on why that is the one choice offset-invariant by
        // construction, not just "safe enough".
        card({ cardId: 'later', dueDate: '2026-06-25T09:00:00.000Z' }),
        card({ cardId: 'overdue', dueDate: '2026-06-10T09:00:00.000Z' }),
        card({ cardId: 'today', dueDate: NOW.toISOString() }),
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

describe('formatBytes', () => {
  it('shows small counts in exact bytes, never rounded to 0.0 KB', () => {
    expect(formatBytes(40)).toBe('40 B');
  });

  it('switches to KB at 1000 bytes', () => {
    expect(formatBytes(1500)).toBe('1.5 KB');
  });

  it('switches to MB once KB would exceed 1000', () => {
    expect(formatBytes(1_500_000)).toBe('1.5 MB');
  });

  it('caps at GB rather than continuing past it', () => {
    expect(formatBytes(2_500_000_000)).toBe('2.5 GB');
  });
});
