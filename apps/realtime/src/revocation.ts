import type { Logger } from '@taskflow/observability';
import { OrgIdSchema, BoardIdSchema, ChannelIdSchema } from '@taskflow/contracts';
import type { OutboxRow } from '@taskflow/db';
import { broadcastPresence, broadcastRtcPeers } from './presence.js';
import { authorizeChannelJoin, authorizeJoin } from './rooms.js';
import { authorizeRtcJoin } from './rtc-rooms.js';
import { boardRoom, channelRoom, rtcRoom } from './wire.js';
import type {
  ChatNamespace,
  ChatSocket,
  GatewayServer,
  GatewaySocket,
  RevocationMessage,
  RtcNamespace,
  RtcSocket,
} from './socket-data.js';

/**
 * Keeping a long-lived connection honest (§3.3, §7.2).
 *
 * ## The problem this exists for
 *
 * A room join is an authorization decision, and on HTTP that decision lasts one
 * request. Here it lasts as long as the socket — hours. In that window a role
 * can be demoted, a tuple revoked, a member removed, or a session killed, and
 * nothing about the open connection would notice.
 *
 * The fix is deliberately NOT a TTL on the join decision. A cache that expires
 * is still wrong for however long it has left, and picking the number means
 * choosing how long a revoked administrator keeps administrator. Instead the
 * gateway subscribes to the events that already exist for exactly this purpose
 * and re-runs the SAME `can()` the join ran.
 *
 * ## The split, and why it is not "disconnect everything"
 *
 * §7.2: the line is whether the CREDENTIAL is still good.
 *
 *   grant.revoked / member.role_changed  re-check; leave only the rooms that now fail
 *   member.removed                       leave every room in that org
 *   session.revoked                      close the connection
 *   session.token_reuse_detected         close the connection
 *
 * A revoked board tuple says "not this room". Kicking that user off every other
 * board they had open is a correctness-free punishment that makes revoking one
 * share look like an outage — and an outage is the thing people work around by
 * not revoking shares.
 */

/**
 * Event name → what any gateway instance should do about it.
 *
 * A fixed literal table, the same shape as `event-rooms.ts` and for the same
 * reason. Note `session.token_reuse_detected`: the spec's §7.2 table wrote it as
 * `token.reuse_detected`, and the real definition in
 * `apps/api/src/identity/events.ts` is this one. A name that does not exist
 * would produce no error anywhere — it would simply never match, and the control
 * would be silently absent. This is the kind of mismatch a literal table makes
 * greppable and a derived one hides.
 */
export function revocationOf(row: OutboxRow): RevocationMessage | null {
  const payload = row.payload;
  if (typeof payload !== 'object' || payload === null) return null;
  const fields = payload as Record<string, unknown>;

  const text = (key: string): string | null => {
    const value = fields[key];
    return typeof value === 'string' && value.length > 0 ? value : null;
  };

  switch (row.name) {
    case 'session.revoked': {
      const sessionId = text('sessionId');
      return sessionId === null ? null : { kind: 'session', sessionId, reason: 'session_revoked' };
    }

    case 'session.token_reuse_detected': {
      const sessionId = text('sessionId');
      return sessionId === null
        ? null
        : { kind: 'session', sessionId, reason: 'token_reuse_detected' };
    }

    case 'member.removed': {
      const userId = text('userId');
      return userId === null ? null : { kind: 'member_removed', orgId: row.orgId, userId };
    }

    case 'member.role_changed': {
      const userId = text('userId');
      return userId === null ? null : { kind: 'recheck_user', orgId: row.orgId, userId };
    }

    case 'grant.revoked': {
      /* A grant made to a TEAM cannot be reduced to one user here — expanding it
         would mean reading team membership, which is a query this module has no
         business making and which would be racing the very change that produced
         the event. Re-checking every socket in the org is O(connected sockets)
         `can()` calls on a rare event, and it is correct without needing to know
         who was in the team. Choosing the cheap-but-partial option would leave
         exactly the users a team grant was revoked from still in their rooms. */
      if (fields['subjectType'] === 'team') return { kind: 'recheck_org', orgId: row.orgId };
      const userId = text('subjectId');
      return userId === null
        ? { kind: 'recheck_org', orgId: row.orgId }
        : { kind: 'recheck_user', orgId: row.orgId, userId };
    }

    default:
      return null;
  }
}

/**
 * Applies a revocation to the sockets held by THIS instance.
 *
 * Every instance runs this for every revocation, because the relay claims
 * disjoint batches and the instance that claimed the event is almost never the
 * one holding the affected socket — see `InterServerEvents` in socket-data.ts.
 */
export async function applyRevocation(
  io: GatewayServer,
  message: RevocationMessage,
  logger: Logger,
): Promise<void> {
  const sockets = [...io.sockets.sockets.values()] as GatewaySocket[];

  for (const socket of sockets) {
    switch (message.kind) {
      case 'session': {
        if (socket.data.identity.sessionId !== message.sessionId) break;
        /* Emitted before the disconnect so the client can distinguish "your
           session ended" from an ordinary network drop — the difference decides
           whether it reconnects or stops. `true` closes the underlying
           connection rather than only the namespace: a half-closed socket that
           can still receive is not a revoked one. */
        socket.emit('session:ended', { reason: message.reason });
        logger.info(
          { userId: socket.data.identity.userId, reason: message.reason },
          'closing socket: credential revoked',
        );
        socket.disconnect(true);
        break;
      }

      case 'member_removed': {
        if (socket.data.identity.userId !== message.userId) break;
        for (const [boardId, orgId] of [...socket.data.rooms]) {
          if (orgId === message.orgId)
            await leaveRoom(io, socket, boardId, logger, 'member removed');
        }
        break;
      }

      case 'recheck_user': {
        if (socket.data.identity.userId !== message.userId) break;
        await recheck(io, socket, message.orgId, logger);
        break;
      }

      case 'recheck_org': {
        await recheck(io, socket, message.orgId, logger);
        break;
      }
    }
  }
}

/**
 * Re-runs the join decision for every room this socket holds in `orgId`, and
 * drops the ones that no longer pass.
 *
 * Calls `authorizeJoin` rather than a cheaper "did the role change" shortcut, on
 * purpose: it is the same function the join ran, so there is exactly one
 * definition of who may be in a room, and a future change to the rules cannot
 * apply to joins but not to re-checks.
 */
async function recheck(
  io: GatewayServer,
  socket: GatewaySocket,
  orgId: string,
  logger: Logger,
): Promise<void> {
  for (const [boardId, roomOrgId] of [...socket.data.rooms]) {
    if (roomOrgId !== orgId) continue;

    /* Re-parsing rather than casting. These came from a validated join request,
       so they are well-formed — but `authorizeJoin` takes branded ids precisely
       so an unvalidated string cannot reach it, and quietly casting here would
       be the first crack in that. */
    const org = OrgIdSchema.safeParse(roomOrgId);
    const board = BoardIdSchema.safeParse(boardId);
    if (!org.success || !board.success) {
      await leaveRoom(io, socket, boardId, logger, 'unparseable room key');
      continue;
    }

    let allowed = false;
    try {
      allowed = (await authorizeJoin(socket.data.identity.userId, org.data, board.data)).allowed;
    } catch (error) {
      /* Fails CLOSED. A database blip during a re-check must not leave someone
         in a room a revocation was trying to remove them from — the cost of
         being wrong in this direction is a client that falls back to polling,
         and in the other direction it is the control not working on exactly the
         occasions something else is already going wrong. */
      logger.error({ err: error, boardId }, 'room re-check failed; leaving the room');
    }

    if (!allowed) await leaveRoom(io, socket, boardId, logger, 'authorization re-check failed');
  }
}

async function leaveRoom(
  io: GatewayServer,
  socket: GatewaySocket,
  boardId: string,
  logger: Logger,
  reason: string,
): Promise<void> {
  socket.data.rooms.delete(boardId);
  await socket.leave(boardRoom(boardId));
  socket.emit('room:closed', { boardId });
  logger.info({ userId: socket.data.identity.userId, boardId, reason }, 'socket left room');
  // After the leave actually took effect — a presence broadcast made before
  // this resolved would still count the departing socket as present (§9).
  await broadcastPresence(io, boardId);
}

/* -------------------------------------------------------------------------- *
 * Chat (ai/phase-5-chat.md §3.3)
 * -------------------------------------------------------------------------- */

/**
 * The same sweep, over the `/chat` namespace's sockets.
 *
 * ## Why this is a second function and not a parameter
 *
 * The two namespaces hold different `Socket` objects, whose `rooms` maps hold
 * different populations (board ids there, channel ids here) and whose
 * authorization is answered by different functions. A single generic version
 * would take "which authorizer" and "which room-name builder" as arguments, and
 * the failure mode of passing the board pair while sweeping chat sockets is that
 * every re-check answers `no_such_board` — which fails CLOSED and therefore
 * force-leaves everyone from every channel, on every role change in the org.
 * That is an outage that looks like a working security control.
 *
 * ## Why chat force-leaves matter more than board ones
 *
 * On a board, a stale room means seeing card moves you should not. In a private
 * channel it means continuing to receive a conversation you were removed from,
 * live, for as long as the tab stays open — and channel membership changes far
 * more often than board grants do (§3.3). Removing someone writes a tuple
 * deletion, which emits `grant.revoked`, which lands here.
 */
export async function applyChatRevocation(
  namespace: ChatNamespace,
  message: RevocationMessage,
  logger: Logger,
): Promise<void> {
  const sockets = [...namespace.sockets.values()] as ChatSocket[];

  for (const socket of sockets) {
    switch (message.kind) {
      case 'session': {
        if (socket.data.identity.sessionId !== message.sessionId) break;
        socket.emit('session:ended', { reason: message.reason });
        logger.info(
          { userId: socket.data.identity.userId, reason: message.reason },
          'closing chat socket: credential revoked',
        );
        socket.disconnect(true);
        break;
      }

      case 'member_removed': {
        if (socket.data.identity.userId !== message.userId) break;
        for (const [channelId, orgId] of [...socket.data.rooms]) {
          if (orgId === message.orgId) {
            await leaveChannel(socket, channelId, logger, 'member removed from org');
          }
        }
        break;
      }

      case 'recheck_user': {
        if (socket.data.identity.userId !== message.userId) break;
        await recheckChannels(socket, message.orgId, logger);
        break;
      }

      case 'recheck_org': {
        await recheckChannels(socket, message.orgId, logger);
        break;
      }
    }
  }
}

/**
 * Re-runs the channel join decision for every room this socket holds in `orgId`.
 *
 * Calls `authorizeChannelJoin` — the same function the join ran — so there is
 * one definition of who may be in a channel room, and a future change to the
 * rules cannot apply to joins but not to re-checks.
 */
async function recheckChannels(socket: ChatSocket, orgId: string, logger: Logger): Promise<void> {
  for (const [channelId, roomOrgId] of [...socket.data.rooms]) {
    if (roomOrgId !== orgId) continue;

    /* Re-parsed rather than cast, for the reason the board version gives:
       `authorizeChannelJoin` takes branded ids precisely so an unvalidated
       string cannot reach it. */
    const org = OrgIdSchema.safeParse(roomOrgId);
    const channel = ChannelIdSchema.safeParse(channelId);
    if (!org.success || !channel.success) {
      await leaveChannel(socket, channelId, logger, 'unparseable room key');
      continue;
    }

    let allowed = false;
    try {
      allowed = (await authorizeChannelJoin(socket.data.identity.userId, org.data, channel.data))
        .allowed;
    } catch (error) {
      /* Fails CLOSED, same as the board re-check. A database blip must not leave
         someone in a channel a revocation was trying to remove them from — the
         cost of being wrong this way is a client that falls back to polling, and
         the cost the other way is the control not working on exactly the
         occasions something else is already going wrong. */
      logger.error({ err: error, channelId }, 'channel re-check failed; leaving the room');
    }

    if (!allowed) await leaveChannel(socket, channelId, logger, 'authorization re-check failed');
  }
}

async function leaveChannel(
  socket: ChatSocket,
  channelId: string,
  logger: Logger,
  reason: string,
): Promise<void> {
  socket.data.rooms.delete(channelId);
  await socket.leave(channelRoom(channelId));
  socket.emit('channel:closed', { channelId });
  logger.info(
    { userId: socket.data.identity.userId, channelId, reason },
    'socket left channel room',
  );
}

/* -------------------------------------------------------------------------- *
 * In-app voice (Phase 13 Wave 1, ai/phase-13-webrtc.md §1)
 * -------------------------------------------------------------------------- */

/**
 * The same sweep again, over the `/rtc` namespace's sockets.
 *
 * A third copy rather than a generic version, for the reason `applyChatRevocation`
 * spells out above: a generic sweep takes "which authorizer" as an argument, and
 * passing the wrong one makes every re-check answer `no_such_call`, which fails
 * CLOSED and therefore evicts everyone from every call on every role change in
 * the org. An outage that looks like a working security control.
 *
 * ## Why a live call is the surface where this matters most
 *
 * On a board, a stale room means seeing card moves you should not. In a private
 * channel it means still receiving a conversation you were removed from. In a
 * call it means a microphone — someone removed from a channel mid-call keeps
 * hearing it until they hang up, and the signalling room is what keeps their peer
 * connections alive. Leaving the room is the gateway's half; the peers stop
 * negotiating with them and the client tears the connection down.
 *
 * Stated honestly, because it is a real limit: leaving the signalling room does
 * not by itself kill an already-established peer connection, which is
 * browser-to-browser and does not pass through this process at all. What it does
 * is remove them from every future negotiation and tell the remaining peers to
 * drop them. A control that could positively terminate media would need an SFU,
 * which is deferred (§2) — and that is a reason to know the limit, not to skip
 * the eviction.
 */
export async function applyRtcRevocation(
  namespace: RtcNamespace,
  message: RevocationMessage,
  logger: Logger,
): Promise<void> {
  const sockets = [...namespace.sockets.values()] as RtcSocket[];

  for (const socket of sockets) {
    switch (message.kind) {
      case 'session': {
        if (socket.data.identity.sessionId !== message.sessionId) break;
        socket.emit('session:ended', { reason: message.reason });
        logger.info(
          { userId: socket.data.identity.userId, reason: message.reason },
          'closing rtc socket: credential revoked',
        );
        socket.disconnect(true);
        break;
      }

      case 'member_removed': {
        if (socket.data.identity.userId !== message.userId) break;
        for (const [sessionId, orgId] of [...socket.data.rooms]) {
          if (orgId === message.orgId) {
            await leaveRtcRoom(namespace, socket, sessionId, logger, 'member removed from org');
          }
        }
        break;
      }

      case 'recheck_user': {
        if (socket.data.identity.userId !== message.userId) break;
        await recheckCalls(namespace, socket, message.orgId, logger);
        break;
      }

      case 'recheck_org': {
        await recheckCalls(namespace, socket, message.orgId, logger);
        break;
      }
    }
  }
}

async function recheckCalls(
  namespace: RtcNamespace,
  socket: RtcSocket,
  orgId: string,
  logger: Logger,
): Promise<void> {
  for (const [sessionId, roomOrgId] of [...socket.data.rooms]) {
    if (roomOrgId !== orgId) continue;

    const org = OrgIdSchema.safeParse(roomOrgId);
    if (!org.success) {
      await leaveRtcRoom(namespace, socket, sessionId, logger, 'unparseable room key');
      continue;
    }

    let allowed = false;
    try {
      /* `authorizeRtcJoin` — the same function the join ran, which is itself
         almost nothing but a call to `authorizeChannelJoin`. One definition of
         who may be in a call, and it is the channel's. */
      allowed = (await authorizeRtcJoin(socket.data.identity.userId, org.data, sessionId)).allowed;
    } catch (error) {
      /* Fails CLOSED, same as the two sweeps above. */
      logger.error({ err: error, sessionId }, 'call re-check failed; leaving the room');
    }

    if (!allowed) {
      await leaveRtcRoom(namespace, socket, sessionId, logger, 'authorization re-check failed');
    }
  }
}

async function leaveRtcRoom(
  namespace: RtcNamespace,
  socket: RtcSocket,
  sessionId: string,
  logger: Logger,
  reason: string,
): Promise<void> {
  socket.data.rooms.delete(sessionId);
  await socket.leave(rtcRoom(sessionId));
  socket.emit('rtc:closed', { sessionId });
  logger.info({ userId: socket.data.identity.userId, sessionId, reason }, 'socket left call room');
  /* The remaining peers need to know somebody left, or they keep a peer
     connection open to a browser that is no longer being negotiated with. */
  await broadcastRtcPeers(namespace, sessionId);
}
