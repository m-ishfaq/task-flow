import type { Logger } from '@taskflow/observability';
import { OrgIdSchema, BoardIdSchema } from '@taskflow/contracts';
import type { OutboxRow } from '@taskflow/db';
import { broadcastPresence } from './presence.js';
import { authorizeJoin } from './rooms.js';
import { boardRoom } from './wire.js';
import type { GatewayServer, GatewaySocket, RevocationMessage } from './socket-data.js';

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
