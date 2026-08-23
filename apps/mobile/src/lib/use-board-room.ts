import { useEffect } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { BoardId } from '@taskflow/contracts';
import { gatewaySocket } from './app-session.js';
import type { BroadcastMessage } from './socket.js';
import { boardCardsQueryKey, listsQueryKey } from './work.js';

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
 * ## Board-scoped only — `card/[cardId].tsx` is a deliberate non-caller
 *
 * Web's card detail is a modal INSIDE `board-page.tsx`, sharing that one
 * page's `useBoardRoom` call. Mobile's card detail is its own ROUTE, reached
 * both from a board (which stays mounted underneath it, unpopped, in the
 * native-stack navigator) and from places that never opened a board at all
 * (My Tasks, a notification). `joinBoardRoom`/`leaveBoardRoom` in
 * `socket.ts` are keyed by boardId alone with no per-caller reference
 * count — ported straight from web, where only one caller per board ever
 * exists. A second `useBoardRoom` call from the card screen would call
 * `leaveBoardRoom` on ITS OWN unmount (going back to the board) and sever
 * the board screen's still-open membership in the same room, since both
 * calls share the one underlying socket connection. So this hook has
 * exactly one caller, and the card screen reached directly (outside a
 * board) stays on its existing plain `useQuery` — a real, separate gap,
 * not a silently accepted one; giving rooms a reference count in `socket.ts`
 * itself is the actual fix, and is its own piece of work.
 *
 * ## What this closes
 *
 * Until now nothing on this screen joined a room — every board render was a
 * plain `useQuery`, fresh only on navigation or app-foreground. A card
 * someone else moved, edited, commented on, or a list someone renamed,
 * never appeared here without leaving and reopening the board.
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
