import { io, type Socket } from 'socket.io-client';
import type { BoardId } from '@taskflow/contracts';
import { config } from './config.js';
import { accessToken, useSession } from './session.js';

/**
 * The realtime gateway connection (ai/phase-4-realtime.md §3.2, §3.6, §7.1).
 *
 * One socket per tab, lazily connected the first time a board is open and torn
 * down on sign-out. Every board-scoped page joins and leaves rooms on this
 * shared connection rather than opening one of its own — §3.1 rooms itself
 * around "every place the frontend already scopes a live query", and a
 * consultant with two boards open in two tabs is still one connection per tab.
 *
 * ## What this file does NOT do
 *
 * It does not decide who may see a board. `board:join`'s ack is the server's
 * `can()` decision (§3.3); this module relays the request and the refusal, and
 * a refusal here means the caller falls back to the ordinary polled query —
 * never that this module tries again with different data, which would be the
 * gateway's job to re-derive, not this one's (§6.2 applies to the client too).
 *
 * It does not mutate anything. Every message this socket ever sends is
 * `board:join` or `board:leave` — a subscription request, not a write. That is
 * CLAUDE.md rule 8's other half: sockets broadcast, and a client that could
 * write over one would be the second write path §9 warns about.
 */

/** Server -> client payloads this module understands. Mirrors apps/realtime's wire.ts. */
interface ReadyMessage {
  readonly reauthLeadSeconds: number;
}
interface BroadcastMessage {
  readonly name: string;
  readonly version: number;
  readonly orgId: string;
  readonly boardId: string;
  readonly actorId: string | null;
  readonly mutationId: string | null;
  readonly occurredAt: string;
  readonly payload: unknown;
}
interface RoomClosedMessage {
  readonly boardId: string;
}
interface SessionEndedMessage {
  readonly reason: 'session_revoked' | 'token_reuse_detected';
}

interface ServerToClientEvents {
  ready: (message: ReadyMessage) => void;
  broadcast: (message: BroadcastMessage) => void;
  'room:closed': (message: RoomClosedMessage) => void;
  'session:ended': (message: SessionEndedMessage) => void;
}
interface ClientToServerEvents {
  'board:join': (
    request: { orgId: string; boardId: BoardId },
    ack: (result: { ok: true } | { ok: false; reason: string }) => void,
  ) => void;
  'board:leave': (request: { boardId: BoardId }) => void;
}

type GatewaySocket = Socket<ServerToClientEvents, ClientToServerEvents>;

let socket: GatewaySocket | undefined;
let reauthTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Schedules a proactive reconnect (§7.1) using the lead time the GATEWAY
 * supplied on `ready`, not a constant hardcoded here — when a platform-settings
 * surface exists (§7.6), the number changes on the server and this file does
 * not.
 *
 * Reconnecting rather than re-authenticating in place: Socket.io's own
 * reconnect/backoff already exists and `board-view.tsx` already has to
 * tolerate a disconnected gateway (rooms are rejoined on `connect`, below), so
 * a scheduled reconnect is not a new failure mode — it is a planned instance
 * of one the client already handles.
 */
function scheduleReauth(reauthLeadSeconds: number): void {
  if (reauthTimer !== undefined) clearTimeout(reauthTimer);

  const { expiresAt } = useSession.getState();
  if (expiresAt === null) return;

  const reconnectAt = expiresAt - reauthLeadSeconds * 1000;
  const delay = Math.max(0, reconnectAt - Date.now());

  reauthTimer = setTimeout(() => {
    // A fresh `auth` callback runs on the next connect attempt (below), which
    // is what actually fetches the renewed token — this only forces that
    // attempt to happen before the OLD token expires instead of after the
    // gateway rejects it.
    socket?.disconnect().connect();
  }, delay);
}

function buildSocket(): GatewaySocket {
  const created: GatewaySocket = io(config.apiBaseUrl || undefined, {
    path: '/socket.io',
    // Connect only once something actually joins a room — a tab that never
    // opens a board should not hold a socket open for nothing.
    autoConnect: false,
    /* A function, not a value: socket.io-client calls this on EVERY connection
       attempt, including reconnects, so a refreshed token is picked up without
       this module having to know when one was minted. `accessToken()` itself
       is single-flight (session.ts) and refreshes if needed — the identical
       function every tRPC request uses, so the gateway and the API can never
       disagree about what "signed in" means. */
    auth: (callback) => {
      void accessToken().then((token) => {
        callback({ token: token ?? '' });
      });
    },
  });

  created.on('ready', ({ reauthLeadSeconds }) => {
    scheduleReauth(reauthLeadSeconds);
  });

  created.on('session:ended', () => {
    // The credential itself is gone (§7.2) — the same terminal state an
    // expired session reaches everywhere else in this app. There is no room
    // to fall back to polling on, and reconnecting would fail with the same
    // token, so this clears local state rather than retrying into a loop.
    // `disconnectSocket()` also drops the singleton itself — the alternative,
    // leaving `socket` pointing at this (now server-closed) connection, would
    // mean the NEXT sign-in's first `joinBoardRoom` call reused a socket whose
    // `auth` closure still remembers this session ending, rather than opening
    // cleanly against the just-adopted one.
    useSession.getState().clear();
    disconnectSocket();
  });

  return created;
}

function ensureSocket(): GatewaySocket {
  socket ??= buildSocket();
  return socket;
}

/**
 * Joins `board:{boardId}`'s room.
 *
 * `orgId` is a scope selector, exactly like the `x-taskflow-org` header on
 * HTTP (session.ts) — never trusted, only a filter the gateway's `can()`
 * checks against the verified caller. Returns whether the join was granted;
 * a caller that gets `false` has nothing further to do here; the board's
 * ordinary polled query already covers it.
 */
export async function joinBoardRoom(orgId: string, boardId: BoardId): Promise<boolean> {
  const active = ensureSocket();
  if (!active.connected) active.connect();

  return new Promise((resolve) => {
    active.emit('board:join', { orgId, boardId }, (result) => {
      resolve(result.ok);
    });
  });
}

export function leaveBoardRoom(boardId: BoardId): void {
  socket?.emit('board:leave', { boardId });
}

/**
 * Subscribes to every broadcast on this connection, filtered to one board by
 * the caller (`use-board-room.ts`). One shared `on('broadcast', ...)` rather
 * than a second per-board event bus — Socket.io's own room membership is
 * already the filter that decided this socket receives the message at all.
 */
export function onBroadcast(handler: (message: BroadcastMessage) => void): () => void {
  const active = ensureSocket();
  active.on('broadcast', handler);
  return () => active.off('broadcast', handler);
}

export function onRoomClosed(handler: (message: RoomClosedMessage) => void): () => void {
  const active = ensureSocket();
  active.on('room:closed', handler);
  return () => active.off('room:closed', handler);
}

/**
 * Tears the connection down entirely. Called on sign-out — a socket that
 * outlived the session it authenticated with is exactly the stale-connection
 * shape `resetCache` in query.ts exists to prevent for the query cache.
 */
export function disconnectSocket(): void {
  if (reauthTimer !== undefined) clearTimeout(reauthTimer);
  socket?.disconnect();
  socket = undefined;
}

export type { BroadcastMessage, RoomClosedMessage };
