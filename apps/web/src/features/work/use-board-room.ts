import { useEffect } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { BoardId } from '@taskflow/contracts';
import { keys } from '../../lib/query.js';
import {
  joinBoardRoom,
  leaveBoardRoom,
  onBroadcast,
  onRoomClosed,
  type BroadcastMessage,
} from '../../lib/socket.js';
import { patchBoardCards } from './api.js';

/**
 * Mounted from `board-page.tsx` (ai/phase-4-realtime.md §5 Wave 1).
 *
 * Joins `board:{boardId}` on mount and leaves on unmount or when the board
 * changes. The board's own queries (`cardsQuery`, `listsQuery`) are untouched
 * by this hook — a refused join, or a gateway that is down, just leaves the
 * page on the `staleTime`-bounded polled query it already has (`query.ts`),
 * which is why joining is fire-and-forget here rather than something the page
 * blocks rendering on.
 */
export function useBoardRoom(orgId: string, boardId: BoardId): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    // No org selected yet (`board-page.tsx` passes `''` while `orgId` is
    // null) — nothing to scope a join to.
    if (orgId === '') return undefined;

    void joinBoardRoom(orgId, boardId);

    const offBroadcast = onBroadcast((message) => {
      if (message.boardId !== boardId) return;
      applyBroadcast(queryClient, orgId, boardId, message);
    });

    const offClosed = onRoomClosed((message) => {
      if (message.boardId !== boardId) return;
      // The join that was good a moment ago no longer is (§3.3, §7.2) — a
      // revoked tuple, a role change, a removed membership. There is nothing
      // live to rejoin against; refetching once is what a hard refresh would
      // have shown, and the ordinary polled query takes over from here.
      void queryClient.invalidateQueries({ queryKey: keys.cardsOfBoard(orgId, boardId) });
    });

    return () => {
      offBroadcast();
      offClosed();
      leaveBoardRoom(boardId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- queryClient is stable for the app's lifetime
  }, [orgId, boardId]);
}

/**
 * One event, per §5 Wave 1: a card moved elsewhere patches this board's
 * cached list the way `useUpdateCard`'s own optimistic patch does, just
 * triggered by a socket event instead of a mutation response.
 *
 * `card.created` also has a room mapping (`event-rooms.ts`), and is handled
 * here too, but by invalidating rather than patching: its payload
 * (`apps/api/src/work/events.ts`) carries `title` and not the rest of
 * `CardSummary` (rank, assignees, status, ...), and synthesizing the missing
 * fields would put a row on screen that does not match what `cards.list`
 * would actually return.
 *
 * Every other seeded-later event (§4) is silently ignored by the `default`
 * branch rather than erroring — Wave 2 fills the catalog in, and an unhandled
 * name here is exactly as safe as one that arrives before this file knows
 * about it.
 *
 * No `mutationId`-echo check (§3.6) yet: the client has no way to learn the
 * `requestId` of its OWN successful mutation today (`trpc-client.ts` only
 * surfaces one on an ERROR response), so that optimization is deferred rather
 * than faked. Applying an echo of the client's own move is still safe without
 * it — the patch overwrites `listId`/`rank` with the same values the
 * optimistic patch already wrote, so a duplicate application lands in the
 * same place instead of drifting, the same property `relay.ts` relies on for
 * at-least-once delivery.
 */
function applyBroadcast(
  client: QueryClient,
  orgId: string,
  boardId: BoardId,
  message: BroadcastMessage,
): void {
  switch (message.name) {
    case 'card.moved': {
      const moved = asCardMoved(message.payload);
      if (moved === null) return;

      patchBoardCards(client, orgId, boardId, (cards) =>
        cards.map((card) =>
          card.cardId === moved.cardId
            ? { ...card, listId: moved.toListId, rank: moved.toRank }
            : card,
        ),
      );
      return;
    }

    case 'card.created': {
      void client.invalidateQueries({ queryKey: keys.cardsOfBoard(orgId, boardId) });
      return;
    }

    default:
      return;
  }
}

interface CardMovedPayload {
  readonly cardId: string;
  readonly toListId: string;
  readonly toRank: string;
}

/** Narrows the broadcast's `unknown` payload rather than trusting its shape. */
function asCardMoved(payload: unknown): CardMovedPayload | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const { cardId, toListId, toRank } = payload as Record<string, unknown>;

  if (typeof cardId !== 'string' || typeof toListId !== 'string' || typeof toRank !== 'string') {
    return null;
  }
  return { cardId, toListId, toRank };
}
