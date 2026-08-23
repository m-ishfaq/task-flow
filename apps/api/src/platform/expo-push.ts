import { and, desc, eq, schema, withUserScope } from '@taskflow/db';
import { AppError, type UserId } from '@taskflow/contracts';
import { newId } from '@taskflow/security';

/**
 * Native mobile push token registration (Phase 14 §9, ai/phase-14-mobile.md).
 * `push.ts`'s counterpart for `apps/mobile` — same shape, different device
 * identifier.
 *
 * ## Global per user, like `push.ts`
 *
 * A token belongs to a PERSON, not an org — the same reason `push.ts`'s
 * subscriptions and `identity.notification_prefs` are global — so this runs
 * under `withUserScope`, keyed on the verified principal's own id. RLS
 * (`expo_push_tokens_self_*`, migration 0082) enforces "own rows only" at
 * the database; the `userId` predicates below are the service's half, the
 * same belt-and-braces pattern `push.ts` documents for its own reads.
 *
 * ## No endpoint to validate
 *
 * `push.ts`'s `assertSafeEndpoint` exists because a web-push subscription
 * hands the server a URL it will later POST to — an SSRF surface. An Expo
 * push token names no address at all: every send goes to Expo's own fixed
 * API host, and the token is meaningless to anyone without Expo's own
 * credentials for THIS project. The only thing worth validating here is
 * shape, so a typo or a garbage string fails at registration instead of
 * silently producing dead sends the relay retries forever.
 */

/** `ExponentPushToken[...]` or `ExpoPushToken[...]` — Expo's two historical token prefixes. */
const EXPO_PUSH_TOKEN_PATTERN = /^Expo(?:nent)?PushToken\[[^\]]+\]$/;

/** Shape-only check — the token is opaque to us; Expo's own relay is the only party that can confirm it names a real device. */
export function isValidExpoPushToken(token: string): boolean {
  return EXPO_PUSH_TOKEN_PATTERN.test(token);
}

export interface ExpoPushTokenRow {
  readonly tokenId: string;
  readonly expoPushToken: string;
  readonly deviceLabel: string | null;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
}

export interface RegisterExpoPushTokenInput {
  readonly expoPushToken: string;
  readonly deviceLabel: string | null;
}

/** Registers (or refreshes) one device row. Idempotent per (user, token). */
export async function registerExpoPushToken(
  userId: UserId,
  input: RegisterExpoPushTokenInput,
): Promise<{ readonly registered: true }> {
  if (!isValidExpoPushToken(input.expoPushToken)) {
    throw new AppError('VALIDATION_FAILED', 'That does not look like an Expo push token.');
  }

  return withUserScope(userId, async (tx) => {
    await tx
      .insert(schema.expoPushTokens)
      .values({
        id: newId<'ExpoPushTokenId'>(),
        userId,
        expoPushToken: input.expoPushToken,
        deviceLabel: input.deviceLabel,
      })
      /* The same device re-registering (a reinstall, a token Expo rotated)
         refreshes the row rather than duplicating it. last_seen_at is
         bumped because registration is proof the device is alive. */
      .onConflictDoUpdate({
        target: [schema.expoPushTokens.userId, schema.expoPushTokens.expoPushToken],
        set: { deviceLabel: input.deviceLabel, lastSeenAt: new Date() },
      });

    return { registered: true as const };
  });
}

/** The caller's own device rows — the same seed Phase 12's device screen reads for `push.ts`'s subscriptions. */
export async function listExpoPushTokens(userId: UserId): Promise<readonly ExpoPushTokenRow[]> {
  return withUserScope(userId, async (tx) => {
    const rows = await tx
      .select({
        tokenId: schema.expoPushTokens.id,
        expoPushToken: schema.expoPushTokens.expoPushToken,
        deviceLabel: schema.expoPushTokens.deviceLabel,
        createdAt: schema.expoPushTokens.createdAt,
        lastSeenAt: schema.expoPushTokens.lastSeenAt,
      })
      .from(schema.expoPushTokens)
      .where(eq(schema.expoPushTokens.userId, userId))
      .orderBy(desc(schema.expoPushTokens.lastSeenAt));

    return rows;
  });
}

/** Removes one of the caller's own device rows. Idempotent. */
export async function unregisterExpoPushToken(
  userId: UserId,
  tokenId: string,
): Promise<{ readonly removed: number }> {
  return withUserScope(userId, async (tx) => {
    const removed = await tx
      .delete(schema.expoPushTokens)
      .where(and(eq(schema.expoPushTokens.id, tokenId), eq(schema.expoPushTokens.userId, userId)))
      .returning({ id: schema.expoPushTokens.id });

    return { removed: removed.length };
  });
}
