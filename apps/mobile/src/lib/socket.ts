import { io, type Socket } from 'socket.io-client';
import type { BoardId } from '@taskflow/contracts';
import { CLIENT_HEADER, MOBILE_CLIENT } from '@taskflow/contracts';

/**
 * The realtime gateway connection, ported from `apps/web/src/lib/socket.ts`
 * (ai/phase-14-mobile.md §5, §8).
 *
 * One socket per running app, lazily connected the first time a board (or an
 * incoming call, §8) is opened. The handshake, the reconnect-and-replay-joins
 * logic, and the whole "sockets broadcast, they never write" discipline are
 * unchanged from web — see that file's own header for the parts that carry
 * over unmodified. What genuinely differs on a phone:
 *
 * ## Everything transport-facing is injected, unlike apps/web's singleton
 *
 * apps/web's `socket.ts` imports `accessToken`/`useSession` directly, because
 * that module IS a singleton. apps/mobile's `session.ts` is deliberately a
 * FACTORY (`createMobileSession`), so this module has to be one too —
 * `SocketDeps` is the same narrow-port pattern `trpc-client.ts`'s
 * `MobileClientDeps` already uses, and it is what lets the reconnect-replay
 * bookkeeping below run under a unit test with a fake `io()` and no Expo
 * runtime, the same argument `session.ts`'s own header makes for itself.
 *
 * ## No dev-proxy origin quirk — and no origin at all
 *
 * apps/web orders transports `['websocket', 'polling']` to route around a
 * same-origin dev proxy not carrying `Origin` on polling's XHR. There is no
 * dev proxy here (`config.ts`'s own header: "a phone is never same-origin
 * with anything"), so that specific reason does not apply — websocket-first
 * is kept anyway for the ordinary latency reason (skip a polling handshake
 * before upgrading), with polling still available as a fallback for a
 * network that blocks raw WebSocket outright.
 *
 * More importantly: this module does **not** attempt to set an `Origin`
 * header at all. `apps/realtime/src/auth.ts`'s `isNativeClient` is the other
 * half of this — read that function's own comment before touching either
 * side. Short version: a browser's `Origin` is enforced by the browser
 * itself and cannot be forged by a page's own script, which is what makes it
 * a real control; nothing enforces anything a phone sends, so faking one
 * here would be a control that looks real and is not. `extraHeaders` instead
 * carries `CLIENT_HEADER: MOBILE_CLIENT` — confirmed against
 * `engine.io-client`'s own source to propagate to whichever transport
 * actually connects (`Socket.createTransport` spreads the top-level options,
 * `extraHeaders` included, into every transport before any per-transport
 * override) — which the gateway reads only to decide whether its origin
 * check applies at all. What actually protects this connection is the same
 * token verification a browser gets; see the server file for the rest.
 */
const TRANSPORT_OPTIONS = {
  transports: ['websocket', 'polling'] as string[],
  tryAllTransports: true,
};

/** Server -> client payloads. Mirrors apps/realtime's wire.ts, same as web. */
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
/** "You have a new notification" (Phase 9). See apps/web's socket.ts for why
 *  the payload carries only an id. */
interface NotificationMessage {
  readonly notificationId: string;
}
/** "Someone is calling you" (Phase 13, Wave 5 here — §8). Carries what a
 *  ringing banner renders from, not just an id: latency is the whole point. */
interface CallRingingMessage {
  readonly sessionId: string;
  readonly channelId: string;
  readonly initiatedBy: string;
  readonly kind: string;
}
interface CallEndedMessage {
  readonly sessionId: string;
  readonly reason: string;
}

interface ServerToClientEvents {
  ready: (message: ReadyMessage) => void;
  broadcast: (message: BroadcastMessage) => void;
  notification: (message: NotificationMessage) => void;
  'call:ringing': (message: CallRingingMessage) => void;
  'call:ended': (message: CallEndedMessage) => void;
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

export interface SocketDeps {
  readonly apiBaseUrl: string;
  /** From `MobileSession.accessToken` — single-flight, refreshes if needed. */
  accessToken(): Promise<string | null>;
  /** From `MobileSession.store.getState().expiresAt` — read fresh on every
   *  `ready`, never captured once, so a renewed token reschedules correctly. */
  getExpiresAt(): number | null;
  /** From `MobileSession.clear` — the gateway told us the credential itself
   *  is gone; there is nothing to retry with the same token. */
  onSessionEnded(): void;
}

export interface MobileSocket {
  /** Joins `board:{boardId}`'s room. Returns whether the join was granted. */
  joinBoardRoom(orgId: string, boardId: BoardId): Promise<boolean>;
  leaveBoardRoom(boardId: BoardId): void;
  /** Runs `handler` after every RECONNECT, never the first connection. */
  onReconnect(handler: () => void): () => void;
  onBroadcast(handler: (message: BroadcastMessage) => void): () => void;
  onNotification(handler: (message: NotificationMessage) => void): () => void;
  /** Subscribes to incoming calls, and FORCES the connection open — see the
   *  module header on why this is the one subscription that does. */
  onIncomingCall(handler: (message: CallRingingMessage) => void): () => void;
  onCallEnded(handler: (message: CallEndedMessage) => void): () => void;
  onRoomClosed(handler: (message: RoomClosedMessage) => void): () => void;
  onPresence(handler: (message: PresenceMessage) => void): () => void;
  /** Tears the connection down entirely. Called on sign-out. */
  disconnect(): void;
}

/**
 * Builds a socket connection bound to one session's token source. A factory
 * rather than apps/web's module singleton — see the module header.
 */
export function createMobileSocket(deps: SocketDeps): MobileSocket {
  let socket: GatewaySocket | undefined;
  let reauthTimer: ReturnType<typeof setTimeout> | undefined;

  /** Boards this app currently wants joined — see apps/web's `joinedBoards`
   *  for the full reasoning; ported verbatim. */
  const joinedBoards = new Map<BoardId, string>();
  const reconnectListeners = new Set<() => void>();

  function scheduleReauth(reauthLeadSeconds: number): void {
    if (reauthTimer !== undefined) clearTimeout(reauthTimer);

    const expiresAt = deps.getExpiresAt();
    if (expiresAt === null) return;

    const reconnectAt = expiresAt - reauthLeadSeconds * 1000;
    const delay = Math.max(0, reconnectAt - Date.now());

    reauthTimer = setTimeout(() => {
      socket?.disconnect().connect();
    }, delay);
  }

  function buildSocket(): GatewaySocket {
    const created: GatewaySocket = io(deps.apiBaseUrl || undefined, {
      path: '/socket.io',
      autoConnect: false,
      ...TRANSPORT_OPTIONS,
      // Read by `apps/realtime/src/auth.ts`'s `isNativeClient` ONLY when no
      // `Origin` is present — see this module's own header and that
      // function's comment for what this does and does not provide.
      extraHeaders: { [CLIENT_HEADER]: MOBILE_CLIENT },
      auth: (callback) => {
        void deps.accessToken().then((token) => {
          callback({ token: token ?? '' });
        });
      },
    });

    created.on('ready', ({ reauthLeadSeconds }) => {
      scheduleReauth(reauthLeadSeconds);
    });

    created.on('session:ended', () => {
      deps.onSessionEnded();
      disconnect();
    });

    created.io.on('reconnect', () => {
      for (const [boardId, orgId] of joinedBoards) {
        created.emit('board:join', { orgId, boardId }, () => {
          /* Best-effort — see apps/web's identical handler for why there is
             no further error path here. */
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

  async function joinBoardRoom(orgId: string, boardId: BoardId): Promise<boolean> {
    const active = ensureSocket();
    if (!active.connected) active.connect();

    // Recorded BEFORE the emit, regardless of the ack — see apps/web's
    // `joinBoardRoom` for why recording it inside the ack instead loses
    // exactly the join that was in flight when a connection drops.
    joinedBoards.set(boardId, orgId);

    return new Promise((resolve) => {
      active.emit('board:join', { orgId, boardId }, (result) => {
        resolve(result.ok);
      });
    });
  }

  function leaveBoardRoom(boardId: BoardId): void {
    joinedBoards.delete(boardId);
    socket?.emit('board:leave', { boardId });
  }

  function onReconnect(handler: () => void): () => void {
    ensureSocket();
    reconnectListeners.add(handler);
    return () => reconnectListeners.delete(handler);
  }

  function onBroadcast(handler: (message: BroadcastMessage) => void): () => void {
    const active = ensureSocket();
    active.on('broadcast', handler);
    return () => active.off('broadcast', handler);
  }

  function onNotification(handler: (message: NotificationMessage) => void): () => void {
    const active = ensureSocket();
    active.on('notification', handler);
    return () => active.off('notification', handler);
  }

  function onIncomingCall(handler: (message: CallRingingMessage) => void): () => void {
    const active = ensureSocket();
    if (!active.connected) active.connect();
    active.on('call:ringing', handler);
    return () => active.off('call:ringing', handler);
  }

  function onCallEnded(handler: (message: CallEndedMessage) => void): () => void {
    const active = ensureSocket();
    active.on('call:ended', handler);
    return () => active.off('call:ended', handler);
  }

  function onRoomClosed(handler: (message: RoomClosedMessage) => void): () => void {
    const active = ensureSocket();
    active.on('room:closed', handler);
    return () => active.off('room:closed', handler);
  }

  function onPresence(handler: (message: PresenceMessage) => void): () => void {
    const active = ensureSocket();
    active.on('presence', handler);
    return () => active.off('presence', handler);
  }

  function disconnect(): void {
    if (reauthTimer !== undefined) clearTimeout(reauthTimer);
    joinedBoards.clear();
    reconnectListeners.clear();
    socket?.disconnect();
    socket = undefined;
  }

  return {
    joinBoardRoom,
    leaveBoardRoom,
    onReconnect,
    onBroadcast,
    onNotification,
    onIncomingCall,
    onCallEnded,
    onRoomClosed,
    onPresence,
    disconnect,
  };
}

export type {
  BroadcastMessage,
  CallEndedMessage,
  CallRingingMessage,
  NotificationMessage,
  PresenceMessage,
  RoomClosedMessage,
};
