import { useEffect } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { BoardIdSchema, type BoardId, type CardId } from '@taskflow/contracts';
import { gatewaySocket } from './app-session.js';
import type { BroadcastMessage } from './socket.js';
import {
  attachmentsQueryKey,
  boardCardsQueryKey,
  cardFieldsQueryKey,
  cardLabelsQueryKey,
  cardQueryKey,
  checklistsQueryKey,
  commentsQueryKey,
  listsQueryKey,
} from './work.js';

/**
 * Mounted from `board/[boardId].tsx` while a board is open — the mobile
 * counterpart of `apps/web/src/features/work/use-board-room.ts`, joining
 * `board:{boardId}` over the shared `gatewaySocket` singleton (`app-
 * session.ts`) — the same connection `call-surface.tsx` already forces open
 * for incoming calls.
 *
 * ## Invalidate, never patch — unlike web's own richer version
 *
 * Web's hook patches `CardSummary` fields directly and adjusts counters by
 * an exact delta, because it already has `patchBoardCards`/
 * `patchChecklistCounters` from its optimistic-mutation layer. Mobile has no
 * equivalent cache-patch helpers for board cards, and `use-chat-room.ts`
 * already made the identical call for Chat: every broadcast here
 * invalidates the query the event touched rather than hand-splicing the
 * payload into it — one extra round trip per live event is a smaller
 * ongoing cost than a second, independently-maintained patch
 * implementation next to web's that could drift from it.
 *
 * ## `useCardRoom` below is the SECOND caller a board room can have —
 * `socket.ts`'s `joinBoardRoom`/`leaveBoardRoom` are reference-counted for
 * exactly this
 *
 * Web's card detail is a modal INSIDE `board-page.tsx`, sharing that one
 * page's `useBoardRoom` call — only one caller per board room ever exists.
 * Mobile's card detail is its own ROUTE, reached both from a board (which
 * stays mounted underneath it, unpopped, in the native-stack navigator) and
 * from places that never opened a board at all (My Tasks, a notification).
 * A naive second `useBoardRoom` call from the card screen would call
 * `leaveBoardRoom` on ITS OWN unmount (going back to the board) and sever
 * the board screen's still-open membership in the same room, since both
 * calls share the one underlying socket connection — this was a real,
 * caught-before-shipping bug in an earlier version of this file, which is
 * why `useCardRoom` did not exist alongside `useBoardRoom` from the start.
 * `socket.ts`'s `joinBoardRoom`/`leaveBoardRoom` now count live callers per
 * `boardId` rather than tracking a single owner, which is what makes it
 * safe for both hooks below to hold the same room open at once.
 *
 * ## What `useBoardRoom` closes
 *
 * Until it existed nothing on this screen joined a room — every board
 * render was a plain `useQuery`, fresh only on navigation or
 * app-foreground. A card someone else moved, edited, commented on, or a
 * list someone renamed, never appeared here without leaving and reopening
 * the board.
 */
export function useBoardRoom(orgId: string | null, boardId: BoardId): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (orgId === null) return undefined;

    void gatewaySocket.joinBoardRoom(orgId, boardId);

    const offBroadcast = gatewaySocket.onBroadcast((message) => {
      if (message.boardId !== boardId) return;
      applyBroadcast(message, queryClient, boardId);
    });

    const offClosed = gatewaySocket.onRoomClosed((message) => {
      if (message.boardId !== boardId) return;
      // Same terminal handling as `use-chat-room.ts`'s `channel:closed`: the
      // join that was good a moment ago no longer is (a revoked tuple, a
      // role change, an archived board). Nothing live to rejoin against —
      // refetch once, which is what a hard refresh would have shown.
      void queryClient.invalidateQueries({ queryKey: boardCardsQueryKey(boardId) });
      void queryClient.invalidateQueries({ queryKey: listsQueryKey(boardId) });
    });

    /* Reconnect-and-diff, same as web's own hook: `socket.ts` already
       re-emits `board:join` for this room on reconnect, so this only has to
       cover the "diff" half — refetching rather than trusting a connection
       that may have missed events for however long it was down. */
    const offReconnect = gatewaySocket.onReconnect(() => {
      void queryClient.invalidateQueries({ queryKey: boardCardsQueryKey(boardId) });
      void queryClient.invalidateQueries({ queryKey: listsQueryKey(boardId) });
    });

    return () => {
      offBroadcast();
      offClosed();
      offReconnect();
      gatewaySocket.leaveBoardRoom(boardId);
    };
    // `queryClient` is stable for the app's lifetime — same reasoning
    // `use-chat-room.ts` gives for omitting it, and this app's ESLint config
    // carries no `react-hooks/exhaustive-deps` rule to satisfy either way.
  }, [orgId, boardId]);
}

/**
 * The board-tile-relevant slice of web's own event catalog
 * (`apps/web/src/features/work/use-board-room.ts`), collapsed to two
 * targets: `boardCardsQueryKey` (everything `CardRow` renders — title,
 * priority, due date, checklist counts, comment count) and
 * `listsQueryKey` (the tab strip's names and WIP counts). A card's own
 * detail-level fields (description, labels, custom field values, comments,
 * attachments) are not this screen's concern — nothing here reads them —
 * so events that touch only those are left unhandled rather than
 * invalidating a query this screen never loaded.
 */
function applyBroadcast(message: BroadcastMessage, client: QueryClient, boardId: BoardId): void {
  switch (message.name) {
    case 'card.created':
    case 'card.moved':
    case 'card.updated':
    case 'card.assigned':
    case 'card.status_changed':
    case 'card.archived':
    case 'comment.created':
    case 'comment.deleted':
    case 'checklist.created':
    case 'checklist.deleted':
    case 'checklist_item.created':
    case 'checklist_item.updated':
    case 'checklist_item.deleted': {
      void client.invalidateQueries({ queryKey: boardCardsQueryKey(boardId) });
      return;
    }

    case 'list.created':
    case 'list.updated':
    case 'list.reordered':
    case 'list.archived':
    case 'list.rebalanced':
    case 'board.updated':
    case 'board.archived': {
      void client.invalidateQueries({ queryKey: boardCardsQueryKey(boardId) });
      void client.invalidateQueries({ queryKey: listsQueryKey(boardId) });
      return;
    }

    default:
      // Not every event this app's server emits has a handler here, and an
      // unhandled name is exactly as safe as one that never arrives — the
      // screen's plain `useQuery` underneath is still there.
      return;
  }
}

/**
 * Mounted from `card/[cardId].tsx` while a card is open — joins the SAME
 * `board:{boardId}` room `useBoardRoom` above joins, safely, per this file's
 * own header. There is no `card:{cardId}` room anywhere in this system: a
 * card's authorization is its board's (CLAUDE.md's own "there is no `list`
 * resource type" reasoning, one tier up), so the board room is the only
 * room that could ever exist for one.
 *
 * `boardId` is `string | null`, not the branded `BoardId` `useBoardRoom`
 * takes — the card's own `boardId` field arrives already-validated on a
 * typed tRPC response (guardrail 5), not through a route param, so nothing
 * here re-derives it from user input; it is `null` only until `card.data`
 * itself has loaded, and the hook simply does not join until it has.
 * `BoardIdSchema.parse` at the `joinBoardRoom`/`leaveBoardRoom` call sites
 * is what actually produces the branded value their signatures require —
 * expected to always succeed against this server's own output, kept as a
 * real parse rather than a bare cast anyway (guardrail 1: a brand means "a
 * parser checked this," not "someone was confident").
 */
export function useCardRoom(orgId: string | null, boardId: string | null, cardId: CardId): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (orgId === null || boardId === null) return undefined;
    const branded = BoardIdSchema.parse(boardId);

    void gatewaySocket.joinBoardRoom(orgId, branded);

    const offBroadcast = gatewaySocket.onBroadcast((message) => {
      if (message.boardId !== boardId) return;
      applyCardBroadcast(message, queryClient, cardId);
    });

    /* Same "diff on reconnect" reasoning as `useBoardRoom` — refetch
       everything this screen shows rather than trusting a connection that
       may have missed events while it was down. No `onRoomClosed` handler:
       a revoked board tuple invalidating `cardQueryKey` would only re-run
       the SAME `card.get` query that already answers FORBIDDEN on its own,
       through the error branch this screen already renders. */
    const offReconnect = gatewaySocket.onReconnect(() => {
      invalidateCardDetail(queryClient, cardId);
    });

    return () => {
      offBroadcast();
      offReconnect();
      gatewaySocket.leaveBoardRoom(branded);
    };
  }, [orgId, boardId, cardId]);
}

function invalidateCardDetail(client: QueryClient, cardId: CardId): void {
  void client.invalidateQueries({ queryKey: cardQueryKey(cardId) });
  void client.invalidateQueries({ queryKey: checklistsQueryKey(cardId) });
  void client.invalidateQueries({ queryKey: commentsQueryKey(cardId) });
  void client.invalidateQueries({ queryKey: attachmentsQueryKey(cardId) });
  void client.invalidateQueries({ queryKey: cardLabelsQueryKey(cardId) });
  void client.invalidateQueries({ queryKey: cardFieldsQueryKey(cardId) });
}

/**
 * The card-detail-relevant slice of the same event catalog `applyBroadcast`
 * above reads — everything a card's OWN screen renders that `CardRow`/the
 * board tab strip do not: description edits surface through `card.updated`
 * already (no separate description event exists), labels, custom field
 * values, comments, checklists, and attachments. Filtered to messages whose
 * payload actually names THIS card — `message.boardId === boardId` alone
 * would fire for every card on the board, which is exactly the kind of
 * over-invalidation `use-chat-room.ts`'s own channel-id filter already
 * guards against for chat.
 */
function applyCardBroadcast(message: BroadcastMessage, client: QueryClient, cardId: CardId): void {
  if (cardIdOf(message.payload) !== cardId) return;

  switch (message.name) {
    case 'card.updated':
    case 'card.assigned':
    case 'card.status_changed':
    case 'card.moved':
    case 'card.archived': {
      void client.invalidateQueries({ queryKey: cardQueryKey(cardId) });
      return;
    }

    case 'comment.created':
    case 'comment.updated':
    case 'comment.deleted': {
      void client.invalidateQueries({ queryKey: commentsQueryKey(cardId) });
      void client.invalidateQueries({ queryKey: cardQueryKey(cardId) });
      return;
    }

    case 'checklist.created':
    case 'checklist.deleted':
    case 'checklist_item.created':
    case 'checklist_item.updated':
    case 'checklist_item.deleted': {
      void client.invalidateQueries({ queryKey: checklistsQueryKey(cardId) });
      void client.invalidateQueries({ queryKey: cardQueryKey(cardId) });
      return;
    }

    case 'card.labeled': {
      void client.invalidateQueries({ queryKey: cardLabelsQueryKey(cardId) });
      return;
    }

    case 'card.field_set': {
      void client.invalidateQueries({ queryKey: cardFieldsQueryKey(cardId) });
      return;
    }

    case 'attachment.uploaded':
    case 'attachment.rejected':
    case 'attachment.deleted': {
      void client.invalidateQueries({ queryKey: attachmentsQueryKey(cardId) });
      return;
    }

    default:
      return;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/**
 * The payload's `cardId`, read as a plain string rather than parsed into
 * the branded type — only ever COMPARED against this hook's own `cardId`
 * (`===`, which a plain string and a `CardId` compare through structurally),
 * never used to construct anything or cross a call boundary that demands
 * the brand. `apps/web/src/features/work/use-board-room.ts`'s own
 * `cardIdOf` parses fully because its counters need the brand; this hook
 * has no such caller.
 */
function cardIdOf(payload: unknown): string | null {
  const value = asRecord(payload)?.['cardId'];
  return typeof value === 'string' ? value : null;
}
