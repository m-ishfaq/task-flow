import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelId } from '@taskflow/contracts';
import { CLIENT_HEADER, MOBILE_CLIENT } from '@taskflow/contracts';

/**
 * The `/chat` namespace connection's reconnect contract — mirrors
 * `socket.ts`'s own `socket.test.ts` exactly, adapted for
 * `channel:join`/`channel:leave`/`typing:start`/`typing:stop` in place of
 * `board:join`/`board:leave`. See that file's own header for why
 * `socket.io-client` is mocked (client-side bookkeeping under test, a real
 * socket adds a network to the part that has none) and why this needs no
 * `vi.resetModules()` dance (a factory, not a singleton).
 */

const handlers = new Map<string, (payload: unknown) => void>();
const managerHandlers = new Map<string, () => void>();
const emits: { event: string; payload: unknown }[] = [];
let ioUrl = '';
let ioOptions: Record<string, unknown> = {};

let connected = false;
let disconnectCalls = 0;
let acksArrive = true;

const fakeSocket = {
  get connected() {
    return connected;
  },
  connect: () => {
    connected = true;
    return fakeSocket;
  },
  disconnect: () => {
    disconnectCalls += 1;
    connected = false;
    return fakeSocket;
  },
  on: (event: string, handler: (payload: unknown) => void) => {
    handlers.set(event, handler);
    return fakeSocket;
  },
  off: (event: string) => {
    handlers.delete(event);
    return fakeSocket;
  },
  emit: (event: string, payload: unknown, ack?: (result: unknown) => void) => {
    emits.push({ event, payload });
    if (acksArrive) ack?.({ ok: true });
    return fakeSocket;
  },
  io: {
    on: (event: string, handler: () => void) => {
      managerHandlers.set(event, handler);
    },
  },
};

vi.mock('socket.io-client', () => ({
  io: (url: string, options: Record<string, unknown>) => {
    ioUrl = url;
    ioOptions = options;
    return fakeSocket;
  },
}));

const CHANNEL_A = 'channel-a' as ChannelId;
const CHANNEL_B = 'channel-b' as ChannelId;
const ORG = 'org-1';

async function loadChatSocketModule() {
  handlers.clear();
  managerHandlers.clear();
  emits.length = 0;
  ioUrl = '';
  ioOptions = {};
  connected = false;
  disconnectCalls = 0;
  acksArrive = true;
  return import('./chat-socket.js');
}

let chatSocketModule: Awaited<ReturnType<typeof loadChatSocketModule>>;
let createMobileChatSocket: Awaited<
  ReturnType<typeof loadChatSocketModule>
>['createMobileChatSocket'];

function fakeDeps() {
  return {
    apiBaseUrl: 'https://api.test',
    accessToken: () => Promise.resolve('a.fake.token'),
    getExpiresAt: () => Date.now() + 600_000,
  };
}

beforeEach(async () => {
  chatSocketModule = await loadChatSocketModule();
  createMobileChatSocket = chatSocketModule.createMobileChatSocket;
});

afterEach(() => {
  vi.clearAllMocks();
});

function fireReconnect(): void {
  managerHandlers.get('reconnect')?.();
}

const joinEmits = () => emits.filter((entry) => entry.event === 'channel:join');
const typingEmits = () => emits.filter((entry) => entry.event.startsWith('typing:'));

describe('connecting to the /chat namespace', () => {
  it('connects to the /chat path on the same API host, carrying the native client marker', async () => {
    const socket = createMobileChatSocket(fakeDeps());
    await socket.joinChannelRoom(ORG, CHANNEL_A);

    expect(ioUrl).toBe('https://api.test/chat');
    const extraHeaders = ioOptions['extraHeaders'] as Record<string, string>;
    expect(extraHeaders[CLIENT_HEADER]).toBe(MOBILE_CLIENT);
    expect(extraHeaders['origin']).toBeUndefined();
    expect(extraHeaders['Origin']).toBeUndefined();
  });
});

describe('rejoining rooms after a reconnect', () => {
  it('replays channel:join for every channel this app still has open', async () => {
    const socket = createMobileChatSocket(fakeDeps());
    await socket.joinChannelRoom(ORG, CHANNEL_A);
    await socket.joinChannelRoom(ORG, CHANNEL_B);
    expect(joinEmits()).toHaveLength(2);

    fireReconnect();

    expect(joinEmits()).toHaveLength(4);
    expect(
      joinEmits()
        .slice(2)
        .map((entry) => entry.payload),
    ).toEqual([
      { orgId: ORG, channelId: CHANNEL_A },
      { orgId: ORG, channelId: CHANNEL_B },
    ]);
  });

  it('replays a join whose ack never came back', () => {
    acksArrive = false;
    const socket = createMobileChatSocket(fakeDeps());

    void socket.joinChannelRoom(ORG, CHANNEL_A);
    expect(joinEmits()).toHaveLength(1);

    acksArrive = true;
    fireReconnect();

    expect(
      joinEmits()
        .slice(1)
        .map((entry) => entry.payload),
    ).toEqual([{ orgId: ORG, channelId: CHANNEL_A }]);
  });

  it('does not replay a channel this app has left', async () => {
    const socket = createMobileChatSocket(fakeDeps());
    await socket.joinChannelRoom(ORG, CHANNEL_A);
    await socket.joinChannelRoom(ORG, CHANNEL_B);
    socket.leaveChannelRoom(CHANNEL_A);

    const before = joinEmits().length;
    fireReconnect();

    expect(
      joinEmits()
        .slice(before)
        .map((entry) => entry.payload),
    ).toEqual([{ orgId: ORG, channelId: CHANNEL_B }]);
  });

  it('notifies reconnect listeners so the caller can refetch', async () => {
    const socket = createMobileChatSocket(fakeDeps());
    const seen = vi.fn();
    socket.onReconnect(seen);
    await socket.joinChannelRoom(ORG, CHANNEL_A);

    expect(seen).not.toHaveBeenCalled();

    fireReconnect();
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('stops notifying a listener that unsubscribed', async () => {
    const socket = createMobileChatSocket(fakeDeps());
    const seen = vi.fn();
    const off = socket.onReconnect(seen);
    await socket.joinChannelRoom(ORG, CHANNEL_A);
    off();

    fireReconnect();
    expect(seen).not.toHaveBeenCalled();
  });
});

describe('typing indicators', () => {
  it('emits typing:start and typing:stop for the given channel', async () => {
    const socket = createMobileChatSocket(fakeDeps());
    await socket.joinChannelRoom(ORG, CHANNEL_A);

    socket.startTyping(CHANNEL_A);
    socket.stopTyping(CHANNEL_A);

    expect(typingEmits().map((entry) => [entry.event, entry.payload])).toEqual([
      ['typing:start', { channelId: CHANNEL_A }],
      ['typing:stop', { channelId: CHANNEL_A }],
    ]);
  });

  it('drops the signal silently when there is no connection yet', () => {
    const socket = createMobileChatSocket(fakeDeps());

    socket.startTyping(CHANNEL_A);

    expect(typingEmits()).toHaveLength(0);
  });

  it('delivers incoming typing messages to subscribers', async () => {
    const socket = createMobileChatSocket(fakeDeps());
    const seen = vi.fn();
    socket.onTyping(seen);
    await socket.joinChannelRoom(ORG, CHANNEL_A);

    handlers.get('typing')?.({ channelId: CHANNEL_A, userId: 'user-2', typing: true });

    expect(seen).toHaveBeenCalledWith({ channelId: CHANNEL_A, userId: 'user-2', typing: true });
  });
});

describe('tearing the connection down', () => {
  it('forgets tracked rooms, so the next sign-in does not inherit them', async () => {
    const socket = createMobileChatSocket(fakeDeps());
    await socket.joinChannelRoom(ORG, CHANNEL_A);

    socket.disconnect();
    expect(disconnectCalls).toBe(1);

    emits.length = 0;
    socket.onReconnect(() => undefined);
    fireReconnect();
    expect(joinEmits()).toHaveLength(0);
  });

  it('drops its own socket when the gateway ends the session, with no callback of its own', async () => {
    // Unlike the default-namespace socket, this listener has no
    // `onSessionEnded` to call at all — see the module header: clearing the
    // session is `socket.ts`'s `gatewaySocket` listener's job, not this
    // namespace's. This test's only assertion is the connection teardown.
    const socket = createMobileChatSocket(fakeDeps());
    await socket.joinChannelRoom(ORG, CHANNEL_A);

    handlers.get('session:ended')?.({ reason: 'session_revoked' });

    expect(disconnectCalls).toBe(1);
  });
});
