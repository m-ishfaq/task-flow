import { describe, expect, it } from 'vitest';
import {
  dateToIsoInstant,
  dateToPlainDay,
  formatPickedDate,
  plainDayToDate,
} from './date-picker.js';

/**
 * Every `Date` here is built via the LOCAL-component constructor
 * (`new Date(year, monthIndex, day)`) rather than parsed from a string, and
 * every assertion reads it back through the same local getters
 * (`getFullYear`/`getMonth`/`getDate`) `dateToPlainDay` itself uses. That
 * makes these tests correct under whatever timezone actually runs them,
 * without needing to pin one — but it also means they cannot, by
 * construction, catch a regression back to `.toISOString().slice(0, 10)`
 * (that bug only shows up against a real, non-UTC system timezone).
 * `dateToPlainDay`/`plainDayToDate`'s round trip below is what stays honest
 * about the shape of the conversion instead.
 */
describe('dateToPlainDay', () => {
  it('formats year-month-day with zero-padding', () => {
    expect(dateToPlainDay(new Date(2026, 7, 23))).toBe('2026-08-23');
  });

  it('zero-pads a single-digit month and day', () => {
    expect(dateToPlainDay(new Date(2026, 0, 5))).toBe('2026-01-05');
  });

  it('round-trips through plainDayToDate', () => {
    const value = '2026-12-31';
    expect(dateToPlainDay(plainDayToDate(value))).toBe(value);
  });
});

describe('plainDayToDate', () => {
  it('parses as local midnight, matching this app’s existing ${trimmed}T00:00:00 pattern', () => {
    const parsed = plainDayToDate('2026-08-23');
    expect(parsed.getFullYear()).toBe(2026);
    expect(parsed.getMonth()).toBe(7);
    expect(parsed.getDate()).toBe(23);
    expect(parsed.getHours()).toBe(0);
    expect(parsed.getMinutes()).toBe(0);
  });
});

describe('dateToIsoInstant', () => {
  it('is a direct toISOString passthrough — same instant, round-tripped', () => {
    const date = new Date(2026, 7, 23, 14, 30);
    const iso = dateToIsoInstant(date);
    expect(new Date(iso).getTime()).toBe(date.getTime());
  });
});

describe('formatPickedDate', () => {
  it('renders day, abbreviated month, and full year', () => {
    expect(formatPickedDate(new Date(2026, 7, 23))).toBe('23 Aug 2026');
  });

  it('does not zero-pad the day', () => {
    expect(formatPickedDate(new Date(2026, 0, 5))).toBe('5 Jan 2026');
  });
});
