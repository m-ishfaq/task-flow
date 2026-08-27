import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { daysUntil, formatMoney } from './billing.js';

describe('formatMoney', () => {
  it('formats whole dollars from integer cents', () => {
    expect(formatMoney(1999)).toBe('$19.99');
  });

  it('formats zero', () => {
    expect(formatMoney(0)).toBe('$0.00');
  });

  it('respects a non-default currency', () => {
    expect(formatMoney(1000, 'eur')).toBe('€10.00');
  });

  it('accepts a lowercase currency code, matching what the API sends', () => {
    // `Intl.NumberFormat` requires an uppercase ISO code; the wire value is
    // lowercase (`comms.spend_ledger` and the billing plan rows both store
    // it that way), so this only proves the uppercasing step is real.
    expect(formatMoney(500, 'usd')).toBe('$5.00');
  });
});

describe('daysUntil', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-23T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rounds up to whole days remaining', () => {
    expect(daysUntil('2026-09-06T12:00:00.000Z')).toBe(14);
  });

  it('rounds a partial day up rather than truncating', () => {
    expect(daysUntil('2026-08-24T00:00:00.000Z')).toBe(1);
  });

  it('returns null once the deadline is in the past', () => {
    expect(daysUntil('2026-08-01T00:00:00.000Z')).toBeNull();
  });

  it('returns null exactly at the deadline — "0 days left" is not a sentence', () => {
    expect(daysUntil('2026-08-23T12:00:00.000Z')).toBeNull();
  });
});
