import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BoardId, CardId, ListId, ProjectId } from '@taskflow/contracts';
import { api } from '../../../lib/trpc.js';
import { keys } from '../../../lib/query.js';
import { useToast } from '../../../lib/toast-context.js';
import { boardsQuery, cardsQuery, listsQuery } from '../api.js';

/**
 * Where the card lives — its board and its list — as two selects.
 *
 * ## Why this exists next to drag and drop
 *
 * Dragging is the fast path and it is the only one for reordering WITHIN a
 * list, because a position between two neighbours is not something a select can
 * express. Moving a card to a different list or board is a different act: the
 * destination is a name, not a place on screen, and the board holding it may
 * not even be the one currently rendered. A pointer gesture is the wrong
 * instrument for that, and it is unavailable to anyone driving the app by
 * keyboard or screen reader.
 *
 * ## Both selects, one mutation
 *
 * `cards.move` takes a target LIST and derives everything else: the service
 * reads the destination list and writes its `board_id` and `project_id` onto
 * the card (`card.service.ts`), and authorizes the destination board
 * SEPARATELY from the card's own board — holding `card:move` where the card is
 * now grants nothing about where it is going.
 *
 * So changing the board select does not move anything. It re-scopes the list
 * select, and the move happens when a list is chosen. That is deliberate: a
 * board is not a destination, only a list is, and moving on board-change would
 * have to invent which of its lists the user meant.
 *
 * ## Cross-project is not offered, and the reason is in the schema
 *
 * Only boards in the card's own project are listed. `work.cards` carries a
 * composite foreign key on `(org_id, project_id, status_id)`, and `card_labels`
 * and `custom_field_values` both reference `cards (org_id, project_id, id)` —
 * so changing a card's project orphans its status, labels and custom fields at
 * the database level, and every card has a status since the 0012 backfill. It
 * would also keep a card number minted from the old project's counter. That is
 * a real feature with a migration behind it, not a wider dropdown.
 *
 * ## Appending, not inserting
 *
 * The card lands at the END of the destination. `beforeCardId` is the list's
 * current last card rather than null: sending both neighbours as null asks the
 * server to place a card with no bounds on either side, which is how two cards
 * end up sharing a rank and the next drag into that column triggers a rebalance
 * (§10.1). The end is also the honest answer — a select conveys "put it there",
 * not "put it third".
 */

export interface LocationSectionProps {
  readonly orgId: string;
  readonly cardId: CardId;
  readonly boardId: BoardId;
  readonly listId: string;
  readonly projectId: ProjectId | null;
  /** Closes the panel when the card leaves the board this panel was opened from. */
  readonly onLeaveBoard: () => void;
}

export function LocationSection({
  orgId,
  cardId,
  boardId,
  listId,
  projectId,
  onLeaveBoard,
}: LocationSectionProps) {
  const queryClient = useQueryClient();
  const toast = useToast();

  /* Which board the LIST select is showing — not where the card is. They differ
     from the moment someone picks another board until they pick a list in it,
     and resetting this to the card's own board on every render would undo the
     selection as soon as the query refetched. */
  const [showingBoardId, setShowingBoardId] = useState<BoardId>(boardId);

  const lists = useQuery(listsQuery(orgId, showingBoardId));
  const destinationCards = useQuery(cardsQuery(orgId, showingBoardId, null));

  const move = useMutation({
    mutationFn: (targetListId: ListId) =>
      api.work.cards.move.mutate({
        cardId,
        targetListId,
        beforeCardId: lastCardOf(destinationCards.data, targetListId),
        afterCardId: null,
      }),

    onSuccess: async () => {
      /* Both boards, because a cross-board move removes the card from one and
         adds it to the other, and the source board is very often the page
         rendered behind this panel. */
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: keys.cardsOfBoard(orgId, boardId) }),
        queryClient.invalidateQueries({ queryKey: keys.cardsOfBoard(orgId, showingBoardId) }),
        queryClient.invalidateQueries({ queryKey: keys.card(orgId, cardId) }),
      ]);

      /* The panel was opened from a board that no longer holds this card, so
         its `boardId` prop now points somewhere the card is not. Closing is
         honest; leaving it open would show a card detail whose surrounding
         board disagrees with it. */
      if (showingBoardId !== boardId) onLeaveBoard();
    },

    onError: (error) => {
      // Put the select back where the card actually is, so the control is not
      // left asserting a move that did not happen.
      setShowingBoardId(boardId);
      toast.failure('The card could not be moved', error);
    },
  });

  const busy = move.isPending || lists.isPending || destinationCards.isPending;

  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold tracking-wide text-ink-muted uppercase">Location</h3>

      {projectId !== null && (
        <BoardSelect
          orgId={orgId}
          projectId={projectId}
          value={showingBoardId}
          disabled={move.isPending}
          onChange={setShowingBoardId}
        />
      )}

      <label className="block space-y-1">
        <span className="text-[11px] text-ink-faint">List</span>
        <select
          aria-label="List"
          /* Empty while showing another board's lists, so the control never
             claims the card is in a list it is not in. */
          value={showingBoardId === boardId ? listId : ''}
          disabled={busy}
          onChange={(event) => {
            const next = event.target.value;
            if (next === '') return;
            move.mutate(next as ListId);
          }}
          className="h-8 w-full rounded border border-line bg-surface-sunken px-2 text-xs text-ink disabled:opacity-50"
        >
          {showingBoardId !== boardId && <option value="">Choose a list…</option>}
          {(lists.data ?? []).map((list) => (
            <option key={list.listId} value={list.listId}>
              {list.name}
            </option>
          ))}
        </select>
      </label>
    </section>
  );
}

/**
 * Its own component so the query never sees a null project.
 *
 * The alternative — `boardsQuery(orgId, projectId as ProjectId)` guarded by
 * `enabled` — asserts a type the caller has not established and leaves the
 * compiler agreeing with it. A card with no project has no sibling boards to
 * offer, so there is nothing to render, which is a rendering condition rather
 * than a query one.
 */
function BoardSelect({
  orgId,
  projectId,
  value,
  disabled,
  onChange,
}: {
  readonly orgId: string;
  readonly projectId: ProjectId;
  readonly value: BoardId;
  readonly disabled: boolean;
  readonly onChange: (boardId: BoardId) => void;
}) {
  const boards = useQuery(boardsQuery(orgId, projectId));

  return (
    <label className="block space-y-1">
      <span className="text-[11px] text-ink-faint">Board</span>
      <select
        aria-label="Board"
        value={value}
        disabled={disabled}
        onChange={(event) => {
          onChange(event.target.value as BoardId);
        }}
        className="h-8 w-full rounded border border-line bg-surface-sunken px-2 text-xs text-ink disabled:opacity-50"
      >
        {(boards.data ?? []).map((board) => (
          <option key={board.boardId} value={board.boardId}>
            {board.name}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * The last card in `listId`, or null when the list is empty.
 *
 * Null here means "no card above it" — the first card of an empty column, which
 * is a legal move — and is not the same as the caller having failed to look.
 */
function lastCardOf(
  cards: readonly { readonly cardId: string; readonly listId: string }[] | undefined,
  listId: string,
): CardId | null {
  if (cards === undefined) return null;

  const inList = cards.filter((card) => card.listId === listId);
  return (inList[inList.length - 1]?.cardId ?? null) as CardId | null;
}
