import { io, type Socket } from 'socket.io-client';
import type { ChannelId } from '@taskflow/contracts';
import { config } from './config.js';
import { accessToken } from './session.js';

/**
 * The chat namespace connection (ai/phase-5-chat.md §3.2, §3.3).
 *
 * A second Socket.io namespace (`/chat`) on the SAME gateway process `socket.ts`
 * already connects to — not a second connection. Calling `io()` again with a
 * different namespace path but the same base URL and options reuses the
 * existing Engine.IO Manager rather than opening a new transport, which is what
 * keeps this "one socket per tab" (§3.2's own requirement) rather than doubling
 * the connection count the moment a chat page is open alongside a board.
 *
 * Structurally this file mirrors `socket.ts` exactly — same lazy connect, same
 * reconnect-replay, same "record before the emit, not inside the ack" ordering
 * — because §3.2 is explicit that chat adds zero new authentication code. The
 * two are not merged into one module because `ChatBroadcastMessage` and
 * `BroadcastMessage` are deliberately separate types (wire.ts's own reasoning):
 * a shared type would let a board listener silently accept a chat broadcast it
 * has no handler for, with the compiler agreeing.
 *
 * `TRANSPORT_OPTIONS` is the one exception to "mirrors socket.ts exactly" being
 * a single shared constant instead of an import — see `socket.ts`'s own note on
 * why the transport order is `['websocket', 'polling']` rather than the
 * library default. Duplicated rather than imported for the same reason the
 * rest of this file duplicates `socket.ts`'s shape instead of importing from
 * it: each namespace's connection module should be readable on its own.
 */
const TRANSPORT_OPTIONS = {
  transports: ['websocket', 'polling'] as string[],
  tryAllTransports: true,
};

/** Server -> client payloads this module understands. Mirrors apps/realtime's wire.ts. */
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

let socket: ChatSocket | undefined;

/** Channels this tab currently wants joined — same replay-on-reconnect reasoning as `joinedBoards`. */
const joinedChannels = new Map<ChannelId, string>();

const reconnectListeners = new Set<() => void>();

function buildSocket(): ChatSocket {
  const created: ChatSocket = io(`${config.apiBaseUrl}/chat`, {
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
    // Handled fully by the default-namespace socket's own `session:ended`
    // listener (`socket.ts`), which clears the session and calls
    // `disconnectSocket()`. This namespace only needs to drop its own
    // connection so it does not keep retrying with a token that is gone.
    disconnectChatSocket();
  });

  created.io.on('reconnect', () => {
    for (const [channelId, orgId] of joinedChannels) {
      created.emit('channel:join', { orgId, channelId }, () => {
        // Best-effort, same as the board namespace — a revoked grant answers
        // through the ack and there is nothing further to do here.
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

/** Joins `channel:{channelId}`'s room. Returns whether the join was granted. */
export async function joinChannelRoom(orgId: string, channelId: ChannelId): Promise<boolean> {
  const active = ensureSocket();
  if (!active.connected) active.connect();

  // Recorded before the emit, not inside the ack — see `socket.ts`'s note on
  // `joinBoardRoom` for why: an ack that never arrives because the connection
  // dropped in flight must not mean this room is never replayed on reconnect.
  joinedChannels.set(channelId, orgId);

  return new Promise((resolve) => {
    active.emit('channel:join', { orgId, channelId }, (result) => {
      resolve(result.ok);
    });
  });
}

export function leaveChannelRoom(channelId: ChannelId): void {
  joinedChannels.delete(channelId);
  socket?.emit('channel:leave', { channelId });
}

export function onChatReconnect(handler: () => void): () => void {
  ensureSocket();
  reconnectListeners.add(handler);
  return () => reconnectListeners.delete(handler);
}

export function onChatBroadcast(handler: (message: ChatBroadcastMessage) => void): () => void {
  const active = ensureSocket();
  active.on('broadcast', handler);
  return () => active.off('broadcast', handler);
}

export function onChannelClosed(handler: (message: ChannelClosedMessage) => void): () => void {
  const active = ensureSocket();
  active.on('channel:closed', handler);
  return () => active.off('channel:closed', handler);
}

/**
 * Typing indicators. No ack, no persisted state, no domain event — see
 * `apps/api/src/chat/events.ts`'s header on why. Best-effort only: if the
 * socket is not connected the emit is silently dropped, which is the correct
 * behaviour for a signal nobody needs delivered reliably.
 */
export function startTyping(channelId: ChannelId): void {
  socket?.emit('typing:start', { channelId });
}

export function stopTyping(channelId: ChannelId): void {
  socket?.emit('typing:stop', { channelId });
}

export function onTyping(handler: (message: TypingMessage) => void): () => void {
  const active = ensureSocket();
  active.on('typing', handler);
  return () => active.off('typing', handler);
}

/** Torn down on sign-out, alongside the board socket (`shell.tsx`). */
export function disconnectChatSocket(): void {
  joinedChannels.clear();
  reconnectListeners.clear();
  socket?.disconnect();
  socket = undefined;
}

export type { ChannelClosedMessage, ChatBroadcastMessage, TypingMessage };
