import { io, type Socket } from 'socket.io-client';
import { config } from './config.js';
import { accessToken } from './session.js';

/**
 * The in-app voice signalling connection (ai/phase-13-webrtc.md §3.1, §3.2).
 *
 * A third Socket.io namespace (`/rtc`) on the SAME gateway process `socket.ts`
 * and `chat-socket.ts` already connect to — not a third connection. Calling
 * `io()` again with a different namespace path but the same base URL reuses the
 * existing Engine.IO Manager, which is what keeps this "one socket per tab".
 *
 * Structurally it mirrors `chat-socket.ts`, which mirrors `socket.ts`, for the
 * reason that file gives: each namespace's connection module should be readable
 * on its own, and the duplication is what makes the shared invariants visible in
 * three places rather than hidden behind one abstraction.
 *
 * ## What this module does NOT do
 *
 * It does not decide who may be in a call. `rtc:join`'s ack is the server's
 * `can()` decision, made against the session's CHANNEL — a refusal here means
 * the call is not joinable and there is nothing to retry with different data.
 *
 * It does not carry the call RECORD. Who called, who joined, how long, all go
 * through `apps/api`'s `rtc.*` routes. This socket carries SDP and ICE and
 * nothing that outlives the call.
 *
 * ## `sendSignal` names a peer, and the server does not trust the name
 *
 * `to` is a user id, and it is a SELECTOR the gateway resolves against the room
 * roster it holds — never a routing key (§3.2). That is a server-side property
 * and nothing here can weaken it; it is written down because the field looks, on
 * this side, exactly like an address.
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

let socket: RtcSocket | undefined;

/** Calls this tab currently wants joined — same replay-on-reconnect reasoning as `joinedBoards`. */
const joinedSessions = new Map<string, string>();

const reconnectListeners = new Set<() => void>();

function buildSocket(): RtcSocket {
  const created: RtcSocket = io(`${config.apiBaseUrl}/rtc`, {
    path: '/socket.io',
    autoConnect: false,
    ...TRANSPORT_OPTIONS,
    auth: (callback) => {
      void accessToken().then((token) => {
        callback({ token: token ?? '' });
      });
    },
  });

  created.on('session:ended', () => {
    // Handled fully by the default-namespace socket's own listener, which
    // clears the session. This namespace only drops its own connection so it
    // does not keep retrying with a token that is gone.
    disconnectRtcSocket();
  });

  created.io.on('reconnect', () => {
    /* Rejoining matters more here than on any other namespace. A call whose
       signalling room was silently lost still LOOKS connected — the peer
       connections that already exist keep carrying audio — and then the next
       renegotiation, or the next person joining, never reaches this tab. The
       symptom is "the third person could not hear me", which nobody reports as
       a reconnect bug. */
    for (const [sessionId, orgId] of joinedSessions) {
      created.emit('rtc:join', { orgId, sessionId }, () => {
        // Best-effort — a call that ended while we were disconnected answers
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

/** Joins `rtc:{sessionId}`'s signalling room. Returns whether it was granted. */
export async function joinCallRoom(orgId: string, sessionId: string): Promise<boolean> {
  const active = ensureSocket();
  if (!active.connected) active.connect();

  // Recorded before the emit, not inside the ack — see `socket.ts`'s note on
  // `joinBoardRoom`: an ack that never arrives because the connection dropped
  // in flight must not mean this room is never replayed on reconnect.
  joinedSessions.set(sessionId, orgId);

  return new Promise((resolve) => {
    active.emit('rtc:join', { orgId, sessionId }, (result) => {
      resolve(result.ok);
    });
  });
}

export function leaveCallRoom(sessionId: string): void {
  joinedSessions.delete(sessionId);
  socket?.emit('rtc:leave', { sessionId });
}

/**
 * Sends one signalling message to one peer.
 *
 * Best-effort with no ack, deliberately: WebRTC's own negotiation already
 * retries what matters (ICE candidates are additive, an offer without an answer
 * times out and is retried by the caller), and an ack on this event would tell a
 * sender whether the named peer is present — an oracle for who is in which call.
 */
export function sendSignal(
  sessionId: string,
  to: string,
  kind: SignalKind,
  data: string,
): void {
  socket?.emit('rtc:signal', { sessionId, to, kind, data });
}

export function onSignal(handler: (message: RtcSignalMessage) => void): () => void {
  const active = ensureSocket();
  active.on('rtc:signal', handler);
  return () => active.off('rtc:signal', handler);
}

/** Who is in the call's room right now. The full list, never a delta. */
export function onPeers(handler: (message: RtcPeersMessage) => void): () => void {
  const active = ensureSocket();
  active.on('rtc:peers', handler);
  return () => active.off('rtc:peers', handler);
}

/** The gateway evicted this tab — a grant changed underneath a live call. */
export function onCallRoomClosed(handler: (message: RtcClosedMessage) => void): () => void {
  const active = ensureSocket();
  active.on('rtc:closed', handler);
  return () => active.off('rtc:closed', handler);
}

export function onRtcReconnect(handler: () => void): () => void {
  ensureSocket();
  reconnectListeners.add(handler);
  return () => reconnectListeners.delete(handler);
}

/** Torn down on sign-out, alongside the board and chat sockets (`shell.tsx`). */
export function disconnectRtcSocket(): void {
  joinedSessions.clear();
  reconnectListeners.clear();
  socket?.disconnect();
  socket = undefined;
}
