import { withOrgScope } from '@taskflow/db';
import type { ChannelId, OrgId, UserId } from '@taskflow/contracts';
import { loadSession } from '@taskflow/api/rtc/session';
import { authorizeChannelJoin, type JoinAuthorization } from './rooms.js';

/**
 * Call-room authorization (ai/phase-13-webrtc.md §1).
 *
 * ## This file is deliberately almost empty, and that IS the phase
 *
 * §1: "A call room authorizes exactly like a channel room." `authorizeChannelJoin`
 * already resolves membership through `resolveOrgMembership`, builds a
 * `channelTarget` carrying `closed`, and asks `can()` — so a call in channel X is
 * joinable by precisely those who can read channel X, and DMs inherit the whole
 * closed-target correctness argument for free.
 *
 * All this function does is turn a session id into the channel id it belongs to,
 * and then ask the existing question. It contains no membership logic, no
 * participant lookup, and no second `can()` call, and it must never grow one:
 *
 *   > Do not invent a second membership check for calls.
 *
 * That is the single most important constraint in this phase. `rtc.participants`
 * is a record of what happened, and a socket handler that consulted it to decide
 * who may join would be the `participantIds.includes(userId)` shortcut
 * ai/phase-5-chat.md §3.3 forbids — rebuilt in the one layer where it would be
 * hardest to notice, because the socket path has no HTTP audit trail.
 *
 * ## The session must exist and belong to this org
 *
 * Checked rather than assumed, for the reason `authorizeCallJoin` gives about
 * PSTN calls: the room NAME is the only thing routing signals, so a room nobody
 * validated is a room anybody can occupy. Someone sitting in `rtc:<any uuid>`
 * waiting for an offer addressed there is the cheapest possible version of this
 * attack, and the lookup is one indexed read.
 *
 * RLS does the tenant half: a session outside this org is simply not among the
 * rows `withOrgScope` can see, so "no such session" and "another tenant's
 * session" are already the same answer here.
 */
export async function authorizeRtcJoin(
  userId: UserId,
  orgId: OrgId,
  sessionId: string,
): Promise<JoinAuthorization> {
  /* The org scope is opened on a value the CALLER supplied, which is only safe
     because `authorizeChannelJoin` below re-resolves membership from the
     verified user id before any decision is made — and because nothing read
     here is returned to the caller. A session id that names another tenant's
     row matches nothing under RLS and refuses. Same ordering as `rooms.ts`,
     with the membership check moved after the lookup rather than before it
     purely because the lookup is what produces the channel the check needs. */
  const channelId = await withOrgScope(orgId, async (tx) => {
    try {
      const session = await loadSession(tx, sessionId);
      /* An ended call's room is nobody's to join. Refusing here rather than
         letting the channel check pass means a stale client cannot sit in the
         room of a finished call receiving whatever a later bug broadcasts
         there. */
      return session.status === 'ended' ? null : session.channelId;
    } catch {
      /* `loadSession` throws a tRPC NOT_FOUND. There is no HTTP response to
         shape here, and the distinction between "no such session" and "another
         tenant's session" is one RLS has already erased. */
      return null;
    }
  });

  if (channelId === null) return { allowed: false, reason: 'no_such_call' };

  /* THE decision, and it is the channel's. Not adapted, not re-derived — the
     same function the /chat namespace calls for a channel join. */
  return authorizeChannelJoin(userId, orgId, channelId as ChannelId);
}
