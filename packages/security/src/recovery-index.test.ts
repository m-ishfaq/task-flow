import { describe, expect, it } from 'vitest';
import { blindIndex } from './blind-index.js';
import { recoveryCodeIndex } from './recovery-index.js';

/** A deterministic 32-byte key stand-in — the identity data key is 32 bytes. */
const KEY = new Uint8Array(32).fill(7);
const OTHER_KEY = new Uint8Array(32).fill(9);

describe('recoveryCodeIndex', () => {
  it('is deterministic for the same key, user, and code', () => {
    const a = recoveryCodeIndex(KEY, 'user-1', 'ABCD-EFGH-JKLM');
    const b = recoveryCodeIndex(KEY, 'user-1', 'ABCD-EFGH-JKLM');
    expect(a.equals(b)).toBe(true);
  });

  it('differs for different codes', () => {
    const a = recoveryCodeIndex(KEY, 'user-1', 'ABCD-EFGH-JKLM');
    const b = recoveryCodeIndex(KEY, 'user-1', 'ZZZZ-EFGH-JKLM');
    expect(a.equals(b)).toBe(false);
  });

  it('namespaces by user, so the same code in two accounts is unrelated', () => {
    // This is the property that keeps the index column from revealing a shared
    // code across accounts even before the SQL user_id filter runs.
    const a = recoveryCodeIndex(KEY, 'user-1', 'ABCD-EFGH-JKLM');
    const b = recoveryCodeIndex(KEY, 'user-2', 'ABCD-EFGH-JKLM');
    expect(a.equals(b)).toBe(false);
  });

  it('depends on the key — a different data key yields an unrelated index', () => {
    // A stolen index column is inert without the key; changing the key must
    // change the index, or the "keyed" claim is empty.
    const a = recoveryCodeIndex(KEY, 'user-1', 'ABCD-EFGH-JKLM');
    const b = recoveryCodeIndex(OTHER_KEY, 'user-1', 'ABCD-EFGH-JKLM');
    expect(a.equals(b)).toBe(false);
  });

  it('does NOT equal the raw-key blind index of the same inputs', () => {
    // The index key is derived from the data key, not the data key itself, so
    // the recovery index must differ from a blind index computed with the data
    // key directly — that derivation is the AES/HMAC key separation.
    const derived = recoveryCodeIndex(KEY, 'user-1', 'ABCD-EFGH-JKLM');
    const raw = blindIndex(KEY, 'user-1', 'ABCD-EFGH-JKLM');
    expect(derived.equals(raw)).toBe(false);
  });

  it('produces a 16-byte index', () => {
    // blindIndex truncates to 16 bytes; recovery inherits that.
    expect(recoveryCodeIndex(KEY, 'user-1', 'ABCD-EFGH-JKLM')).toHaveLength(16);
  });
});
