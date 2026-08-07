import {
  and,
  coalesce,
  eq,
  gt,
  increment,
  isNull,
  schema,
  withGlobalScope,
  type GlobalDb,
} from '@taskflow/db';

/**
 * Data access for identity (PLAN.md §8.1).
 *
 * Everything here runs in `withGlobalScope` — the one scope with no tenant
 * context — because every operation happens before an organization is known: a
 * login looks a user up by email, a verification link resolves a token, a
 * refresh exchanges one. There is no org id to scope by, which is precisely why
 * these tables carry no RLS (see migration 0002).
 *
 * Kept separate from identity.service.ts on purpose. This file mutates without
 * emitting domain events, which is correct for a repository and would be a
 * guardrail 11 violation in a service — the split is what lets the lint rule be
 * strict about the place that matters.
 */

export interface UserRow {
  id: string;
  email: string;
  emailNormalized: string;
  /** Null until the person sets one — see migration 0019 on why not backfilled. */
  displayName: string | null;
  emailVerifiedAt: Date | null;
  passwordHash: string | null;
  status: string;
  failedLoginCount: number;
  lockedUntil: Date | null;
  createdAt: Date;
}

/**
 * Lowercases and trims. The whole normalization policy, deliberately.
 *
 * Stripping dots or `+suffixes` is a Gmail convention; applying it everywhere
 * merges genuinely distinct addresses at other providers, and merging two
 * people's accounts is far worse than permitting an alias.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function findUserByEmail(email: string): Promise<UserRow | undefined> {
  return withGlobalScope(async (tx) =>
    selectUser(tx, eq(schema.users.emailNormalized, normalizeEmail(email))),
  );
}

export async function findUserById(id: string): Promise<UserRow | undefined> {
  return withGlobalScope(async (tx) => selectUser(tx, eq(schema.users.id, id)));
}

async function selectUser(
  tx: GlobalDb,
  where: ReturnType<typeof eq>,
): Promise<UserRow | undefined> {
  const rows = await tx
    .select({
      id: schema.users.id,
      email: schema.users.email,
      emailNormalized: schema.users.emailNormalized,
      displayName: schema.users.displayName,
      emailVerifiedAt: schema.users.emailVerifiedAt,
      passwordHash: schema.users.passwordHash,
      status: schema.users.status,
      failedLoginCount: schema.users.failedLoginCount,
      lockedUntil: schema.users.lockedUntil,
      createdAt: schema.users.createdAt,
    })
    .from(schema.users)
    .where(where)
    .limit(1);

  return rows[0];
}

export interface CreateUserInput {
  id: string;
  email: string;
  passwordHash: string;
  verification: { id: string; tokenHash: string; expiresAt: Date };
}

/**
 * Creates a user and its verification link in ONE transaction.
 *
 * If these were separate commits, a crash between them leaves an account that
 * can never be verified and whose email address is taken — unrecoverable
 * without operator intervention, and indistinguishable from a user who simply
 * lost the mail.
 *
 * Returns undefined when the address is already registered. That is detected by
 * the unique index rather than by a preceding SELECT: two concurrent signups for
 * the same address both pass a check-then-insert, and only the constraint is
 * actually atomic.
 */
export async function createUser(input: CreateUserInput): Promise<UserRow | undefined> {
  return withGlobalScope(async (tx) => {
    const inserted = await tx
      .insert(schema.users)
      .values({
        id: input.id,
        email: input.email.trim(),
        emailNormalized: normalizeEmail(input.email),
        passwordHash: input.passwordHash,
        passwordUpdatedAt: new Date(),
      })
      .onConflictDoNothing({ target: schema.users.emailNormalized })
      .returning({ id: schema.users.id });

    if (inserted.length === 0) return undefined;

    await tx.insert(schema.emailVerifications).values({
      id: input.verification.id,
      userId: input.id,
      email: normalizeEmail(input.email),
      tokenHash: input.verification.tokenHash,
      expiresAt: input.verification.expiresAt,
    });

    return selectUser(tx, eq(schema.users.id, input.id));
  });
}

export interface VerificationRow {
  id: string;
  userId: string;
  email: string;
  expiresAt: Date;
  consumedAt: Date | null;
}

/**
 * Consumes a verification link and marks the address verified.
 *
 * The UPDATE carries `consumed_at IS NULL` in its WHERE clause rather than
 * checking first and updating after. Two clicks on the same link — a mail
 * client prefetching, a double tap — race, and only the conditional update
 * makes exactly one of them win.
 */
export async function consumeEmailVerification(
  tokenHash: string,
  now: Date,
): Promise<VerificationRow | undefined> {
  return withGlobalScope(async (tx) => {
    const claimed = await tx
      .update(schema.emailVerifications)
      .set({ consumedAt: now })
      .where(
        and(
          eq(schema.emailVerifications.tokenHash, tokenHash),
          isNull(schema.emailVerifications.consumedAt),
          gt(schema.emailVerifications.expiresAt, now),
        ),
      )
      .returning({
        id: schema.emailVerifications.id,
        userId: schema.emailVerifications.userId,
        email: schema.emailVerifications.email,
        expiresAt: schema.emailVerifications.expiresAt,
        consumedAt: schema.emailVerifications.consumedAt,
      });

    const row = claimed[0];
    if (!row) return undefined;

    // Only verify the address the link was issued FOR. If the user changed their
    // email after requesting it, an old link must not confirm the new one.
    await tx
      .update(schema.users)
      .set({ emailVerifiedAt: now, updatedAt: now })
      .where(and(eq(schema.users.id, row.userId), eq(schema.users.emailNormalized, row.email)));

    return row;
  });
}

export async function recordFailedLogin(
  userId: string,
  lockThreshold: number,
  lockFor: number,
  now: Date,
): Promise<{ failedLoginCount: number; lockedUntil: Date | null } | undefined> {
  return withGlobalScope(async (tx) => {
    // The count is incremented BY THE DATABASE, not read-modify-written here.
    // Parallel guesses against one account would otherwise each read the same
    // value and write back the same value, so the lockout would never trigger
    // under exactly the load it exists to stop.
    const updated = await tx
      .update(schema.users)
      .set({ failedLoginCount: increment(schema.users.failedLoginCount), updatedAt: now })
      .where(eq(schema.users.id, userId))
      .returning({
        failedLoginCount: schema.users.failedLoginCount,
        lockedUntil: schema.users.lockedUntil,
      });

    const state = updated[0];
    if (!state) return undefined;

    if (state.failedLoginCount < lockThreshold) return state;

    // Second statement, same transaction. The threshold comparison uses the
    // count the database just produced, so it is still immune to the interleave
    // above — and expressing it here rather than as a SQL CASE keeps the
    // decision readable.
    const lockedUntil = new Date(now.getTime() + lockFor);
    await tx
      .update(schema.users)
      .set({ lockedUntil, updatedAt: now })
      .where(eq(schema.users.id, userId));

    return { failedLoginCount: state.failedLoginCount, lockedUntil };
  });
}

export async function clearLoginFailures(userId: string, now: Date): Promise<void> {
  await withGlobalScope(async (tx) => {
    await tx
      .update(schema.users)
      .set({ failedLoginCount: 0, lockedUntil: null, updatedAt: now })
      .where(eq(schema.users.id, userId));
  });
}

export interface CreateSessionInput {
  sessionId: string;
  userId: string;
  authenticatedAt: Date;
  expiresAt: Date;
  ip: string | null;
  userAgent: string | null;
  refreshToken: { id: string; tokenHash: string; expiresAt: Date };
}

export async function createSession(input: CreateSessionInput): Promise<void> {
  await withGlobalScope(async (tx) => {
    await tx.insert(schema.sessions).values({
      id: input.sessionId,
      userId: input.userId,
      authenticatedAt: input.authenticatedAt,
      expiresAt: input.expiresAt,
      ip: input.ip,
      userAgent: input.userAgent,
    });

    await tx.insert(schema.refreshTokens).values({
      id: input.refreshToken.id,
      sessionId: input.sessionId,
      userId: input.userId,
      tokenHash: input.refreshToken.tokenHash,
      expiresAt: input.refreshToken.expiresAt,
    });
  });
}

export interface RefreshLookup {
  tokenId: string;
  sessionId: string;
  userId: string;
  tokenExpiresAt: Date;
  rotatedAt: Date | null;
  sessionRevokedAt: Date | null;
  sessionExpiresAt: Date;
  authenticatedAt: Date;
}

export async function findRefreshToken(tokenHash: string): Promise<RefreshLookup | undefined> {
  return withGlobalScope(async (tx) => {
    const rows = await tx
      .select({
        tokenId: schema.refreshTokens.id,
        sessionId: schema.refreshTokens.sessionId,
        userId: schema.refreshTokens.userId,
        tokenExpiresAt: schema.refreshTokens.expiresAt,
        rotatedAt: schema.refreshTokens.rotatedAt,
        sessionRevokedAt: schema.sessions.revokedAt,
        sessionExpiresAt: schema.sessions.expiresAt,
        authenticatedAt: schema.sessions.authenticatedAt,
      })
      .from(schema.refreshTokens)
      .innerJoin(schema.sessions, eq(schema.sessions.id, schema.refreshTokens.sessionId))
      .where(eq(schema.refreshTokens.tokenHash, tokenHash))
      .limit(1);

    return rows[0];
  });
}

/**
 * Exchanges one refresh token for the next, atomically.
 *
 * Returns false when the presented token was already rotated. The conditional
 * UPDATE is what makes that reliable: two requests carrying the same token race,
 * and without `rotated_at IS NULL` in the WHERE clause both would succeed and
 * issue two valid chains from one token — which is the exact condition reuse
 * detection exists to catch, missed by the mechanism meant to catch it.
 */
export async function rotateRefreshToken(input: {
  presentedTokenId: string;
  sessionId: string;
  userId: string;
  next: { id: string; tokenHash: string; expiresAt: Date };
  now: Date;
}): Promise<boolean> {
  return withGlobalScope(async (tx) => {
    const claimed = await tx
      .update(schema.refreshTokens)
      .set({ rotatedAt: input.now })
      .where(
        and(
          eq(schema.refreshTokens.id, input.presentedTokenId),
          isNull(schema.refreshTokens.rotatedAt),
        ),
      )
      .returning({ id: schema.refreshTokens.id });

    if (claimed.length === 0) return false;

    await tx.insert(schema.refreshTokens).values({
      id: input.next.id,
      sessionId: input.sessionId,
      userId: input.userId,
      tokenHash: input.next.tokenHash,
      expiresAt: input.next.expiresAt,
    });

    await tx
      .update(schema.sessions)
      .set({ lastSeenAt: input.now })
      .where(eq(schema.sessions.id, input.sessionId));

    return true;
  });
}

export async function revokeSession(sessionId: string, reason: string, now: Date): Promise<void> {
  await withGlobalScope(async (tx) => {
    await tx
      .update(schema.sessions)
      .set({ revokedAt: now, revokedReason: reason })
      .where(and(eq(schema.sessions.id, sessionId), isNull(schema.sessions.revokedAt)));
  });
}

/** Revokes every live session for a user. Returns the ids that were revoked. */
export async function revokeAllSessions(
  userId: string,
  reason: string,
  now: Date,
): Promise<string[]> {
  return withGlobalScope(async (tx) => {
    const revoked = await tx
      .update(schema.sessions)
      .set({ revokedAt: now, revokedReason: reason })
      .where(and(eq(schema.sessions.userId, userId), isNull(schema.sessions.revokedAt)))
      .returning({ id: schema.sessions.id });

    return revoked.map((row) => row.id);
  });
}

export async function createPasswordReset(input: {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  ip: string | null;
}): Promise<void> {
  await withGlobalScope(async (tx) => {
    await tx.insert(schema.passwordResets).values({
      id: input.id,
      userId: input.userId,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
      requestedIp: input.ip,
    });
  });
}

/**
 * Consumes a reset link and sets the new password, in one transaction.
 *
 * Same conditional-claim shape as email verification, for the same reason: the
 * link must be usable exactly once even when two requests arrive together.
 */
export async function consumePasswordReset(input: {
  tokenHash: string;
  passwordHash: string;
  now: Date;
}): Promise<{ userId: string } | undefined> {
  return withGlobalScope(async (tx) => {
    const claimed = await tx
      .update(schema.passwordResets)
      .set({ consumedAt: input.now })
      .where(
        and(
          eq(schema.passwordResets.tokenHash, input.tokenHash),
          isNull(schema.passwordResets.consumedAt),
          gt(schema.passwordResets.expiresAt, input.now),
        ),
      )
      .returning({ userId: schema.passwordResets.userId });

    const row = claimed[0];
    if (!row) return undefined;

    await tx
      .update(schema.users)
      .set({
        passwordHash: input.passwordHash,
        passwordUpdatedAt: input.now,
        // A completed reset proves control of the mailbox, so it also verifies
        // the address. Requiring a separate confirmation afterwards would strand
        // anyone who never received the original verification mail.
        emailVerifiedAt: coalesce(schema.users.emailVerifiedAt, input.now),
        failedLoginCount: 0,
        lockedUntil: null,
        updatedAt: input.now,
      })
      .where(eq(schema.users.id, row.userId));

    return row;
  });
}

/**
 * Sets or clears a user's display name (migration 0019).
 *
 * Returns the stored value, so a caller emitting an event records what the
 * database actually holds rather than what was submitted — the two differ by a
 * trim, and an event carrying the untrimmed string would make the audit log
 * disagree with the row it describes.
 *
 * Null clears it, which is a real operation: someone removing their name goes
 * back to being shown by address, and there is no other way to express that.
 */
export async function updateDisplayName(
  userId: string,
  displayName: string | null,
): Promise<string | null> {
  /* Trimmed here rather than relying on the CHECK constraint to refuse a blank
     one. The constraint is the backstop — it turns "  " into a failed write
     instead of a name that renders as an empty gap — but a name with trailing
     whitespace is not an error, it is a typo, and refusing the whole save for
     it would be hostile. */
  const trimmed = displayName === null ? null : displayName.trim();
  const value = trimmed === '' ? null : trimmed;

  await withGlobalScope(async (tx) =>
    tx
      .update(schema.users)
      .set({ displayName: value, updatedAt: new Date() })
      .where(eq(schema.users.id, userId)),
  );

  return value;
}
