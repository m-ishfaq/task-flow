import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatDueDate } from './work.js';

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
