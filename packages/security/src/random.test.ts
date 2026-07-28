import { describe, expect, it } from 'vitest';
import {
  HUMAN_ALPHABET,
  secureBytes,
  secureCode,
  secureEqual,
  secureHex,
  secureInt,
  secureToken,
  wipe,
} from './random.js';

describe('secureBytes', () => {
  it('returns the requested length', () => {
    expect(secureBytes(1)).toHaveLength(1);
    expect(secureBytes(64)).toHaveLength(64);
  });

  it('rejects non-positive and non-integer lengths', () => {
    expect(() => secureBytes(0)).toThrow(RangeError);
    expect(() => secureBytes(-1)).toThrow(RangeError);
    expect(() => secureBytes(1.5)).toThrow(RangeError);
  });

  it('does not repeat', () => {
    // Not a randomness test — no unit test can be one. This catches the specific
    // failure of a buffer being allocated once and reused, which has happened in
    // real libraries and produces identical "random" values.
    const seen = new Set<string>();
    for (let i = 0; i < 500; i += 1) {
      seen.add(Buffer.from(secureBytes(16)).toString('hex'));
    }
    expect(seen.size).toBe(500);
  });
});

describe('secureInt', () => {
  it('stays within [min, max)', () => {
    for (let i = 0; i < 1000; i += 1) {
      const value = secureInt(5, 10);
      expect(value).toBeGreaterThanOrEqual(5);
      expect(value).toBeLessThan(10);
    }
  });

  it('covers the whole range', () => {
    const seen = new Set<number>();
    for (let i = 0; i < 1000; i += 1) seen.add(secureInt(0, 4));
    expect([...seen].sort()).toEqual([0, 1, 2, 3]);
  });
});

describe('secureToken / secureHex', () => {
  it('encodes without URL-unsafe characters', () => {
    for (let i = 0; i < 200; i += 1) {
      expect(secureToken(32)).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('produces the expected encoded lengths', () => {
    expect(secureToken(32)).toHaveLength(43); // ceil(32 * 8 / 6)
    expect(secureHex(32)).toHaveLength(64);
  });
});

describe('secureCode', () => {
  it('draws only from the given alphabet', () => {
    const code = secureCode(200, 'ABC');
    expect(code).toHaveLength(200);
    expect(code).toMatch(/^[ABC]+$/);
  });

  it('is close to uniform across the alphabet', () => {
    // Guards the specific bug this function exists to avoid: `byte % length`
    // over-selects the first `256 % length` characters. With a 30-character
    // alphabet that bias is ~15% on the low characters — visible at this sample
    // size, invisible by inspection.
    const counts = new Map<string, number>();
    const sample = secureCode(30_000, HUMAN_ALPHABET);
    for (const char of sample) counts.set(char, (counts.get(char) ?? 0) + 1);

    const expected = 30_000 / HUMAN_ALPHABET.length;
    for (const char of HUMAN_ALPHABET) {
      expect(counts.get(char) ?? 0).toBeGreaterThan(expected * 0.8);
      expect(counts.get(char) ?? 0).toBeLessThan(expected * 1.2);
    }
  });

  it('excludes characters humans confuse when transcribing', () => {
    for (const ambiguous of ['I', 'L', 'O', 'U', '0', '1']) {
      expect(HUMAN_ALPHABET).not.toContain(ambiguous);
    }
  });

  it('rejects a degenerate alphabet', () => {
    expect(() => secureCode(4, 'A')).toThrow(RangeError);
  });
});

describe('secureEqual', () => {
  it('matches equal values', () => {
    expect(secureEqual('token', 'token')).toBe(true);
    expect(secureEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
  });

  it('rejects different values', () => {
    expect(secureEqual('token', 'tokem')).toBe(false);
    expect(secureEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
  });

  it('handles length mismatches without throwing', () => {
    // `crypto.timingSafeEqual` throws on unequal lengths. Catching that and
    // returning false would leak the secret's length through timing, so the
    // implementation hashes first — this asserts the behaviour that requires.
    expect(secureEqual('short', 'a-considerably-longer-value')).toBe(false);
    expect(secureEqual('', 'x')).toBe(false);
    expect(secureEqual('', '')).toBe(true);
  });
});

describe('wipe', () => {
  it('zeroes the buffer in place', () => {
    const key = secureBytes(32);
    wipe(key);
    expect([...key].every((byte) => byte === 0)).toBe(true);
  });
});
