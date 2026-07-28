import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { isValidId, type CardId } from '@taskflow/contracts';
import { newId, timestampOf, uuidv7 } from './uuid.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('uuidv7 format', () => {
  it('is a valid lowercase hyphenated UUID', () => {
    const id = uuidv7();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(isValidId(id)).toBe(true);
  });

  it('sets the version and variant bits required by RFC 9562', () => {
    for (let i = 0; i < 200; i += 1) {
      const hex = uuidv7().replace(/-/g, '');
      expect(hex[12]).toBe('7'); // version
      expect(['8', '9', 'a', 'b']).toContain(hex[16]); // variant 0b10xx
    }
  });

  it('encodes the current time in the leading 48 bits', () => {
    const before = Date.now();
    const id = uuidv7();
    const after = Date.now();

    const embedded = timestampOf(id);
    expect(embedded).toBeDefined();
    expect(embedded!.getTime()).toBeGreaterThanOrEqual(before);
    // A few milliseconds of slack: generating ids faster than 4096/ms borrows
    // from the next millisecond by design, so the embedded time may lead the
    // wall clock slightly.
    expect(embedded!.getTime()).toBeLessThanOrEqual(after + 5);
  });

  it('handles timestamps above 2^32 milliseconds', () => {
    // Date.now() passed 2^32 ms in 1970+49 days, so the high half of the
    // timestamp is always non-zero. A `ms >>> 32` shift would coerce to int32
    // and silently write zeros there; this asserts the top bytes carry data.
    const hex = uuidv7().replace(/-/g, '');
    expect(hex.slice(0, 12)).not.toBe('000000000000');
    expect(Number.parseInt(hex.slice(0, 12), 16)).toBeGreaterThan(1_700_000_000_000);
  });
});

describe('uuidv7 uniqueness and ordering', () => {
  it('never collides across a large batch', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 50_000; i += 1) ids.add(uuidv7());
    expect(ids.size).toBe(50_000);
  });

  it('sorts lexicographically in generation order', () => {
    // This is the property the whole choice of v7 buys: string sort == time
    // sort, which is what makes it usable as a keyset pagination cursor and
    // what gives the primary-key index its insert locality.
    const ids = Array.from({ length: 20_000 }, () => uuidv7());
    expect([...ids].sort()).toEqual(ids);
  });

  it('stays ordered within a single frozen millisecond', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-27T12:00:00.000Z'));

    const ids = Array.from({ length: 5_000 }, () => uuidv7());
    expect(new Set(ids).size).toBe(5_000);
    expect([...ids].sort()).toEqual(ids);
  });

  it('stays ordered when the clock steps backwards', () => {
    // NTP corrections and VM live-migration both move the clock backwards. An id
    // that sorts before its predecessor silently breaks keyset pagination: the
    // client asks for "everything after X" and never sees the rows behind it.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-27T12:00:00.000Z'));
    const before = uuidv7();

    vi.setSystemTime(new Date('2026-07-27T11:59:55.000Z'));
    const after = uuidv7();

    expect(after > before).toBe(true);
  });
});

describe('timestampOf', () => {
  it('rejects anything that is not a v7 UUID', () => {
    expect(timestampOf('f47ac10b-58cc-4372-a567-0e02b2c3d479')).toBeUndefined(); // v4
    expect(timestampOf('not-a-uuid')).toBeUndefined();
    expect(timestampOf('')).toBeUndefined();
  });
});

describe('newId', () => {
  it('produces a branded id without an unsafe cast at the call site', () => {
    const cardId = newId<'CardId'>();
    expectTypeOf(cardId).toEqualTypeOf<CardId>();
    expect(isValidId(cardId)).toBe(true);
  });
});
