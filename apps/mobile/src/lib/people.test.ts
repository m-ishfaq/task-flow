import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { directoryLabel, oooStatus } from './people.js';

describe('oooStatus', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-23T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('is false when neither date is set', () => {
    expect(oooStatus(null, null)).toBe(false);
  });

  it('is false once the return date has already passed', () => {
    expect(oooStatus(null, '2026-08-01T00:00:00.000Z')).toBe(false);
  });

  it('is true when only an until date is set and it is still ahead', () => {
    expect(oooStatus(null, '2026-08-30T00:00:00.000Z')).toBe(true);
  });

  it('is false when the start date is still in the future — scheduled, not out yet', () => {
    expect(oooStatus('2026-09-01T00:00:00.000Z', '2026-09-10T00:00:00.000Z')).toBe(false);
  });

  it('is true once the start date has passed and the return date is still ahead', () => {
    expect(oooStatus('2026-08-20T00:00:00.000Z', '2026-08-30T00:00:00.000Z')).toBe(true);
  });

  it('is false exactly at the return instant — not "still out" for zero duration', () => {
    expect(oooStatus(null, '2026-08-23T12:00:00.000Z')).toBe(false);
  });
});

describe('directoryLabel', () => {
  it('prefers the display name when one is set', () => {
    expect(directoryLabel({ displayName: 'Jane Doe', email: 'jane@example.com' })).toBe('Jane Doe');
  });

  it('falls back to the email when no display name is set', () => {
    expect(directoryLabel({ displayName: null, email: 'jane@example.com' })).toBe(
      'jane@example.com',
    );
  });
});
