import { eq, schema, withGlobalScope } from '@taskflow/db';
import type { KeyProvider } from '@taskflow/contracts';

/**
 * Bootstraps the identity-scoped data key (Phase 12 Wave 2 §3.2).
 *
 * `identity.secret_keys` is a singleton — created here, at boot, the first
 * time any process finds it missing, never by a migration (which has no
 * access to `KeyProvider` or the master key a real wrap needs). Every later
 * boot, on every instance, finds the row already there and just unwraps it.
 *
 * ## The race this function has to survive
 *
 * Two API instances can both find the table empty on a cold start — the
 * ordinary case for a fresh deployment, not an edge case. `INSERT ...
 * ON CONFLICT (id) DO NOTHING` makes exactly one of them win the write;
 * the other's insert affects zero rows, and BOTH then re-SELECT the row
 * that exists — which is the winner's, whichever process that was. Neither
 * process trusts its own locally-generated key without confirming it is the
 * one actually stored, which is what makes this safe under concurrent boots
 * rather than merely usually-safe.
 */
export async function ensureIdentityDataKey(keyProvider: KeyProvider): Promise<Uint8Array> {
  const existing = await readWrappedKey();
  if (existing) return unwrap(keyProvider, existing);

  /* No encryption context: `identity.secret_keys` is a singleton with nothing
     to bind the wrap to, and — unlike a per-org key — has no column for one.
     `unwrapDataKey` below is called with none either; passing one here and
     not there is exactly the AAD mismatch that made unwrapping fail the
     first time this was written, since the context is part of what gets
     authenticated, not merely descriptive metadata. */
  const { wrapped } = await keyProvider.generateDataKey();

  await withGlobalScope(async (tx) => {
    await tx
      .insert(schema.secretKeys)
      .values({
        id: true,
        wrappedKey: Buffer.from(wrapped.wrapped),
        masterKeyId: wrapped.masterKeyId,
      })
      .onConflictDoNothing({ target: schema.secretKeys.id });
  });

  const stored = await readWrappedKey();
  if (!stored) {
    // Unreachable except by a concurrent DELETE racing this function, which
    // nothing in this system does — a loud failure here beats silently
    // generating a key that will not match what other instances unwrap.
    throw new Error('identity.secret_keys row missing immediately after insert.');
  }

  return unwrap(keyProvider, stored);
}

interface WrappedKeyRow {
  readonly wrappedKey: Buffer;
  readonly masterKeyId: string;
}

async function readWrappedKey(): Promise<WrappedKeyRow | undefined> {
  return withGlobalScope(async (tx) => {
    const rows = await tx
      .select({
        wrappedKey: schema.secretKeys.wrappedKey,
        masterKeyId: schema.secretKeys.masterKeyId,
      })
      .from(schema.secretKeys)
      .where(eq(schema.secretKeys.id, true));
    return rows[0];
  });
}

async function unwrap(keyProvider: KeyProvider, row: WrappedKeyRow): Promise<Uint8Array> {
  const { key } = await keyProvider.unwrapDataKey({
    wrapped: row.wrappedKey,
    masterKeyId: row.masterKeyId,
  });
  return key;
}
