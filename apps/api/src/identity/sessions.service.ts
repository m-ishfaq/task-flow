import { errors, unsafeAsId } from '@taskflow/contracts';
import { createEvent } from '@taskflow/events';
import { isPlausibleDevicePublicKey, type DevicePublicKeyCoordinates } from '@taskflow/security';
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

/**
 * Binds a device's hardware-backed public key to the CALLING session
 * (ai/phase-14-mobile.md §4.5) — `sessionId`/`userId` come from the caller's
 * own verified access token (`ctx.principal`), never from input, so there is
 * no id to guess: a caller can only ever bind a key to the session they are
 * currently running in.
 *
 * Called once, in practice, immediately after a native login succeeds.
 * `identity.refresh()` then requires a signature from this key on every
 * subsequent refresh of this session — see that function's own header for
 * why a stolen token becomes useless without it.
 *
 * Native only: a browser session already has httpOnly working for it, so
 * binding one would be inert (`refresh()`'s check only runs on the native
 * route) and confusing to reason about — refused outright rather than
 * silently accepted.
 *
 * Immutable once set: a second call with a DIFFERENT key is a conflict, not
 * an update. There is no legitimate reason for a live session's binding to
 * change, and allowing it would let a stolen access token re-point an
 * existing, already-trusted session at an attacker's own key. A second call
 * with the SAME key (a client retrying after a lost response) succeeds
 * silently and does not re-emit the domain event — `deviceKeyRegisteredAt`
 * being already-non-null on the read is what tells a retry apart from a
 * first bind, without a second round trip through `repo.bindDeviceKey`.
 */
export async function registerDeviceKey(
  deps: IdentityDeps,
  userId: string,
  sessionId: string,
  publicKey: DevicePublicKeyCoordinates,
): Promise<{ status: 'bound' }> {
  if (!isPlausibleDevicePublicKey(publicKey)) {
    throw errors.validation({ publicKey: 'Not a valid P-256 public key.' });
  }

  const session = await repo.findSessionForDeviceKey(userId, sessionId);
  // The access token that reached this route already proved the caller IS
  // this session; one that has vanished or been revoked since token issue is
  // the same "nothing left to bind" case as it not existing at all.
  if (session?.revokedAt !== null) {
    throw errors.tokenExpired();
  }

  if (session.channel !== 'native') {
    throw errors.validation({ channel: 'Device binding applies to native sessions only.' });
  }

  const alreadyBound = session.deviceKeyRegisteredAt !== null;
  const now = clock(deps);
  const bound = await repo.bindDeviceKey({
    userId,
    sessionId,
    x: publicKey.x,
    y: publicKey.y,
    now,
  });

  if (!bound) {
    throw errors.conflict('This session is already bound to a different device key.');
  }

  if (!alreadyBound) {
    await deps.events.publish([
      createEvent(
        identityEvents.deviceKeyRegistered,
        { userId, sessionId },
        { orgId: SYSTEM_ORG, actorId: unsafeAsId<'UserId'>(userId), occurredAt: now },
      ),
    ]);
  }

  return { status: 'bound' };
}
