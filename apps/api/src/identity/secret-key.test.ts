import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDatabase, initializeDatabase } from '@taskflow/db';
import { connectAsMigrator } from '@taskflow/db/testing';
import { masterKeysFromBase64, SoftwareKeyProvider } from '@taskflow/security';
import { ensureIdentityDataKey } from './secret-key.js';
import { TEST_ENV } from '../testing/fixtures.js';

/**
 * `ensureIdentityDataKey`'s get-or-create dance, against real Postgres
 * (Phase 12 Wave 2 §3.2) — the first real `KeyProvider` consumer in this
 * codebase, so nothing anywhere else already proves this round trip.
 *
 * The wrap/unwrap mismatch this suite would have caught: `generateDataKey`
 * was originally called with an encryption context (`{ purpose:
 * 'identity-secrets' }`) that was never persisted alongside the wrapped key,
 * so every unwrap after the first process restart failed — `identity.
 * secret_keys` has no column for it, and `unwrapDataKey` was called with
 * none. A unit test against a stub `KeyProvider` would not have found this;
 * the bug is in what the REAL `SoftwareKeyProvider`'s AAD covers, and the two
 * calls not agreeing on it only shows up decrypting for real.
 */

function provider(): SoftwareKeyProvider {
  return new SoftwareKeyProvider({
    masterKeys: masterKeysFromBase64({ [TEST_ENV.MASTER_KEY_ID]: TEST_ENV.MASTER_KEY_BASE64 }),
    currentMasterKeyId: TEST_ENV.MASTER_KEY_ID,
  });
}

beforeAll(() => {
  initializeDatabase({ url: TEST_ENV.DATABASE_URL, applicationName: 'secret-key-test' });
});

afterAll(async () => {
  await closeDatabase();
});

beforeEach(async () => {
  const admin = await connectAsMigrator();
  await admin.query('DELETE FROM identity.secret_keys');
  await admin.end();
});

describe('ensureIdentityDataKey', () => {
  it('generates and persists a key on a cold start', async () => {
    const key = await ensureIdentityDataKey(provider());

    expect(key).toBeInstanceOf(Uint8Array);
    expect(key).toHaveLength(32);
  });

  it('unwraps the same key on a later boot, not a fresh one', async () => {
    const first = await ensureIdentityDataKey(provider());
    // A distinct `SoftwareKeyProvider` instance, as a separate process
    // restart would construct — proves the row, not an in-memory cache, is
    // what makes the second call agree with the first.
    const second = await ensureIdentityDataKey(provider());

    expect(Buffer.from(second)).toEqual(Buffer.from(first));
  });

  it('converges two concurrent cold starts on one key', async () => {
    // Two instances racing to bootstrap the singleton row — the ordinary case
    // for a fresh deployment with more than one replica, not an edge case.
    const [a, b] = await Promise.all([
      ensureIdentityDataKey(provider()),
      ensureIdentityDataKey(provider()),
    ]);

    expect(Buffer.from(b)).toEqual(Buffer.from(a));

    const admin = await connectAsMigrator();
    const { rows } = await admin.query('SELECT count(*)::int AS count FROM identity.secret_keys');
    await admin.end();
    expect((rows[0] as { count: number }).count).toBe(1);
  });
});
