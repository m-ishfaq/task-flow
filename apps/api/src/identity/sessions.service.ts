import { unsafeAsId } from '@taskflow/contracts';
import { createEvent } from '@taskflow/events';
import * as repo from './repository.js';
import * as identityEvents from './events.js';
import { listSubscriptions, parseUserAgentLabel } from '../platform/push.js';
import { SYSTEM_ORG, type IdentityDeps, type RequestMeta } from './identity.service.js';

/**
 * Device/session inventory (Phase 12 Wave 2 §3.4).
 *
 * "A device" in this UI is an ACTIVE SESSION — the honest unit the system
 * already tracks (`identity.sessions`), rather than a fingerprinting
 * exercise over data that does not exist. Push capability joins in from
 * `platform.push_subscriptions`, which is user-scoped rather than
 * session-scoped (Phase 9 §3.7), so the honest fact it can contribute is
 * "push is registered on N devices", not "this exact session has push".
 *
 * Both routes are `selfRoute`: there is no org permission that describes
 * listing your own sign-ins, and the page must answer with no org selected
 * — that is the whole point of `/account`. `revoke` is additionally
 * `stepUp: true`, the single-device version of `logoutEverywhere`'s own
 * protection: ending a session is exactly what someone holding a stolen
 * one would do to clear evidence or lock the owner out.
 */

const clock = (deps: IdentityDeps): Date => (deps.now ?? (() => new Date()))();

export interface SessionView {
  readonly id: string;
  /** A human label from the user-agent, e.g. "Chrome on macOS"; null when unparsable. */
  readonly label: string | null;
  readonly ip: string | null;
  readonly authenticatedAt: Date;
  readonly lastSeenAt: Date;
  /** Whether this is the session the request is running in. */
  readonly isCurrent: boolean;
  readonly country: string | null;
  /** Set when impossible-travel detection flagged this sign-in (§3.4). */
  readonly flagged: boolean;
}

export interface SessionsList {
  readonly sessions: readonly SessionView[];
  /** How many devices have web-push registered — the honest per-USER fact available. */
  readonly pushDeviceCount: number;
}

export async function list(
  deps: IdentityDeps,
  userId: string,
  currentSessionId: string,
): Promise<SessionsList> {
  const [rows, push] = await Promise.all([
    repo.listSessions(userId),
    listSubscriptions(unsafeAsId<'UserId'>(userId)),
  ]);

  return {
    sessions: rows.map((row) => ({
      id: row.id,
      label: parseUserAgentLabel(row.userAgent),
      ip: row.ip,
      authenticatedAt: row.authenticatedAt,
      lastSeenAt: row.lastSeenAt,
      isCurrent: row.id === currentSessionId,
      country: row.country,
      flagged: row.impossibleTravelAt !== null,
    })),
    pushDeviceCount: push.length,
  };
}

/**
 * Revokes ONE of the caller's own sessions by id — the per-device sign-out
 * the account page did not have before (§3.4).
 *
 * A session id that is not the caller's (or already revoked) revokes
 * nothing and still answers the same way: the authorization is the
 * `user_id` predicate in the repository, and the caller never learns
 * whether a guessed id was ever real.
 */
export async function revoke(
  deps: IdentityDeps,
  userId: string,
  sessionId: string,
  meta: RequestMeta,
): Promise<{ status: 'revoked' }> {
  const now = clock(deps);
  const revoked = await repo.revokeSessionForUser(userId, sessionId, 'logout', now);

  if (revoked) {
    await deps.events.publish([
      createEvent(
        identityEvents.sessionRevoked,
        { userId, sessionId, reason: 'logout' as const },
        { orgId: SYSTEM_ORG, actorId: unsafeAsId<'UserId'>(userId), occurredAt: now },
      ),
    ]);
  }

  void meta;
  return { status: 'revoked' };
}
