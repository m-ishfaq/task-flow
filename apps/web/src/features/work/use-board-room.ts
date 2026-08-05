import { useEffect, useState } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { BoardId, CardId } from '@taskflow/contracts';
import { keys } from '../../lib/query.js';
import {
  joinBoardRoom,
  leaveBoardRoom,
  onBroadcast,
  onPresence,
  onReconnect,
  onRoomClosed,
  type BroadcastMessage,
} from '../../lib/socket.js';
import {
  invalidateBoard,
  patchBoardCards,
  patchChecklistCounters,
  patchCommentCount,
  type Priority,
} from './api.js';

/**
 * Mounted from `board-page.tsx` (ai/phase-4-realtime.md §5, Wave 1 + Wave 2).
 *
 * Joins `board:{boardId}` on mount and leaves on unmount or when the board
 * changes. The board's own queries (`cardsQuery`, `listsQuery`) are untouched
 * by this hook — a refused join, or a gateway that is down, just leaves the
 * page on the `staleTime`-bounded polled query it already has (`query.ts`),
 * which is why joining is fire-and-forget here rather than something the page
 * blocks rendering on.
 *
 * Returns who else has this room open (§9) — Socket.io's own room membership,
 * relayed by the gateway (`apps/realtime/src/presence.ts`), not a new data
 * model. Empty until the join's first `presence` broadcast arrives.
 */
export function useBoardRoom(orgId: string, boardId: BoardId): { presence: readonly string[] } {
  const queryClient = useQueryClient();
  const [presence, setPresence] = useState<readonly string[]>([]);

  // Resets `presence` the moment the room identity changes, during render
  // rather than in the effect below (react-hooks/set-state-in-effect) — the
  // documented pattern for "clear derived state when a prop changes"
  // (react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes).
  const roomKey = `${orgId}:${boardId}`;
  const [lastRoomKey, setLastRoomKey] = useState(roomKey);
  if (roomKey !== lastRoomKey) {
    setLastRoomKey(roomKey);
    setPresence([]);
  }

  useEffect(() => {
    // No org selected yet (`board-page.tsx` passes `''` while `orgId` is
    // null) — nothing to scope a join to.
    if (orgId === '') return undefined;

    void joinBoardRoom(orgId, boardId);

    const offBroadcast = onBroadcast((message) => {
      if (message.boardId !== boardId) return;
      applyBroadcast(queryClient, orgId, boardId, message);
    });

    const offPresence = onPresence((message) => {
      if (message.boardId !== boardId) return;
      setPresence(message.userIds);
    });

    const offClosed = onRoomClosed((message) => {
      if (message.boardId !== boardId) return;
      // The join that was good a moment ago no longer is (§3.3, §7.2) — a
      // revoked tuple, a role change, a removed membership. There is nothing
      // live to rejoin against; refetching once is what a hard refresh would
      // have shown, and the ordinary polled query takes over from here.
      void invalidateBoard(queryClient, orgId, boardId);
      setPresence([]);
    });

    /**
     * Reconnect-and-diff (§9, Wave 2). `onReconnect` fires only after an
     * ACTUAL drop-and-recover, never the first connection — `socket.ts`
     * already re-emits `board:join` for this room by then, so this only has
     * to cover the "diff" half: refetching rather than trusting a socket
     * that may have missed events for however long it was down. A hard
     * refresh is the baseline this has to match, and a refetch of exactly
     * what a refresh would have re-requested is that baseline.
     */
    const offReconnect = onReconnect(() => {
      void invalidateBoard(queryClient, orgId, boardId);
    });

    return () => {
      offBroadcast();
      offPresence();
      offClosed();
      offReconnect();
      leaveBoardRoom(boardId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- queryClient is stable for the app's lifetime
  }, [orgId, boardId]);

  return { presence };
}

/**
 * The full §4 catalog, wired in Wave 2. Three strategies, chosen per event:
 *
 * PATCH   the field the event changed, when `CardSummary` renders it and the
 *         payload carries the new value outright (no counter arithmetic).
 * ADJUST  a counter (`commentCount`, `checklistDone`/`checklistTotal`) by a
 *         delta computed from the event's own before/after — never
 *         re-derived by guessing, the same rule `roomBoardIdOf` applies to
 *         choosing a room.
 * INVALIDATE  everything else: a field `CardSummary` does not carry at all
 *         (labels, custom fields), a structural change to lists/board, or an
 *         event whose payload cannot express the exact delta needed for a
 *         safe counter adjustment (see `checklist_item.deleted` below).
 *
 * No `mutationId`-echo check (§3.6) yet: the client has no way to learn the
 * `requestId` of its OWN successful mutation today (`trpc-client.ts` only
 * surfaces one on an ERROR response), so that optimization is deferred rather
 * than faked. Every strategy below is still safe to apply to a client's own
 * echo — a patch overwrites with the same value it already wrote, and an
 * adjust/invalidate on an event this client just caused is merely redundant,
 * never wrong — the same at-least-once property `relay.ts` relies on.
 */
function applyBroadcast(
  client: QueryClient,
  orgId: string,
  boardId: BoardId,
  message: BroadcastMessage,
): void {
  const payload = asRecord(message.payload);
  if (payload === null) return;

  switch (message.name) {
    /* ---------------------------------------------------------------- *
     * Patch: the payload carries the new value outright.
     * ---------------------------------------------------------------- */
    case 'card.moved': {
      const cardId = str(payload, 'cardId');
      const toListId = str(payload, 'toListId');
      const toRank = str(payload, 'toRank');
      if (cardId === null || toListId === null || toRank === null) return;

      patchBoardCards(client, orgId, boardId, (cards) =>
        cards.map((card) =>
          card.cardId === cardId ? { ...card, listId: toListId, rank: toRank } : card,
        ),
      );
      return;
    }

    case 'card.updated': {
      const cardId = str(payload, 'cardId');
      const after = asRecord(payload['after']);
      if (cardId === null || after === null) return;

      const title = str(after, 'title');
      const priority = strOrNull(after, 'priority');
      const dueDate = strOrNull(after, 'dueDate');

      patchBoardCards(client, orgId, boardId, (cards) =>
        cards.map((card) =>
          card.cardId === cardId
            ? {
                ...card,
                ...(title === null ? {} : { title }),
                priority: priority as Priority | null,
                dueDate,
              }
            : card,
        ),
      );
      return;
    }

    case 'card.assigned': {
      const cardId = str(payload, 'cardId');
      const after = payload['after'];
      if (cardId === null || !Array.isArray(after)) return;
      const assigneeIds = after.filter((value): value is string => typeof value === 'string');

      patchBoardCards(client, orgId, boardId, (cards) =>
        cards.map((card) => (card.cardId === cardId ? { ...card, assigneeIds } : card)),
      );
      return;
    }

    case 'card.status_changed': {
      const cardId = str(payload, 'cardId');
      if (cardId === null) return;
      const statusId = strOrNull(payload, 'after');

      patchBoardCards(client, orgId, boardId, (cards) =>
        cards.map((card) => (card.cardId === cardId ? { ...card, statusId } : card)),
      );
      return;
    }

    /* ---------------------------------------------------------------- *
     * Adjust: a counter, by an exact delta the payload can compute.
     * ---------------------------------------------------------------- */
    case 'comment.created': {
      const cardId = str(payload, 'cardId');
      if (cardId === null) return;
      patchCommentCount(client, orgId, boardId, cardId as CardId, 1);
      return;
    }

    case 'comment.deleted': {
      const cardId = str(payload, 'cardId');
      if (cardId === null) return;
      patchCommentCount(client, orgId, boardId, cardId as CardId, -1);
      return;
    }

    case 'checklist_item.created': {
      const cardId = str(payload, 'cardId');
      if (cardId === null) return;
      // A new item is never created done.
      patchChecklistCounters(client, orgId, boardId, cardId as CardId, { done: 0, total: 1 });
      return;
    }

    case 'checklist_item.updated': {
      const cardId = str(payload, 'cardId');
      const before = asRecord(payload['before']);
      const after = asRecord(payload['after']);
      if (cardId === null || before === null || after === null) return;

      const doneDelta = Number(bool(after, 'done')) - Number(bool(before, 'done'));
      if (doneDelta === 0) return; // a text-only edit touches no counter.

      patchChecklistCounters(client, orgId, boardId, cardId as CardId, {
        done: doneDelta,
        total: 0,
      });
      return;
    }

    /* ---------------------------------------------------------------- *
     * Invalidate: CardSummary does not carry the field, the payload
     * cannot express an exact delta, or the change is structural.
     * ---------------------------------------------------------------- */
    case 'card.created':
    case 'card.archived':
    /* falls through: `checklist_item.deleted`'s payload (events.ts) carries no
       `done` state for the item it removed, so the checklistDone delta cannot
       be computed without guessing — the same rule that keeps `roomBoardIdOf`
       from inferring a room applies to inferring a counter. */
    case 'checklist_item.deleted':
    /* falls through: `checklist.created`/`checklist.deleted` change
       checklistTotal by more than one and, for a delete, by an unknown number
       of DONE items among those removed — same reasoning as above. */
    case 'checklist.created':
    case 'checklist.deleted': {
      void client.invalidateQueries({ queryKey: keys.cardsOfBoard(orgId, boardId) });
      return;
    }

    /* `card.labeled` / `card.field_set`: CardSummary carries neither labels
       nor custom field values at all (`api.ts`'s Outputs['cards']) — there is
       no board-tile field to patch. Only the per-card query anyone with that
       card's detail panel open would be looking at. */
    case 'card.labeled': {
      const cardId = str(payload, 'cardId');
      if (cardId === null) return;
      void client.invalidateQueries({ queryKey: keys.cardLabels(orgId, cardId) });
      return;
    }

    case 'card.field_set': {
      const cardId = str(payload, 'cardId');
      if (cardId === null) return;
      void client.invalidateQueries({ queryKey: keys.cardFields(orgId, cardId) });
      return;
    }

    case 'comment.updated': {
      const cardId = str(payload, 'cardId');
      if (cardId === null) return;
      void client.invalidateQueries({ queryKey: keys.comments(orgId, cardId) });
      return;
    }

    /* Lists and the board's own shape: low-frequency structural changes,
       invalidated broadly rather than patched field-by-field for each. */
    case 'list.created':
    case 'list.updated':
    case 'list.reordered':
    case 'list.archived':
    case 'list.rebalanced':
    case 'board.updated':
    case 'board.archived': {
      void invalidateBoard(client, orgId, boardId);
      return;
    }

    case 'view.created':
    case 'view.updated':
    case 'view.deleted': {
      void client.invalidateQueries({ queryKey: keys.views(orgId, boardId) });
      return;
    }

    default:
      // Not every event this table maps has a client-side handler yet, and
      // an unhandled name is exactly as safe as one that never arrives —
      // the polled query underneath is still there.
      return;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function str(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' ? value : null;
}

/** Like `str`, but a present `null` is a real value, not a missing field. */
function strOrNull(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' ? value : null;
}

function bool(payload: Record<string, unknown>, key: string): boolean {
  return payload[key] === true;
}
