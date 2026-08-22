import { io, type Socket } from 'socket.io-client';
import { CLIENT_HEADER, MOBILE_CLIENT } from '@taskflow/contracts';

/**
 * The `/rtc` namespace connection — in-app voice signalling
 * (ai/phase-13-webrtc.md §3.1, §3.2), ported from `apps/web/src/lib/
 * rtc-socket.ts` the same way `chat-socket.ts` mirrors its own web
 * counterpart: same DI-factory shape as `socket.ts`/`chat-socket.ts` (see
 * `socket.ts`'s own header on why apps/mobile is a factory where apps/web
 * is a module singleton), same reconnect-replay, same "record before the
 * emit, not inside the ack" ordering. A third Socket.io namespace on the
 * SAME gateway process the other two sockets already connect to, not a
 * third connection — `io()` with a different namespace path reuses the
 * existing Engine.IO Manager once one exists for this base URL.
 *
 * ## What this module does NOT do
 *
 * It does not decide who may be in a call — `rtc:join`'s ack is the
 * server's `can()` decision, made against the session's CHANNEL. It does
 * not carry the call RECORD (who called, who joined, how long) — that goes
 * through `apps/api`'s `rtc.*` routes, which `rtc-api.ts` calls. This
 * socket carries only SDP and ICE, ephemeral by nature.
 *
 * ## `sendSignal` names a peer, and the server does not trust the name
 *
 * `to` is a user id, and it is a SELECTOR the gateway resolves against the
 * room roster it holds — never a routing key (§3.2, `apps/realtime/src/
 * gateway.ts`'s own header on the `rtc:signal` handler). That is a
 * server-side property and nothing here can weaken it; written down
 * because the field looks, on this side, exactly like an address.
 */
const TRANSPORT_OPTIONS = {
  transports: ['websocket', 'polling'] as string[],
  tryAllTransports: true,
};

export type SignalKind = 'offer' | 'answer' | 'candidate';

interface ReadyMessage {
  readonly reauthLeadSeconds: number;
}
export interface RtcSignalMessage {
  readonly sessionId: string;
  readonly from: string;
  readonly kind: SignalKind;
  readonly data: string;
}
export interface RtcPeersMessage {
  readonly sessionId: string;
  readonly userIds: readonly string[];
}
export interface RtcClosedMessage {
  readonly sessionId: string;
}
interface SessionEndedMessage {
  readonly reason: 'session_revoked' | 'token_reuse_detected';
}

interface ServerToClientEvents {
  ready: (message: ReadyMessage) => void;
  'rtc:peers': (message: RtcPeersMessage) => void;
  'rtc:signal': (message: RtcSignalMessage) => void;
  'rtc:closed': (message: RtcClosedMessage) => void;
  'session:ended': (message: SessionEndedMessage) => void;
}
interface ClientToServerEvents {
  'rtc:join': (
    request: { orgId: string; sessionId: string },
    ack: (result: { ok: true } | { ok: false; reason: string }) => void,
  ) => void;
  'rtc:leave': (request: { sessionId: string }) => void;
  'rtc:signal': (request: {
    sessionId: string;
    to: string;
    kind: SignalKind;
    data: string;
  }) => void;
}

type RtcSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export interface RtcSocketDeps {
  readonly apiBaseUrl: string;
  /** From `MobileSession.accessToken` — single-flight, refreshes if needed. */
  accessToken(): Promise<string | null>;
  /** From `MobileSession.store.getState().expiresAt`, read fresh on every
   *  `ready` — see `socket.ts`'s identical port for why. */
  getExpiresAt(): number | null;
}

export interface MobileRtcSocket {
  /** Joins `rtc:{sessionId}`'s signalling room. Returns whether it was granted. */
  joinCallRoom(orgId: string, sessionId: string): Promise<boolean>;
  leaveCallRoom(sessionId: string): void;
  /**
   * Sends one signalling message to one peer. Best-effort with no ack,
   * deliberately — see the module header on why an ack here would be an
   * oracle for who is in which call.
   */
  sendSignal(sessionId: string, to: string, kind: SignalKind, data: string): void;
  onSignal(handler: (message: RtcSignalMessage) => void): () => void;
  /** Who is in the call's room right now. The full list, never a delta. */
  onPeers(handler: (message: RtcPeersMessage) => void): () => void;
  /** The gateway evicted this tab — a grant changed underneath a live call. */
  onCallRoomClosed(handler: (message: RtcClosedMessage) => void): () => void;
  onReconnect(handler: () => void): () => void;
  /** Tears the connection down entirely. Called on sign-out. */
  disconnect(): void;
}

/**
 * Builds a `/rtc` namespace connection bound to one session's token source.
 * See `socket.ts`'s `createMobileSocket` for the reasoning this mirrors.
 */
export function createMobileRtcSocket(deps: RtcSocketDeps): MobileRtcSocket {
  let socket: RtcSocket | undefined;
  let reauthTimer: ReturnType<typeof setTimeout> | undefined;

  /** Calls this app currently wants joined — same replay-on-reconnect
   *  reasoning as `socket.ts`'s `joinedBoards`. */
  const joinedSessions = new Map<string, string>();
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

  function buildSocket(): RtcSocket {
    const created: RtcSocket = io(`${deps.apiBaseUrl}/rtc`, {
      path: '/socket.io',
      autoConnect: false,
      ...TRANSPORT_OPTIONS,
      // Same native-client marker as `socket.ts` — see that module's header
      // on why this carries no forged `Origin`.
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
      // The default-namespace socket's own `session:ended` listener already
      // clears the session — this listener only drops ITS OWN connection so
      // it stops retrying with a token that is gone, mirroring `chat-
      // socket.ts`'s identical split.
      disconnect();
    });

    created.io.on('reconnect', () => {
      /* Rejoining matters more here than on any other namespace. A call
         whose signalling room was silently lost still LOOKS connected — the
         peer connections that already exist keep carrying audio — and then
         the next renegotiation, or the next person joining, never reaches
         this app. The symptom is "the third person could not hear me",
         which nobody reports as a reconnect bug. */
      for (const [sessionId, orgId] of joinedSessions) {
        created.emit('rtc:join', { orgId, sessionId }, () => {
          // Best-effort — a call that ended while disconnected answers
          // through the ack and there is nothing further to do.
        });
      }

      for (const listener of reconnectListeners) listener();
    });

    return created;
  }

  function ensureSocket(): RtcSocket {
    socket ??= buildSocket();
    return socket;
  }

  async function joinCallRoom(orgId: string, sessionId: string): Promise<boolean> {
    const active = ensureSocket();
    if (!active.connected) active.connect();

    // Recorded BEFORE the emit, regardless of the ack — see `socket.ts`'s
    // `joinBoardRoom` for why recording it inside the ack instead loses
    // exactly the join that was in flight when a connection drops.
    joinedSessions.set(sessionId, orgId);

    return new Promise((resolve) => {
      active.emit('rtc:join', { orgId, sessionId }, (result) => {
        resolve(result.ok);
      });
    });
  }

  function leaveCallRoom(sessionId: string): void {
    joinedSessions.delete(sessionId);
    socket?.emit('rtc:leave', { sessionId });
  }

  function sendSignal(sessionId: string, to: string, kind: SignalKind, data: string): void {
    socket?.emit('rtc:signal', { sessionId, to, kind, data });
  }

  function onSignal(handler: (message: RtcSignalMessage) => void): () => void {
    const active = ensureSocket();
    active.on('rtc:signal', handler);
    return () => active.off('rtc:signal', handler);
  }

  function onPeers(handler: (message: RtcPeersMessage) => void): () => void {
    const active = ensureSocket();
    active.on('rtc:peers', handler);
    return () => active.off('rtc:peers', handler);
  }

  function onCallRoomClosed(handler: (message: RtcClosedMessage) => void): () => void {
    const active = ensureSocket();
    active.on('rtc:closed', handler);
    return () => active.off('rtc:closed', handler);
  }

  function onReconnect(handler: () => void): () => void {
    ensureSocket();
    reconnectListeners.add(handler);
    return () => reconnectListeners.delete(handler);
  }

  function disconnect(): void {
    if (reauthTimer !== undefined) clearTimeout(reauthTimer);
    joinedSessions.clear();
    reconnectListeners.clear();
    socket?.disconnect();
    socket = undefined;
  }

  return {
    joinCallRoom,
    leaveCallRoom,
    sendSignal,
    onSignal,
    onPeers,
    onCallRoomClosed,
    onReconnect,
    disconnect,
  };
}
