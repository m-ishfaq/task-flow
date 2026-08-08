import { describe, expect, it } from 'vitest';
import { blindIndex, blindIndexEquals } from './blind-index.js';
import { encryptString } from './encryption.js';

const KEY = new Uint8Array(32).fill(9);
const OTHER_KEY = new Uint8Array(32).fill(8);
const ORG = '0195cc00-0000-7000-8000-000000000001';
const OTHER_ORG = '0195cc00-0000-7000-8000-000000000002';

describe('blindIndex', () => {
  it('is deterministic, which is the whole reason it exists', () => {
    /* AES-GCM is randomized, so `WHERE ciphertext = $1` matches nothing ever.
       This is the column that makes an equality lookup possible at all. */
    expect(blindIndex(KEY, ORG, '+14155550100')).toEqual(blindIndex(KEY, ORG, '+14155550100'));
  });

  it('differs for different values', () => {
    expect(blindIndex(KEY, ORG, '+14155550100')).not.toEqual(
      blindIndex(KEY, ORG, '+14155550101'),
    );
  });

  it('differs across orgs for the SAME value', () => {
    /* Without the namespace, an attacker reading the whole column could tell
       that a customer of tenant A is the same person as a customer of tenant B
       — a cross-tenant correlation from a column neither tenant can read. */
    expect(blindIndex(KEY, ORG, '+14155550100')).not.toEqual(
      blindIndex(KEY, OTHER_ORG, '+14155550100'),
    );
  });

  it('differs under a different key', () => {
    expect(blindIndex(KEY, ORG, '+14155550100')).not.toEqual(
      blindIndex(OTHER_KEY, ORG, '+14155550100'),
    );
  });

  it('is not reversible to the value', () => {
    const index = blindIndex(KEY, ORG, '+14155550100');
    expect(index.toString('utf8')).not.toContain('4155550100');
    expect(index.toString('hex')).not.toContain('4155550100');
  });

  it('resists the delimiter ambiguity that plain concatenation has', () => {
    /* `namespace + ':' + value` would make ("a:b", "c") and ("a", "b:c") hash
       identically. Not reachable with a UUID and an E.164 number today — the
       point is that the property holds because of how the input is built, not
       because of what today's inputs happen to contain. */
    expect(blindIndex(KEY, 'a:b', 'c')).not.toEqual(blindIndex(KEY, 'a', 'b:c'));
    expect(blindIndex(KEY, 'ab', 'c')).not.toEqual(blindIndex(KEY, 'a', 'bc'));
  });

  it('refuses a key shorter than 32 bytes', () => {
    /* A weak index fails completely silently — lookups keep working, so nothing
       ever surfaces it. */
    expect(() => blindIndex(new Uint8Array(16), ORG, '+14155550100')).toThrow(/at least 32/);
  });

  it('treats a non-canonical value as a different value', () => {
    // Why callers must parse to E.164 BEFORE indexing: this lookup would
    // silently find nothing rather than fail.
    expect(blindIndex(KEY, ORG, '+14155550100')).not.toEqual(
      blindIndex(KEY, ORG, '(415) 555-0100'),
    );
  });

  it('produces a fixed-width index regardless of input length', () => {
    expect(blindIndex(KEY, ORG, '+1').length).toBe(16);
    expect(blindIndex(KEY, ORG, `+${'1'.repeat(500)}`).length).toBe(16);
  });

  it('is independent of the ciphertext for the same value', () => {
    /* The two columns do different jobs: the ciphertext is randomized and
       unreadable, the index is deterministic and one-way. A test that confused
       them would be asserting the deterministic-encryption anti-pattern. */
    const first = encryptString(KEY, '+14155550100');
    const second = encryptString(KEY, '+14155550100');
    expect(Buffer.from(first)).not.toEqual(Buffer.from(second));
    expect(blindIndex(KEY, ORG, '+14155550100')).toEqual(blindIndex(KEY, ORG, '+14155550100'));
  });
});

describe('blindIndexEquals', () => {
  it('matches equal indexes and rejects unequal ones', () => {
    const a = blindIndex(KEY, ORG, '+14155550100');
    expect(blindIndexEquals(a, blindIndex(KEY, ORG, '+14155550100'))).toBe(true);
    expect(blindIndexEquals(a, blindIndex(KEY, ORG, '+14155550101'))).toBe(false);
  });

  it('returns false on a length mismatch rather than throwing', () => {
    // `timingSafeEqual` throws on unequal lengths, and a throw here would be a
    // 500 on an ordinary lookup miss.
    expect(blindIndexEquals(new Uint8Array(16), new Uint8Array(8))).toBe(false);
  });
});
