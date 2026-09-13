import { describe, expect, it } from 'vitest';
import { dayKeyOf, formatDayLabel } from './chat-helpers.js';

/**
 * Day dividers in the chat timeline (Design Bible §07's "day dividers").
 *
 * Both functions fail SILENTLY in the same way `firstUnreadAfter` does: a
 * wrong day key merges two real days into one missing divider, or splits one
 * day into two spurious ones — and either looks entirely plausible on
 * screen, which is why this is a pure function with its own test rather than
 * a comparison inlined into the render loop.
 */

describe('dayKeyOf', () => {
  it('agrees for two instants on the same local day', () => {
    expect(dayKeyOf('2026-09-10T08:00:00.000Z')).toBe(dayKeyOf('2026-09-10T20:00:00.000Z'));
  });

  it('disagrees for instants on different local days', () => {
    expect(dayKeyOf('2026-09-10T23:59:59.000Z')).not.toBe(dayKeyOf('2026-09-11T00:00:01.000Z'));
  });
});

describe('formatDayLabel', () => {
  it('labels the current moment "Today"', () => {
    expect(formatDayLabel(new Date().toISOString())).toBe('Today');
  });

  it('labels 24 hours ago "Yesterday"', () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    expect(formatDayLabel(yesterday.toISOString())).toBe('Yesterday');
  });

  it('labels anything older with a plain date, not a relative word', () => {
    const lastWeek = new Date();
    lastWeek.setDate(lastWeek.getDate() - 8);
    const label = formatDayLabel(lastWeek.toISOString());
    expect(label).not.toBe('Today');
    expect(label).not.toBe('Yesterday');
  });
});
