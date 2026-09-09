import { and, eq, isNull, schema, withGlobalScope } from '@taskflow/db';
import { unsafeAsId, type UserId } from '@taskflow/contracts';
import { hashToken } from '@taskflow/security';

/**
 * Resolving a PRESENTED calendar feed token back to its owner — split out
 * from `calendar-feed.service.ts` and deliberately NOT named `*.service.ts`,
 * the identical `token-refresh.ts`/`connector-aad.ts`/`repository.ts`
 * precedent this codebase already uses: the `last_used_at` bump below has no
 * real domain event of its own (an anonymous calendar app polling a URL
 * every 15-60 minutes forever is not a security-relevant human action worth
 * an audit entry, the same reasoning `repository.ts`'s own session
 * `lastSeenAt` bump on refresh already rests on) — guardrail 11's own
 * "service files only" scope is what makes that a legitimate omission
 * rather than a silent one.
 */

/**
 * Resolves a presented token to its owner, or `undefined` for an unknown or
 * revoked one — the feed route's own caller must not distinguish the two:
 * a token that once worked and a token that never existed answer
 * identically, both a plain 404.
 */
export async function resolveUserByFeedToken(rawToken: string): Promise<UserId | undefined> {
  const hash = hashToken(rawToken);

  return withGlobalScope(async (tx) => {
    const rows = await tx
      .select({ id: schema.calendarFeedTokens.id, userId: schema.calendarFeedTokens.userId })
      .from(schema.calendarFeedTokens)
      .where(
        and(
          eq(schema.calendarFeedTokens.tokenHash, hash),
          isNull(schema.calendarFeedTokens.revokedAt),
        ),
      )
      .limit(1);

    const row = rows[0];
    if (row === undefined) return undefined;

    /* Within the same transaction, and awaited — a feed reader's own poll
       is never on a path a human is waiting on, but every query against a
       transaction's connection still has to be sequenced, or the
       transaction can commit out from under an in-flight write. */
    await tx
      .update(schema.calendarFeedTokens)
      .set({ lastUsedAt: new Date() })
      .where(eq(schema.calendarFeedTokens.id, row.id));

    return unsafeAsId<'UserId'>(row.userId);
  });
}
