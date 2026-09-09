import { and, eq, isNull, schema, withGlobalScope } from '@taskflow/db';
import { unsafeAsId, type UserId } from '@taskflow/contracts';
import { createEvent } from '@taskflow/events';
import { issueToken, newId } from '@taskflow/security';
import { calendarFeedTokenMinted } from './events.js';
import { SYSTEM_ORG, type IdentityDeps } from './identity.service.js';

/**
 * The calendar feed's own bearer token (migration 0110) — `TOKEN_PREFIX
 * .shareLink`'s first real caller, reserved since `packages/security/
 * tokens.ts` was written and never used until now.
 *
 * ⚠ A genuinely new security-surface CLASS for this codebase: a public,
 * no-session, long-lived bearer token embedded in a URL, which
 * `docs.public.getPage`'s own design explicitly reasoned AGAINST for public
 * reads (re-validated RLS-scoped access, never a bearer capability). Chosen
 * here as a deliberate, disclosed exception — a calendar app has no session
 * to present, only a URL it polls — accepted by the project owner after the
 * tradeoff was laid out via `AskUserQuestion`, mitigated by a minimal feed
 * (no card description/body, see `work/calendar-feed.service.ts`) and by
 * `identity.calendar_feed_tokens` carrying no `org_id` at all — no RLS to
 * misconfigure, because there is nothing here for RLS to scope.
 *
 * `withGlobalScope` is used throughout, same as every other pre-tenant
 * lookup (`resolveOrgByInvitationToken`) — there is no org context yet
 * when a bare token is all that has been presented.
 *
 * Resolving a PRESENTED token back to its owner (`resolveUserByFeedToken`)
 * lives in the sibling `calendar-feed-tokens.ts`, deliberately NOT named
 * `*.service.ts` — the identical `token-refresh.ts`/`repository.ts`
 * precedent this codebase already uses for a housekeeping write
 * (`last_used_at`, bumped on every anonymous feed poll) that has no real
 * domain event of its own to emit, the same reasoning `repository.ts`'s
 * own `lastSeenAt` bump on session refresh already relies on.
 */

/** Whether the caller has an active feed token, without exposing anything about it. */
export async function hasActiveFeedToken(userId: UserId): Promise<boolean> {
  return withGlobalScope(async (tx) => {
    const rows = await tx
      .select({ id: schema.calendarFeedTokens.id })
      .from(schema.calendarFeedTokens)
      .where(
        and(
          eq(schema.calendarFeedTokens.userId, userId),
          isNull(schema.calendarFeedTokens.revokedAt),
        ),
      )
      .limit(1);
    return rows.length > 0;
  });
}

export interface CalendarFeedDeps {
  readonly events: IdentityDeps['events'];
  readonly now?: IdentityDeps['now'];
  readonly webOrigin: string;
}

/**
 * Mints a fresh feed URL, revoking any existing active token for this user
 * first — "get one" and "rotate" are the same operation here: there is
 * nothing meaningful to return for an already-active token (the raw value
 * was never stored), so every call produces a genuinely new one.
 *
 * The URL, not the bare token, is what the caller actually needs — building
 * it here keeps `env.WEB_ORIGIN` out of the frontend and matches the
 * "shown once, never again" contract this codebase already uses for a
 * GitHub connector's verify secret and TOTP recovery codes.
 */
export async function mintFeedUrl(
  deps: CalendarFeedDeps,
  userId: UserId,
): Promise<{ readonly url: string }> {
  const issued = issueToken('shareLink');
  const now = (deps.now ?? (() => new Date()))();

  await withGlobalScope(async (tx) => {
    await tx
      .update(schema.calendarFeedTokens)
      .set({ revokedAt: now })
      .where(
        and(
          eq(schema.calendarFeedTokens.userId, userId),
          isNull(schema.calendarFeedTokens.revokedAt),
        ),
      );

    await tx.insert(schema.calendarFeedTokens).values({
      id: newId<'CalendarFeedTokenId'>(),
      userId,
      tokenHash: issued.hash,
    });
  });

  /* Published through the injected EventBus rather than the transactional
     outbox, the identical shape `totp.service.ts`'s own enroll/disable
     already use — this runs under `withGlobalScope`, which has no org
     transaction for an outbox row to share, and `SYSTEM_ORG` is the same
     sentinel every other identity-scoped event already carries. */
  await deps.events.publish([
    createEvent(
      calendarFeedTokenMinted,
      { userId },
      { orgId: SYSTEM_ORG, actorId: unsafeAsId<'UserId'>(userId), occurredAt: now },
    ),
  ]);

  return { url: `${deps.webOrigin}/calendar/${issued.token}.ics` };
}
