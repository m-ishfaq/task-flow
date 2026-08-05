import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardId } from '@taskflow/contracts';

/**
 * The gateway connection's reconnect contract (ai/phase-4-realtime.md §9, §7.1).
 *
 * ## Why this file exists
 *
 * Everything here is invisible when it breaks. A tab that fails to rejoin its
 * room after a reconnect still renders, still answers clicks, and still shows
 * cards — because the 30-second polled query underneath (`query.ts`) keeps
 * working. It just stops being live, forever, with nothing logged and nothing
 * to notice. That is the failure mode these tests are for: not a crash, a
 * silent downgrade that looks exactly like a quiet board.
 *
 * `socket.io-client` is mocked rather than run against a real gateway. The
 * property under test is entirely client-side bookkeeping — WHICH joins get
 * replayed, and WHEN — and a real socket would only add a network to the part
 * that has no bearing on it. The gateway's own half is covered against real
 * Postgres in `apps/realtime`.
 */

/** The `io()` double, capturing every handler and emit the module registers. */
const handlers = new Map<string, (payload: unknown) => void>();
const managerHandlers = new Map<string, () => void>();
const emits: { event: string; payload: unknown }[] = [];

let connected = false;
let disconnectCalls = 0;

/**
 * Whether the double answers acks at all.
 *
 * Separate from `connected` on purpose. The case that matters is not "the
 * socket was never up" — it is "the join was sent, and the connection died
 * before the reply came back", which is indistinguishable from the caller's
 * side: the emit succeeds and the callback simply never runs. Modelling that
 * as a connection-state flag would let a test pass merely because the emit was
 * never attempted, which is a different (and harmless) situation.
 */
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
    // The emit itself always "succeeds" — see `acksArrive` above for why the
    // reply is what varies.
    if (acksArrive) ack?.({ ok: true });
    return fakeSocket;
  },
  io: {
    on: (event: string, handler: () => void) => {
      managerHandlers.set(event, handler);
    },
  },
};

vi.mock('socket.io-client', () => ({ io: () => fakeSocket }));

vi.mock('./session.js', () => ({
  accessToken: () => Promise.resolve('a.fake.token'),
  useSession: {
    getState: () => ({ expiresAt: Date.now() + 600_000, clear: () => undefined }),
  },
}));

const BOARD_A = 'board-a' as BoardId;
const BOARD_B = 'board-b' as BoardId;
const ORG = 'org-1';

/** Fresh module state per test — `joinedBoards` is module-level by design. */
async function loadSocketModule() {
  vi.resetModules();
  handlers.clear();
  managerHandlers.clear();
  emits.length = 0;
  connected = false;
  disconnectCalls = 0;
  acksArrive = true;
  return import('./socket.js');
}

let socketModule: Awaited<ReturnType<typeof loadSocketModule>>;

beforeEach(async () => {
  socketModule = await loadSocketModule();
});

afterEach(() => {
  vi.clearAllMocks();
});

/** Fires the Socket.io Manager's `reconnect`, as a real recovery would. */
function fireReconnect(): void {
  managerHandlers.get('reconnect')?.();
}

const joinEmits = () => emits.filter((entry) => entry.event === 'board:join');

describe('rejoining rooms after a reconnect', () => {
  it('replays board:join for every board this tab still has open', async () => {
    await socketModule.joinBoardRoom(ORG, BOARD_A);
    await socketModule.joinBoardRoom(ORG, BOARD_B);
    expect(joinEmits()).toHaveLength(2);

    fireReconnect();

    // Both boards asked for again — the gateway cleared its side of the
    // membership when the socket dropped, so a reconnect that only
    // re-authenticated would leave this tab silently receiving nothing.
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

  /**
   * The regression test for a real defect.
   *
   * The room used to be recorded inside the join's ACK callback. An ack only
   * arrives if the connection survives long enough to carry it back — so a
   * socket dropped between the emit and the ack (precisely the window a
   * reconnect exists to recover from) left the board unrecorded, and the
   * reconnect had nothing to replay. The tab then stayed on a board that
   * looked connected and received no broadcasts for the rest of its life.
   */
  it('replays a join whose ack never came back', () => {
    acksArrive = false;

    // Deliberately NOT awaited: the promise this returns never settles, which
    // is the whole scenario — the caller is left hanging and the bookkeeping
    // still has to be right.
    void socketModule.joinBoardRoom(ORG, BOARD_A);
    expect(joinEmits()).toHaveLength(1);

    acksArrive = true;
    fireReconnect();

    expect(
      joinEmits()
        .slice(1)
        .map((entry) => entry.payload),
    ).toEqual([{ orgId: ORG, boardId: BOARD_A }]);
  });

  it('does not replay a board the tab has left', async () => {
    await socketModule.joinBoardRoom(ORG, BOARD_A);
    await socketModule.joinBoardRoom(ORG, BOARD_B);
    socketModule.leaveBoardRoom(BOARD_A);

    const before = joinEmits().length;
    fireReconnect();

    expect(
      joinEmits()
        .slice(before)
        .map((entry) => entry.payload),
    ).toEqual([{ orgId: ORG, boardId: BOARD_B }]);
  });

  it('notifies reconnect listeners so the caller can refetch (§9 reconnect-and-diff)', async () => {
    const seen = vi.fn();
    socketModule.onReconnect(seen);
    await socketModule.joinBoardRoom(ORG, BOARD_A);

    // Not on the FIRST connection: there is nothing to diff against and no
    // membership to have lost, so firing here would invalidate every board
    // query on every page load.
    expect(seen).not.toHaveBeenCalled();

    fireReconnect();
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('stops notifying a listener that unsubscribed', async () => {
    const seen = vi.fn();
    const off = socketModule.onReconnect(seen);
    await socketModule.joinBoardRoom(ORG, BOARD_A);
    off();

    fireReconnect();
    expect(seen).not.toHaveBeenCalled();
  });
});

describe('tearing the connection down', () => {
  it('forgets tracked rooms, so the next sign-in on this tab does not inherit them', async () => {
    await socketModule.joinBoardRoom(ORG, BOARD_A);

    socketModule.disconnectSocket();
    expect(disconnectCalls).toBe(1);

    // A fresh socket, and nothing replayed onto it — the previous user's board
    // must not be rejoined under whoever signs in next.
    emits.length = 0;
    socketModule.onReconnect(() => undefined);
    fireReconnect();
    expect(joinEmits()).toHaveLength(0);
  });

  it('clears the session and drops the socket when the gateway ends it (§7.2)', async () => {
    await socketModule.joinBoardRoom(ORG, BOARD_A);

    handlers.get('session:ended')?.({ reason: 'session_revoked' });

    // The credential is gone; reconnecting with the same token would fail, so
    // this must not retry into a loop.
    expect(disconnectCalls).toBe(1);
  });
});
