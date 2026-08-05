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
interface PresenceMessage {
  readonly boardId: string;
  readonly userIds: readonly string[];
}

interface ServerToClientEvents {
  ready: (message: ReadyMessage) => void;
  broadcast: (message: BroadcastMessage) => void;
  'room:closed': (message: RoomClosedMessage) => void;
  'session:ended': (message: SessionEndedMessage) => void;
  presence: (message: PresenceMessage) => void;
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
 * Boards this tab currently wants joined, keyed by boardId (§9, Wave 2).
 *
 * The server has no memory of a socket's rooms across a reconnect — a dropped
 * connection means the gateway's OWN `disconnect` handler already ran and
 * cleared its side of the membership (`gateway.ts`), so a reconnect that only
 * re-authenticates and stops there would leave the client silently receiving
 * nothing further for a board it still has open. This map is what `reconnect`
 * (below) replays `board:join` from.
 *
 * Keyed by `BoardId`, not `string`. The ids only ever arrive here as an
 * already-branded parameter of `joinBoardRoom`, so widening the key to `string`
 * bought nothing and cost a `boardId as BoardId` cast on the way back out —
 * re-asserting a brand that had simply been discarded in between. Guardrail 1
 * is that a brand is constructed by a parser at a trust boundary; a cast that
 * re-asserts one is the pattern that makes a real violation unremarkable.
 */
const joinedBoards = new Map<BoardId, string>();

/**
 * Notified after every RECONNECT (not the first connection) — never called
 * directly by this module's own reconnect handling, only by
 * `use-board-room.ts`, which is the one that knows which queries to
 * invalidate for "ends up in the same state a hard refresh would have
 * produced" (§9's reconnect-and-diff).
 */
const reconnectListeners = new Set<() => void>();

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

  /**
   * `socket.io` is this socket's Manager — `reconnect` fires there, and only
   * on an ACTUAL reconnect after a drop, never on the first connection. That
   * distinction is why this is not just `created.on('connect', ...)`: the
   * first connect has nothing to rejoin (there is no server-side membership
   * yet to have lost) and nothing to diff against, so firing this there too
   * would invalidate every board query on every page load for no reason.
   */
  created.io.on('reconnect', () => {
    for (const [boardId, orgId] of joinedBoards) {
      created.emit('board:join', { orgId, boardId }, () => {
        /* Best-effort. If access was revoked while disconnected, the ack says
           so and there is nothing further to do — the same as an ordinary
           refused join; there is no error path here a caller could act on
           differently. */
      });
    }

    for (const listener of reconnectListeners) listener();
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

  /* Recorded BEFORE the emit, and regardless of the ack.
   *
   * `joinedBoards` is "what this tab wants joined", not "what is currently
   * granted" — so a refused join stays recorded, and the next reconnect asks
   * again (access may have been restored while the socket was down).
   *
   * Recording it inside the ack instead is the subtle version of this, and it
   * is wrong: an ack only arrives if the connection survives long enough to
   * carry it back. Drop the socket after the join is sent but before the ack
   * returns — the exact window a reconnect exists to recover from — and the
   * callback never runs, the board is never recorded, and the `reconnect`
   * handler below has nothing to replay. The tab then sits on a board that
   * looks connected and silently receives no broadcasts for the rest of its
   * life, with the polled query masking it well enough that nobody reports a
   * bug. */
  joinedBoards.set(boardId, orgId);

  return new Promise((resolve) => {
    active.emit('board:join', { orgId, boardId }, (result) => {
      resolve(result.ok);
    });
  });
}

export function leaveBoardRoom(boardId: BoardId): void {
  joinedBoards.delete(boardId);
  socket?.emit('board:leave', { boardId });
}

/**
 * Runs `handler` after every reconnect (not the first connection) — see the
 * `reconnect` listener in `buildSocket()`. Returns an unsubscribe function;
 * `use-board-room.ts` calls it on unmount, the same lifecycle as
 * `onBroadcast`/`onRoomClosed`.
 */
export function onReconnect(handler: () => void): () => void {
  ensureSocket();
  reconnectListeners.add(handler);
  return () => reconnectListeners.delete(handler);
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

/** Who else has this board's room open right now (§9, Wave 2). Full list, not a delta. */
export function onPresence(handler: (message: PresenceMessage) => void): () => void {
  const active = ensureSocket();
  active.on('presence', handler);
  return () => active.off('presence', handler);
}

/**
 * Tears the connection down entirely. Called on sign-out — a socket that
 * outlived the session it authenticated with is exactly the stale-connection
 * shape `resetCache` in query.ts exists to prevent for the query cache.
 */
export function disconnectSocket(): void {
  if (reauthTimer !== undefined) clearTimeout(reauthTimer);
  // Nothing to rejoin for a session that is ending, and a stale entry here
  // would otherwise survive into whoever signs in next on this tab.
  joinedBoards.clear();
  reconnectListeners.clear();
  socket?.disconnect();
  socket = undefined;
}

export type { BroadcastMessage, PresenceMessage, RoomClosedMessage };
