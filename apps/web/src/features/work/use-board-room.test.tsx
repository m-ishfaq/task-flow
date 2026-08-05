import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook } from '@testing-library/react';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardId } from '@taskflow/contracts';
import { keys } from '../../lib/query.js';
import type { BroadcastMessage } from '../../lib/socket.js';
import type { CardSummary } from './api.js';

/**
 * Applying a broadcast to the board's cache (ai/phase-4-realtime.md §5 Wave 2).
 *
 * ## What is actually at risk here
 *
 * `use-board-room.ts` chooses one of three strategies per event — PATCH the
 * field, ADJUST a counter by a delta, or INVALIDATE — and every way of getting
 * that wrong is silent. A patch that writes the wrong field leaves a card
 * rendering stale data that looks current. A counter adjusted in the wrong
 * direction produces a badge nothing ever corrects, because the next event
 * adjusts the wrong number again. An event routed to INVALIDATE when it could
 * have been patched is merely slower; an event PATCHED when it should have been
 * invalidated shows a card the server would not have returned.
 *
 * None of that surfaces as an error, which is why the delta arithmetic in
 * particular is asserted here rather than trusted to review.
 *
 * The socket module is mocked so the handler can be driven directly — the
 * transport is covered in `lib/socket.test.ts`, and the gateway's half against
 * real Postgres in `apps/realtime`.
 */

const listeners = {
  broadcast: new Set<(message: BroadcastMessage) => void>(),
  presence: new Set<(message: { boardId: string; userIds: readonly string[] }) => void>(),
  roomClosed: new Set<(message: { boardId: string }) => void>(),
  reconnect: new Set<() => void>(),
};

/* Typed with their real parameters, not bare `vi.fn()`. The assertions below
   are `toHaveBeenCalledWith(ORG, BOARD)` — against an untyped mock those
   arguments are `any`, so a call with the org and board transposed would still
   satisfy the test. */
const joinBoardRoom = vi.fn((_orgId: string, _boardId: BoardId) => Promise.resolve(true));
const leaveBoardRoom = vi.fn((_boardId: BoardId) => undefined);

vi.mock('../../lib/socket.js', () => ({
  joinBoardRoom: (orgId: string, boardId: BoardId) => joinBoardRoom(orgId, boardId),
  leaveBoardRoom: (boardId: BoardId) => {
    leaveBoardRoom(boardId);
  },
  onBroadcast: (handler: (message: BroadcastMessage) => void) => {
    listeners.broadcast.add(handler);
    return () => listeners.broadcast.delete(handler);
  },
  onPresence: (handler: (message: { boardId: string; userIds: readonly string[] }) => void) => {
    listeners.presence.add(handler);
    return () => listeners.presence.delete(handler);
  },
  onRoomClosed: (handler: (message: { boardId: string }) => void) => {
    listeners.roomClosed.add(handler);
    return () => listeners.roomClosed.delete(handler);
  },
  onReconnect: (handler: () => void) => {
    listeners.reconnect.add(handler);
    return () => listeners.reconnect.delete(handler);
  },
}));

const { useBoardRoom } = await import('./use-board-room.js');

const ORG = 'org-1';
const BOARD = '0195ff03-0000-7000-8000-000000000b01' as BoardId;
/* Real UUIDs, because `cardIdOf` PARSES rather than asserts: a placeholder like
   'card-1' is correctly refused, and a suite built on placeholders would show
   every ADJUST case passing while proving only that the handler ignored the
   event. */
const CARD = '0195ff03-0000-7000-8000-000000000c01';
const OTHER_CARD = '0195ff03-0000-7000-8000-000000000c02';

/** Only the fields these handlers touch; the rest of CardSummary is irrelevant here. */
function card(overrides: Partial<CardSummary> = {}): CardSummary {
  return {
    cardId: CARD,
    listId: 'list-1',
    rank: 'a0',
    title: 'A card',
    priority: null,
    dueDate: null,
    statusId: null,
    assigneeIds: [],
    commentCount: 0,
    checklistDone: 0,
    checklistTotal: 0,
    ...overrides,
  } as unknown as CardSummary;
}

let client: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function mount() {
  return renderHook(() => useBoardRoom(ORG, BOARD), { wrapper });
}

function broadcast(name: string, payload: unknown): void {
  act(() => {
    for (const handler of listeners.broadcast) {
      handler({
        name,
        version: 1,
        orgId: ORG,
        boardId: BOARD,
        actorId: null,
        mutationId: null,
        occurredAt: new Date().toISOString(),
        payload,
      });
    }
  });
}

const cards = () => client.getQueryData<readonly CardSummary[]>(keys.cardsOfBoard(ORG, BOARD));

beforeEach(() => {
  for (const set of Object.values(listeners)) set.clear();
  joinBoardRoom.mockClear();
  leaveBoardRoom.mockClear();

  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  client.setQueryData(keys.cardsOfBoard(ORG, BOARD), [card()]);
});

describe('room lifecycle', () => {
  it('joins on mount and leaves on unmount', () => {
    const view = mount();
    expect(joinBoardRoom).toHaveBeenCalledWith(ORG, BOARD);

    view.unmount();
    expect(leaveBoardRoom).toHaveBeenCalledWith(BOARD);
  });

  it('does not join before an org is selected', () => {
    // `board-page.tsx` passes '' while orgId is null — there is nothing to
    // scope a join to, and asking anyway would be a guaranteed refusal counted
    // against this socket's refused-join budget (§7.5).
    renderHook(() => useBoardRoom('', BOARD), { wrapper });
    expect(joinBoardRoom).not.toHaveBeenCalled();
  });

  it('ignores a broadcast for a DIFFERENT board on the same connection', () => {
    mount();

    act(() => {
      for (const handler of listeners.broadcast) {
        handler({
          name: 'card.moved',
          version: 1,
          orgId: ORG,
          boardId: '0195ff03-0000-7000-8000-000000000b02',
          actorId: null,
          mutationId: null,
          occurredAt: new Date().toISOString(),
          payload: { cardId: CARD, toListId: 'list-9', toRank: 'z9' },
        });
      }
    });

    // One socket carries every room this tab joined, so the per-board filter is
    // the only thing keeping two open boards from patching each other.
    expect(cards()?.[0]?.listId).toBe('list-1');
  });
});

describe('PATCH strategy', () => {
  it('card.moved writes the new list and rank', () => {
    mount();
    broadcast('card.moved', { cardId: CARD, toListId: 'list-2', toRank: 'b5' });

    expect(cards()?.[0]?.listId).toBe('list-2');
    expect(cards()?.[0]?.rank).toBe('b5');
  });

  it('card.status_changed writes a null status as null, not as "unchanged"', () => {
    // Clearing a status is a real edit. `??`-style handling would treat null as
    // "not supplied" and silently keep the old value — the same trap
    // `useUpdateCard` documents for clearing a date.
    client.setQueryData(keys.cardsOfBoard(ORG, BOARD), [card({ statusId: 'status-1' })]);
    mount();

    broadcast('card.status_changed', { cardId: CARD, before: 'status-1', after: null });
    expect(cards()?.[0]?.statusId).toBeNull();
  });

  it('card.assigned replaces the whole assignee set', () => {
    mount();
    broadcast('card.assigned', { cardId: CARD, before: [], after: ['user-1', 'user-2'] });

    expect(cards()?.[0]?.assigneeIds).toEqual(['user-1', 'user-2']);
  });

  it('leaves other cards untouched', () => {
    client.setQueryData(keys.cardsOfBoard(ORG, BOARD), [
      card(),
      { ...card(), cardId: OTHER_CARD, listId: 'list-3' } as CardSummary,
    ]);
    mount();

    broadcast('card.moved', { cardId: CARD, toListId: 'list-2', toRank: 'b5' });
    expect(cards()?.[1]?.listId).toBe('list-3');
  });
});

describe('ADJUST strategy — the delta arithmetic', () => {
  it('comment.created and comment.deleted move the counter in opposite directions', () => {
    client.setQueryData(keys.cardsOfBoard(ORG, BOARD), [card({ commentCount: 2 })]);
    mount();

    broadcast('comment.created', { cardId: CARD, commentId: 'c1' });
    expect(cards()?.[0]?.commentCount).toBe(3);

    broadcast('comment.deleted', { cardId: CARD, commentId: 'c1' });
    expect(cards()?.[0]?.commentCount).toBe(2);
  });

  it('checklist_item.created raises the total but not the done count', () => {
    mount();
    broadcast('checklist_item.created', { cardId: CARD, itemId: 'i1', checklistId: 'cl1' });

    expect(cards()?.[0]?.checklistTotal).toBe(1);
    expect(cards()?.[0]?.checklistDone).toBe(0);
  });

  it('checklist_item.updated moves done by the before/after difference, both ways', () => {
    client.setQueryData(keys.cardsOfBoard(ORG, BOARD), [
      card({ checklistDone: 1, checklistTotal: 3 }),
    ]);
    mount();

    broadcast('checklist_item.updated', {
      cardId: CARD,
      before: { text: 'x', done: false },
      after: { text: 'x', done: true },
    });
    expect(cards()?.[0]?.checklistDone).toBe(2);

    broadcast('checklist_item.updated', {
      cardId: CARD,
      before: { text: 'x', done: true },
      after: { text: 'x', done: false },
    });
    expect(cards()?.[0]?.checklistDone).toBe(1);
    // The total never moves for an item edit — only created/deleted change it.
    expect(cards()?.[0]?.checklistTotal).toBe(3);
  });

  it('a text-only edit touches no counter at all', () => {
    // The failure this rules out: computing the delta from `after.done` alone,
    // which would count every rename of an already-done item as another
    // completion and drift the badge upward forever.
    client.setQueryData(keys.cardsOfBoard(ORG, BOARD), [
      card({ checklistDone: 2, checklistTotal: 3 }),
    ]);
    mount();

    broadcast('checklist_item.updated', {
      cardId: CARD,
      before: { text: 'old', done: true },
      after: { text: 'new', done: true },
    });

    expect(cards()?.[0]?.checklistDone).toBe(2);
  });
});

describe('malformed and unknown payloads', () => {
  it('ignores an event whose payload is missing the fields it needs', () => {
    mount();
    broadcast('card.moved', { cardId: CARD });

    // No guessing: a malformed payload is not a reason to write a partial
    // patch, the same rule `roomBoardIdOf` applies to choosing a room.
    expect(cards()?.[0]?.listId).toBe('list-1');
  });

  it('ignores a non-object payload rather than throwing', () => {
    mount();
    expect(() => {
      broadcast('card.moved', 'not-an-object');
    }).not.toThrow();
  });

  it('is a no-op for an event name it has no handler for', () => {
    mount();
    const before = cards();

    broadcast('something.invented', { cardId: CARD });
    // Wave 3 and later phases add events to the room table before this switch
    // learns about them; an unhandled name has to be exactly as safe as one
    // that never arrives.
    expect(cards()).toEqual(before);
  });
});

describe('presence', () => {
  it('reports who else has the board open, and clears when the room closes', () => {
    const view = mount();
    expect(view.result.current.presence).toEqual([]);

    act(() => {
      for (const handler of listeners.presence) {
        handler({ boardId: BOARD, userIds: ['user-1', 'user-2'] });
      }
    });
    expect(view.result.current.presence).toEqual(['user-1', 'user-2']);

    act(() => {
      for (const handler of listeners.roomClosed) handler({ boardId: BOARD });
    });
    // Access was revoked mid-session (§7.2) — continuing to show an avatar
    // stack for a room this tab is no longer in would be stale in a way the
    // user reads as "still connected".
    expect(view.result.current.presence).toEqual([]);
  });

  it('ignores presence for another board on the same connection', () => {
    const view = mount();

    act(() => {
      for (const handler of listeners.presence) {
        handler({ boardId: '0195ff03-0000-7000-8000-000000000b02', userIds: ['user-9'] });
      }
    });

    expect(view.result.current.presence).toEqual([]);
  });
});
