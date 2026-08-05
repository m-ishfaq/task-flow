import { describe, expect, it } from 'vitest';
import type { UserId } from '@taskflow/contracts';
import { broadcastPresence, presenceMembersOf } from './presence.js';
import type { GatewayServer } from './socket-data.js';

/**
 * Presence (ai/phase-4-realtime.md §5 Wave 2, §9).
 *
 * Fakes `io.in(room).fetchSockets()` directly rather than a full Socket.io
 * server — what matters here is `presenceMembersOf`'s own logic (dedup, empty
 * room) and that `broadcastPresence` emits to the room it computed, not
 * Socket.io's own room-membership mechanics, which are exercised for real in
 * the live smoke test this phase was verified against.
 */

function fakeIo(remoteUserIds: readonly UserId[]): {
  io: GatewayServer;
  emittedTo: { room: string; event: string; payload: unknown }[];
} {
  const emittedTo: { room: string; event: string; payload: unknown }[] = [];

  const io = {
    in: (_room: string) => ({
      fetchSockets: () =>
        Promise.resolve(remoteUserIds.map((userId) => ({ data: { identity: { userId } } }))),
    }),
    to: (room: string) => ({
      emit: (event: string, payload: unknown) => {
        emittedTo.push({ room, event, payload });
      },
    }),
  } as unknown as GatewayServer;

  return { io, emittedTo };
}

const ALICE = 'alice' as UserId;
const BOB = 'bob' as UserId;

describe('presenceMembersOf', () => {
  it('returns the distinct user ids currently in the room', async () => {
    const { io } = fakeIo([ALICE, BOB]);

    const members = await presenceMembersOf(io, 'board-1');

    expect([...members].sort()).toEqual([ALICE, BOB].sort());
  });

  it('deduplicates a user holding more than one socket in the room', async () => {
    // Two tabs, one person — a real case: `fetchSockets()` returns one entry
    // per SOCKET, not per user, and a `Set` is what makes it once per user.
    const { io } = fakeIo([ALICE, ALICE, BOB]);

    const members = await presenceMembersOf(io, 'board-1');

    expect(members).toHaveLength(2);
    expect([...members].sort()).toEqual([ALICE, BOB].sort());
  });

  it('returns an empty list for a room with nobody in it', async () => {
    const { io } = fakeIo([]);

    expect(await presenceMembersOf(io, 'board-1')).toEqual([]);
  });
});

describe('broadcastPresence', () => {
  it('emits the current membership to the board room, as a full list', async () => {
    const { io, emittedTo } = fakeIo([ALICE, BOB]);

    await broadcastPresence(io, 'board-1');

    expect(emittedTo).toHaveLength(1);
    expect(emittedTo[0]?.room).toBe('board:board-1');
    expect(emittedTo[0]?.event).toBe('presence');
    const payload = emittedTo[0]?.payload as { boardId: string; userIds: readonly string[] };
    expect(payload.boardId).toBe('board-1');
    expect([...payload.userIds].sort()).toEqual([ALICE, BOB].sort());
  });

  it('still emits an (empty) list for an empty room, rather than skipping the broadcast', async () => {
    // A room going from one member to zero is a real transition a client
    // needs to hear about — skipping the call here would leave the last
    // viewer's stale avatar on everyone else's screen forever.
    const { io, emittedTo } = fakeIo([]);

    await broadcastPresence(io, 'board-1');

    expect(emittedTo).toHaveLength(1);
    const payload = emittedTo[0]?.payload as { userIds: readonly string[] };
    expect(payload.userIds).toEqual([]);
  });
});
