import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardId } from '@taskflow/contracts';
import { CLIENT_HEADER, MOBILE_CLIENT } from '@taskflow/contracts';

/**
 * The gateway connection's reconnect contract, ported from apps/web's
 * `socket.test.ts` (ai/phase-14-mobile.md §5, §8).
 *
 * `socket.io-client` is mocked for the identical reason web's test gives:
 * the property under test is client-side bookkeeping (which joins get
 * replayed, and when), and a real socket would only add a network to the
 * part that has no bearing on it.
 *
 * Unlike web's version, this needs no `vi.resetModules()` dance between
 * tests — `createMobileSocket` is a factory, so each test builds its own
 * independent instance instead of resetting shared module state.
 */

const handlers = new Map<string, (payload: unknown) => void>();
const managerHandlers = new Map<string, () => void>();
const emits: { event: string; payload: unknown }[] = [];
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
  io: (_url: string, options: Record<string, unknown>) => {
    ioOptions = options;
    return fakeSocket;
  },
}));

const BOARD_A = 'board-a' as BoardId;
const BOARD_B = 'board-b' as BoardId;
const ORG = 'org-1';

async function loadSocketModule() {
  handlers.clear();
  managerHandlers.clear();
  emits.length = 0;
  ioOptions = {};
  connected = false;
  disconnectCalls = 0;
  acksArrive = true;
  return import('./socket.js');
}

let socketModule: Awaited<ReturnType<typeof loadSocketModule>>;
let createMobileSocket: Awaited<ReturnType<typeof loadSocketModule>>['createMobileSocket'];

/** Fresh deps per test: a fake token source, a fake expiry, a spy for the
 *  "session ended" callback. */
function fakeDeps() {
  const onSessionEnded = vi.fn();
  return {
    apiBaseUrl: 'https://api.test',
    accessToken: () => Promise.resolve('a.fake.token'),
    getExpiresAt: () => Date.now() + 600_000,
    onSessionEnded,
  };
}

beforeEach(async () => {
  socketModule = await loadSocketModule();
  createMobileSocket = socketModule.createMobileSocket;
});

afterEach(() => {
  vi.clearAllMocks();
});

function fireReconnect(): void {
  managerHandlers.get('reconnect')?.();
}

const joinEmits = () => emits.filter((entry) => entry.event === 'board:join');

describe('the native client marker (§8, interim — see auth.ts on the server)', () => {
  it('sends CLIENT_HEADER via extraHeaders, and sets no Origin of its own', async () => {
    const socket = createMobileSocket(fakeDeps());
    await socket.joinBoardRoom(ORG, BOARD_A);

    const extraHeaders = ioOptions['extraHeaders'] as Record<string, string>;
    expect(extraHeaders[CLIENT_HEADER]).toBe(MOBILE_CLIENT);
    // Deliberately does not fake an Origin — see socket.ts's own header for
    // why that would be a control that looks real and is not.
    expect(extraHeaders['origin']).toBeUndefined();
    expect(extraHeaders['Origin']).toBeUndefined();
  });
});

describe('rejoining rooms after a reconnect', () => {
  it('replays board:join for every board this app still has open', async () => {
    const socket = createMobileSocket(fakeDeps());
    await socket.joinBoardRoom(ORG, BOARD_A);
    await socket.joinBoardRoom(ORG, BOARD_B);
    expect(joinEmits()).toHaveLength(2);

    fireReconnect();

    expect(joinEmits()).toHaveLength(4);
    expect(
      joinEmits()
        .slice(2)
        .map((entry) => entry.payload),
    ).toEqual([
      { orgId: ORG, boardId: BOARD_A },
      { orgId: ORG, boardId: BOARD_B },
    ]);
  });

  it('replays a join whose ack never came back', () => {
    acksArrive = false;
    const socket = createMobileSocket(fakeDeps());

    void socket.joinBoardRoom(ORG, BOARD_A);
    expect(joinEmits()).toHaveLength(1);

    acksArrive = true;
    fireReconnect();

    expect(
      joinEmits()
        .slice(1)
        .map((entry) => entry.payload),
    ).toEqual([{ orgId: ORG, boardId: BOARD_A }]);
  });

  it('does not replay a board this app has left', async () => {
    const socket = createMobileSocket(fakeDeps());
    await socket.joinBoardRoom(ORG, BOARD_A);
    await socket.joinBoardRoom(ORG, BOARD_B);
    socket.leaveBoardRoom(BOARD_A);

    const before = joinEmits().length;
    fireReconnect();

    expect(
      joinEmits()
        .slice(before)
        .map((entry) => entry.payload),
    ).toEqual([{ orgId: ORG, boardId: BOARD_B }]);
  });

  it('notifies reconnect listeners so the caller can refetch (§9 reconnect-and-diff)', async () => {
    const socket = createMobileSocket(fakeDeps());
    const seen = vi.fn();
    socket.onReconnect(seen);
    await socket.joinBoardRoom(ORG, BOARD_A);

    expect(seen).not.toHaveBeenCalled();

    fireReconnect();
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('stops notifying a listener that unsubscribed', async () => {
    const socket = createMobileSocket(fakeDeps());
    const seen = vi.fn();
    const off = socket.onReconnect(seen);
    await socket.joinBoardRoom(ORG, BOARD_A);
    off();

    fireReconnect();
    expect(seen).not.toHaveBeenCalled();
  });
});

describe('tearing the connection down', () => {
  it('forgets tracked rooms, so the next sign-in does not inherit them', async () => {
    const socket = createMobileSocket(fakeDeps());
    await socket.joinBoardRoom(ORG, BOARD_A);

    socket.disconnect();
    expect(disconnectCalls).toBe(1);

    emits.length = 0;
    socket.onReconnect(() => undefined);
    fireReconnect();
    expect(joinEmits()).toHaveLength(0);
  });

  it('calls onSessionEnded and drops the socket when the gateway ends it (§7.2)', async () => {
    const deps = fakeDeps();
    const socket = createMobileSocket(deps);
    await socket.joinBoardRoom(ORG, BOARD_A);

    handlers.get('session:ended')?.({ reason: 'session_revoked' });

    expect(deps.onSessionEnded).toHaveBeenCalledTimes(1);
    expect(disconnectCalls).toBe(1);
  });
});
