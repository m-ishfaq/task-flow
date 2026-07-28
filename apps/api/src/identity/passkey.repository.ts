import { and, eq, gt, isNull, lt, schema, withGlobalScope } from '@taskflow/db';

/**
 * Data access for passkeys (PLAN.md §8.1).
 *
 * Same position as repository.ts: `withGlobalScope` because none of this is
 * tenant-scoped, and no domain events because that is the service's job
 * (guardrail 11).
 */

export interface CredentialRow {
  id: string;
  userId: string;
  credentialId: string;
  publicKey: Uint8Array;
  signCount: number;
  transports: string[];
  deviceType: string;
  backedUp: boolean;
  name: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
}

export async function createChallenge(input: {
  id: string;
  challenge: string;
  userId: string | null;
  purpose: 'registration' | 'authentication';
  expiresAt: Date;
}): Promise<void> {
  await withGlobalScope(async (tx) => {
    await tx.insert(schema.webauthnChallenges).values({
      id: input.id,
      challenge: input.challenge,
      userId: input.userId,
      purpose: input.purpose,
      expiresAt: input.expiresAt,
    });
  });
}

export interface ConsumedChallenge {
  challenge: string;
  userId: string | null;
}

/**
 * Claims a challenge, exactly once.
 *
 * The conditional UPDATE is the whole mechanism. A replayed WebAuthn assertion
 * is a complete authentication bypass, and `SELECT ... then DELETE` lets two
 * concurrent requests both see an unconsumed row — so the property has to be
 * enforced by the database, not by the order of two statements.
 *
 * `purpose` is in the WHERE clause so a sign-in challenge cannot be redeemed as
 * an enrollment, or the reverse.
 */
export async function consumeChallenge(input: {
  challenge: string;
  purpose: 'registration' | 'authentication';
  now: Date;
}): Promise<ConsumedChallenge | undefined> {
  return withGlobalScope(async (tx) => {
    const claimed = await tx
      .update(schema.webauthnChallenges)
      .set({ consumedAt: input.now })
      .where(
        and(
          eq(schema.webauthnChallenges.challenge, input.challenge),
          eq(schema.webauthnChallenges.purpose, input.purpose),
          isNull(schema.webauthnChallenges.consumedAt),
          gt(schema.webauthnChallenges.expiresAt, input.now),
        ),
      )
      .returning({
        challenge: schema.webauthnChallenges.challenge,
        userId: schema.webauthnChallenges.userId,
      });

    return claimed[0];
  });
}

export async function listCredentials(userId: string): Promise<CredentialRow[]> {
  return withGlobalScope(async (tx) =>
    tx
      .select()
      .from(schema.webauthnCredentials)
      .where(eq(schema.webauthnCredentials.userId, userId)),
  );
}

export async function countCredentials(userId: string): Promise<number> {
  const rows = await listCredentials(userId);
  return rows.length;
}

/**
 * Finds a credential by the id the authenticator reported.
 *
 * No user id in the lookup, because sign-in does not know who is authenticating
 * until this returns — that is the point of discoverable credentials, and it is
 * what keeps the login page from being an account-existence oracle.
 */
export async function findCredential(credentialId: string): Promise<CredentialRow | undefined> {
  return withGlobalScope(async (tx) => {
    const rows = await tx
      .select()
      .from(schema.webauthnCredentials)
      .where(eq(schema.webauthnCredentials.credentialId, credentialId))
      .limit(1);

    return rows[0];
  });
}

export interface CreateCredentialInput {
  id: string;
  userId: string;
  credentialId: string;
  publicKey: Uint8Array;
  signCount: number;
  transports: string[];
  aaguid: string | null;
  deviceType: string;
  backedUp: boolean;
  name: string | null;
}

/**
 * Stores a newly enrolled credential.
 *
 * Returns false when the credential id is already registered — detected by the
 * unique index rather than by a preceding SELECT, because two concurrent
 * enrollments of the same authenticator both pass a check-then-insert and only
 * the constraint is atomic. A credential id belongs to one key pair globally,
 * so a duplicate means either a bug or an attempt to bind someone else's key.
 */
export async function createCredential(input: CreateCredentialInput): Promise<boolean> {
  return withGlobalScope(async (tx) => {
    const inserted = await tx
      .insert(schema.webauthnCredentials)
      .values({
        id: input.id,
        userId: input.userId,
        credentialId: input.credentialId,
        publicKey: input.publicKey,
        signCount: input.signCount,
        transports: input.transports,
        aaguid: input.aaguid,
        deviceType: input.deviceType,
        backedUp: input.backedUp,
        name: input.name,
      })
      .onConflictDoNothing({ target: schema.webauthnCredentials.credentialId })
      .returning({ id: schema.webauthnCredentials.id });

    return inserted.length > 0;
  });
}

/**
 * Records a successful assertion.
 *
 * The counter update is conditional on the new value being HIGHER. The library
 * already rejects a regression, but persisting it unconditionally would mean a
 * request that lost a race could write a stale count back and re-open the
 * window the check exists to close.
 */
export async function recordCredentialUse(input: {
  credentialId: string;
  signCount: number;
  now: Date;
}): Promise<void> {
  await withGlobalScope(async (tx) => {
    await tx
      .update(schema.webauthnCredentials)
      .set({ signCount: input.signCount })
      .where(
        and(
          eq(schema.webauthnCredentials.credentialId, input.credentialId),
          lt(schema.webauthnCredentials.signCount, input.signCount),
        ),
      );

    // `last_used_at` should move even when the counter does not — a platform
    // authenticator that always reports 0 is normal, and a passkey that never
    // appears to have been used is confusing in the list a user sees.
    await tx
      .update(schema.webauthnCredentials)
      .set({ lastUsedAt: input.now })
      .where(eq(schema.webauthnCredentials.credentialId, input.credentialId));
  });
}

/** Renames a credential, scoped to its owner so one user cannot label another's. */
export async function renameCredential(input: {
  id: string;
  userId: string;
  name: string;
}): Promise<boolean> {
  return withGlobalScope(async (tx) => {
    const updated = await tx
      .update(schema.webauthnCredentials)
      .set({ name: input.name })
      .where(
        and(
          eq(schema.webauthnCredentials.id, input.id),
          eq(schema.webauthnCredentials.userId, input.userId),
        ),
      )
      .returning({ id: schema.webauthnCredentials.id });

    return updated.length > 0;
  });
}

/** Deletes a credential, scoped to its owner. */
export async function deleteCredential(input: { id: string; userId: string }): Promise<boolean> {
  return withGlobalScope(async (tx) => {
    const deleted = await tx
      .delete(schema.webauthnCredentials)
      .where(
        and(
          eq(schema.webauthnCredentials.id, input.id),
          eq(schema.webauthnCredentials.userId, input.userId),
        ),
      )
      .returning({ id: schema.webauthnCredentials.id });

    return deleted.length > 0;
  });
}

/**
 * Deletes challenges that have expired.
 *
 * Not merely housekeeping: an unbounded table of one-time values is a table
 * whose index degrades until the ceremony it supports gets slow, and slow
 * authentication is the kind of problem that gets diagnosed as something else.
 */
export async function purgeExpiredChallenges(now: Date): Promise<number> {
  return withGlobalScope(async (tx) => {
    const deleted = await tx
      .delete(schema.webauthnChallenges)
      .where(lt(schema.webauthnChallenges.expiresAt, now))
      .returning({ id: schema.webauthnChallenges.id });

    return deleted.length;
  });
}
