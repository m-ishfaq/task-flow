import { io, type Socket } from 'socket.io-client';
import type { ChannelId } from '@taskflow/contracts';
import { CLIENT_HEADER, MOBILE_CLIENT } from '@taskflow/contracts';

/**
 * The `/chat` namespace connection — mirrors `apps/web/src/lib/chat-socket.ts`,
 * which is itself a second Socket.io namespace on the SAME gateway process
 * `socket.ts` already connects to, not a second connection: calling `io()`
 * again with a different namespace path but the same base URL/transport
 * options reuses the existing Engine.IO Manager. Structurally this file
 * mirrors THIS app's own `socket.ts` exactly — same DI-factory shape (see
 * that file's header for why apps/mobile is a factory where apps/web is a
 * singleton), same reconnect-replay, same "record before the emit, not
 * inside the ack" ordering — duplicated rather than shared for the same
 * reason web's two socket files stay separate: each namespace's connection
 * module should be readable on its own, and `ChatBroadcastMessage` is
 * deliberately its own type so a board listener can never silently accept a
 * chat broadcast it has no handler for.
 *
 * `ChatSocketDeps` has no `onSessionEnded`, unlike `socket.ts`'s `SocketDeps`
 * — deliberately: this namespace's own `session:ended` handler below tears
 * down only ITS OWN connection, exactly as web's `chat-socket.ts` does,
 * because the default-namespace socket's `session:ended` listener is what
 * actually clears the session (`app-session.ts`'s `gatewaySocket`). Giving
 * this module a callback it would never call is a config knob that lies
 * about doing something.
 *
 * Typing indicators are the one thing here with no `socket.ts` equivalent:
 * in-process only, no ack, no persisted state, no domain event
 * (`apps/api/src/chat/events.ts`'s own documented exclusion) — a signal that
 * dies with the connection, best-effort by design, ported from
 * `apps/web/src/lib/chat-socket.ts`'s own `startTyping`/`stopTyping`/`onTyping`.
 */
const TRANSPORT_OPTIONS = {
  transports: ['websocket', 'polling'] as string[],
  tryAllTransports: true,
};

interface ReadyMessage {
  readonly reauthLeadSeconds: number;
}
interface ChatBroadcastMessage {
  readonly name: string;
  readonly version: number;
  readonly orgId: string;
  readonly channelId: string;
  readonly actorId: string | null;
  readonly mutationId: string | null;
  readonly occurredAt: string;
  readonly payload: unknown;
}
interface ChannelClosedMessage {
  readonly channelId: string;
}
interface SessionEndedMessage {
  readonly reason: 'session_revoked' | 'token_reuse_detected';
}
interface TypingMessage {
  readonly channelId: string;
  readonly userId: string;
  readonly typing: boolean;
}

interface ServerToClientEvents {
  ready: (message: ReadyMessage) => void;
  broadcast: (message: ChatBroadcastMessage) => void;
  'channel:closed': (message: ChannelClosedMessage) => void;
  'session:ended': (message: SessionEndedMessage) => void;
  typing: (message: TypingMessage) => void;
}
interface ClientToServerEvents {
  'channel:join': (
    request: { orgId: string; channelId: ChannelId },
    ack: (result: { ok: true } | { ok: false; reason: string }) => void,
  ) => void;
  'channel:leave': (request: { channelId: ChannelId }) => void;
  'typing:start': (request: { channelId: ChannelId }) => void;
  'typing:stop': (request: { channelId: ChannelId }) => void;
}

type ChatSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export interface ChatSocketDeps {
  readonly apiBaseUrl: string;
  /** From `MobileSession.accessToken` — single-flight, refreshes if needed. */
  accessToken(): Promise<string | null>;
  /** From `MobileSession.store.getState().expiresAt`, read fresh on every
   *  `ready` — see `socket.ts`'s identical port for why. */
  getExpiresAt(): number | null;
}

export interface MobileChatSocket {
  /** Joins `channel:{channelId}`'s room. Returns whether the join was granted. */
  joinChannelRoom(orgId: string, channelId: ChannelId): Promise<boolean>;
  leaveChannelRoom(channelId: ChannelId): void;
  /** Runs `handler` after every RECONNECT, never the first connection. */
  onReconnect(handler: () => void): () => void;
  onBroadcast(handler: (message: ChatBroadcastMessage) => void): () => void;
  onChannelClosed(handler: (message: ChannelClosedMessage) => void): () => void;
  /** Best-effort: silently dropped if the socket is not connected, which is
   *  correct for a signal nobody needs delivered reliably. */
  startTyping(channelId: ChannelId): void;
  stopTyping(channelId: ChannelId): void;
  onTyping(handler: (message: TypingMessage) => void): () => void;
  /** Tears the connection down entirely. Called on sign-out. */
  disconnect(): void;
}

/**
 * Builds a `/chat` namespace connection bound to one session's token source.
 * See `socket.ts`'s `createMobileSocket` for the reasoning this mirrors.
 */
export function createMobileChatSocket(deps: ChatSocketDeps): MobileChatSocket {
  let socket: ChatSocket | undefined;
  let reauthTimer: ReturnType<typeof setTimeout> | undefined;

  /** Channels this app currently wants joined — same replay-on-reconnect
   *  reasoning as `socket.ts`'s `joinedBoards`. */
  const joinedChannels = new Map<ChannelId, string>();
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

  function buildSocket(): ChatSocket {
    const created: ChatSocket = io(`${deps.apiBaseUrl}/chat`, {
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
      // clears the session (`deps.onSessionEnded`, called once from there) —
      // this listener only needs to drop ITS OWN connection so it stops
      // retrying with a token that is gone, mirroring web's identical split
      // between `socket.ts` and `chat-socket.ts`.
      disconnect();
    });

    created.io.on('reconnect', () => {
      for (const [channelId, orgId] of joinedChannels) {
        created.emit('channel:join', { orgId, channelId }, () => {
          /* Best-effort — see `socket.ts`'s identical handler for why there
             is no further error path here. */
        });
      }

      for (const listener of reconnectListeners) listener();
    });

    return created;
  }

  function ensureSocket(): ChatSocket {
    socket ??= buildSocket();
    return socket;
  }

  async function joinChannelRoom(orgId: string, channelId: ChannelId): Promise<boolean> {
    const active = ensureSocket();
    if (!active.connected) active.connect();

    // Recorded BEFORE the emit, regardless of the ack — see `socket.ts`'s
    // `joinBoardRoom` for why recording it inside the ack instead loses
    // exactly the join that was in flight when a connection drops.
    joinedChannels.set(channelId, orgId);

    return new Promise((resolve) => {
      active.emit('channel:join', { orgId, channelId }, (result) => {
        resolve(result.ok);
      });
    });
  }

  function leaveChannelRoom(channelId: ChannelId): void {
    joinedChannels.delete(channelId);
    socket?.emit('channel:leave', { channelId });
  }

  function onReconnect(handler: () => void): () => void {
    ensureSocket();
    reconnectListeners.add(handler);
    return () => reconnectListeners.delete(handler);
  }

  function onBroadcast(handler: (message: ChatBroadcastMessage) => void): () => void {
    const active = ensureSocket();
    active.on('broadcast', handler);
    return () => active.off('broadcast', handler);
  }

  function onChannelClosed(handler: (message: ChannelClosedMessage) => void): () => void {
    const active = ensureSocket();
    active.on('channel:closed', handler);
    return () => active.off('channel:closed', handler);
  }

  function startTyping(channelId: ChannelId): void {
    socket?.emit('typing:start', { channelId });
  }

  function stopTyping(channelId: ChannelId): void {
    socket?.emit('typing:stop', { channelId });
  }

  function onTyping(handler: (message: TypingMessage) => void): () => void {
    const active = ensureSocket();
    active.on('typing', handler);
    return () => active.off('typing', handler);
  }

  function disconnect(): void {
    if (reauthTimer !== undefined) clearTimeout(reauthTimer);
    joinedChannels.clear();
    reconnectListeners.clear();
    socket?.disconnect();
    socket = undefined;
  }

  return {
    joinChannelRoom,
    leaveChannelRoom,
    onReconnect,
    onBroadcast,
    onChannelClosed,
    startTyping,
    stopTyping,
    onTyping,
    disconnect,
  };
}

export type { ChannelClosedMessage, ChatBroadcastMessage, TypingMessage };
