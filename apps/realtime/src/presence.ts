import type { ChatNamespace, GatewayServer, RtcNamespace } from './socket-data.js';
import { boardRoom, channelRoom, rtcRoom } from './wire.js';

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

/* -------------------------------------------------------------------------- *
 * Chat (ai/phase-5-chat.md §2)
 * -------------------------------------------------------------------------- */

/** Distinct user ids currently in `channel:{channelId}`, in no particular order. */
export async function channelPresenceMembersOf(
  namespace: ChatNamespace,
  channelId: string,
): Promise<readonly string[]> {
  /* `fetchSockets()` on the NAMESPACE, for the same reason the board version
     uses it on the server: it is adapter-aware, so it asks every gateway
     instance and answers as one cluster. Reading
     `namespace.adapter.rooms` directly would see only sockets connected to THIS
     process — correct today, silently reporting a subset the day a second
     instance starts. */
  const sockets = await namespace.in(channelRoom(channelId)).fetchSockets();
  const userIds = new Set(sockets.map((socket) => socket.data.identity.userId));
  return [...userIds];
}

/**
 * Tells everyone in a channel who is currently in it.
 *
 * Called after every join, leave and disconnect — every moment the membership
 * could have changed. The full list rather than a delta, so a client that
 * missed one broadcast is correct again on the next one with nothing to
 * reconcile.
 *
 * This fires for DIRECT MESSAGES as well as named channels, which is a
 * deliberate product decision recorded in `gateway.ts`: it is what makes
 * "active now" work, and it does mean the other person can see when you have
 * their conversation open.
 */
export async function broadcastChannelPresence(
  namespace: ChatNamespace,
  channelId: string,
): Promise<void> {
  const userIds = await channelPresenceMembersOf(namespace, channelId);
  namespace.to(channelRoom(channelId)).emit('presence', { channelId, userIds });
}

/* -------------------------------------------------------------------------- *
 * In-app voice (Phase 13 Wave 1, ai/phase-13-webrtc.md §3.2)
 * -------------------------------------------------------------------------- */

/**
 * Distinct user ids currently in `rtc:{sessionId}`.
 *
 * ## This is also the ROSTER the signal relay routes against
 *
 * Everywhere else in this file, room membership is a nicety — an avatar stack,
 * an "active now" dot. Here it is a security control. `rtc:signal` addresses a
 * peer by user id, and §3.2 requires that id to be a SELECTOR over a roster the
 * server holds rather than a routing key the client supplies. This function, and
 * the `fetchSockets()` call inside it, is that roster.
 *
 * Which makes the adapter-awareness argument above load-bearing rather than
 * forward-looking: reading `namespace.adapter.rooms` directly would see only
 * sockets on THIS instance, so a signal addressed to a peer connected elsewhere
 * would be silently dropped — every call between two people who happened to land
 * on different instances would fail to negotiate, intermittently, with nothing
 * in any log.
 */
export async function rtcPeersOf(
  namespace: RtcNamespace,
  sessionId: string,
): Promise<readonly string[]> {
  const sockets = await namespace.in(rtcRoom(sessionId)).fetchSockets();
  const userIds = new Set(sockets.map((socket) => socket.data.identity.userId));
  return [...userIds];
}

/**
 * Tells everyone in a call who else is in it.
 *
 * A mesh client uses this to decide which peer connections to open, so it fires
 * after every join, leave, disconnect and forced eviction. The full list rather
 * than a delta, for a sharper version of the usual reason: a client that missed
 * one delta would be permanently unconnected to one specific person, and the
 * call would work for everyone except that pair.
 */
export async function broadcastRtcPeers(
  namespace: RtcNamespace,
  sessionId: string,
): Promise<void> {
  const userIds = await rtcPeersOf(namespace, sessionId);
  namespace.to(rtcRoom(sessionId)).emit('rtc:peers', { sessionId, userIds });
}
