import type { GatewayServer } from './socket-data.js';
import { boardRoom } from './wire.js';

/**
 * Presence (ai/phase-4-realtime.md §5 Wave 2, §9).
 *
 * "Socket.io's own room membership is presence" — this module is the small
 * amount of code that turns that membership into a message a client can
 * render, and nothing more. There is no presence table, no persistence, and
 * no domain event: the fact "user X has this board open" stops being true
 * the instant a tab closes, which is a different shape of fact than anything
 * else this codebase writes to the outbox.
 *
 * ## `fetchSockets`, not a direct read of `io.sockets.adapter.rooms`
 *
 * The gateway is wired with `@socket.io/postgres-adapter` at single-instance
 * scale "on purpose... cheap now, expensive to retrofit once two instances
 * are running" (gateway.ts). Reading `io.sockets.adapter.rooms` directly
 * would be exactly that kind of retrofit trap: it only ever sees sockets
 * connected to THIS process, so presence on a second instance would silently
 * report a subset of who is actually there — correct today, wrong the day a
 * second instance starts, with nothing failing to say so. `fetchSockets()` is
 * the adapter-aware API Socket.io ships for exactly this: it asks every
 * instance and answers as one cluster, so this function is already correct
 * whether the gateway is one process or several.
 */

/** Distinct user ids currently in `board:{boardId}`, in no particular order. */
export async function presenceMembersOf(
  io: GatewayServer,
  boardId: string,
): Promise<readonly string[]> {
  const sockets = await io.in(boardRoom(boardId)).fetchSockets();
  const userIds = new Set(sockets.map((socket) => socket.data.identity.userId));
  return [...userIds];
}

/**
 * Tells everyone currently in the room who is currently in the room.
 *
 * Called after every join, leave, disconnect, and forced leave (§3.3) — every
 * moment the membership could have changed. Broadcasting the full list rather
 * than a delta means a client that missed one of these calls (a reconnect
 * mid-update, a slow tab) is still correct on the very next one, with nothing
 * to reconcile.
 */
export async function broadcastPresence(io: GatewayServer, boardId: string): Promise<void> {
  const userIds = await presenceMembersOf(io, boardId);
  io.to(boardRoom(boardId)).emit('presence', { boardId, userIds });
}
