import { useMemo, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { BoardId, CardId, ListId } from '@taskflow/contracts';
import { api } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { useOptimistic } from '../../lib/optimistic.js';
import { cn } from '../../lib/cn.js';
import { CardTile } from './card-tile.js';
import { ListColumn } from './list-column.js';
import { neighboursForSortableDrop } from './neighbours.js';
import { AddListColumn, EmptyBoard } from './add-list.js';
import { patchBoardCards, type CardSummary, type ListSummary } from './api.js';

interface MoveInput {
  readonly cardId: CardId;
  readonly targetListId: ListId;
  readonly beforeCardId: CardId | null;
  readonly afterCardId: CardId | null;
}

/**
 * The kanban board (§10.4, dnd-kit).
 *
 * ## What is sent on a drop
 *
 * Neighbours, never a rank or a position — see neighbours.ts. The server derives
 * the rank inside the same transaction that moves the card, so two people
 * dragging at once are adjudicated against one present rather than two pasts.
 *
 * ## The optimistic update
 *
 * Through `useOptimistic` (lib/optimistic.ts), which owns the cancel → snapshot
 * → patch → rollback → invalidate cycle so it cannot be implemented two-thirds
 * of the way.
 *
 * It replaced a hand-written version that was correct in every respect except
 * its REACH: it snapshotted and patched `keys.cards(org, board, filterKey)` —
 * the currently visible filter — and a board holds one such entry per filter the
 * user has visited. So a card dragged while a filter was applied moved in that
 * entry and stayed put in the unfiltered one, which then rendered from cache the
 * instant the filter was cleared. The card appeared to jump back on its own, some
 * time after a drag that had already succeeded. `patchBoardCards` resolves the
 * prefix and rewrites all of them.
 *
 * The optimistic rank is deliberately not computed. `between()` is available and
 * would be wrong here: the value it produced would be a second opinion about
 * ordering, and if it differed from the server's the board would reorder again on
 * invalidation. Rewriting the array's ORDER means the only claim being made is
 * the one the user just made with the pointer.
 */

export interface BoardViewProps {
  readonly orgId: string;
  readonly boardId: BoardId;
  readonly lists: readonly ListSummary[];
  readonly cards: readonly CardSummary[];
  readonly onOpenCard: (cardId: string) => void;
}

/* No `filter` prop any more. It existed only to rebuild the cache key this
   component patched, and `patchBoardCards` patches every filter variant by
   prefix — so a view that does not need to know which filter produced its cards
   should not be told. */
export function BoardView({ orgId, boardId, lists, cards, onOpenCard }: BoardViewProps) {
  const queryClient = useQueryClient();
  const optimistic = useOptimistic();
  const [dragging, setDragging] = useState<CardSummary | null>(null);

  const byList = useMemo(() => {
    const grouped = new Map<string, CardSummary[]>();
    for (const list of lists) grouped.set(list.listId, []);
    for (const card of cards) {
      const bucket = grouped.get(card.listId);
      if (bucket !== undefined) bucket.push(card);
    }
    /* The API already returns cards ordered by (list, rank, id). Sorting again
       is what keeps an OPTIMISTICALLY moved card in place: the patch below
       rewrites `listId` without a real rank, and re-sorting on rank alone would
       bounce it back to where its old rank says it belongs. */
    return grouped;
  }, [lists, cards]);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      /* A few pixels of slop, so a click on a card opens it instead of starting
         a drag that goes nowhere. Without it every card is unclickable on a
         trackpad. */
      activationConstraint: { distance: 4 },
    }),
    useSensor(KeyboardSensor, {
      /* The keyboard path. dnd-kit gives it for free here and it is the only
         way this board is operable without a pointer — which is why the a11y
         lint rules are on for apps/web (packages/config/eslint/react.js). */
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const optimisticMove = optimistic<MoveInput>({
    keys: [keys.cardsOfBoard(orgId, boardId)],
    patch: (client, input) => {
      patchBoardCards(client, orgId, boardId, (current) => reorder(current, input));
    },
    failureTitle: 'The card could not be moved',
  });

  const move = useMutation({
    mutationFn: (input: MoveInput) => api.work.cards.move.mutate(input),

    ...optimisticMove,

    /* Overrides the helper's `onSettled` rather than replacing it — note the
       delegation on the first line.

       `rebalanced` is why this needs more than the default. When a move lands in
       a degenerate list the server rewrites the ranks of every card in that
       column (§10.1). Nothing in the response says what the new ranks are, so a
       client that stopped at the cards query would keep stale LIST metadata and
       compute its next drop from it. */
    onSettled: async (result) => {
      await optimisticMove.onSettled();
      if (result?.rebalanced === true) {
        await queryClient.invalidateQueries({ queryKey: keys.lists(orgId, boardId) });
      }
    },
  });

  const onDragStart = (event: DragStartEvent) => {
    const card = cards.find((entry) => entry.cardId === event.active.id);
    setDragging(card ?? null);
  };

  const onDragEnd = (event: DragEndEvent) => {
    setDragging(null);

    const { active, over } = event;
    if (over === null) return;

    const cardId = String(active.id);
    const overId = String(over.id);

    const card = cards.find((entry) => entry.cardId === cardId);
    if (card === undefined) return;

    /* Which list was it dropped into? `over` is either a card — whose list is
       the answer — or a column, whose id IS the list id. Anything else means
       the pointer was released outside the board. */
    const overCard = cards.find((entry) => entry.cardId === overId);
    const targetListId =
      overCard?.listId ?? (lists.some((l) => l.listId === overId) ? overId : null);
    if (targetListId === null) return;

    const siblings = byList.get(targetListId) ?? [];
    const { beforeCardId, afterCardId } = neighboursForSortableDrop(siblings, cardId, overId);

    // Dropping a card back exactly where it was is not a move.
    if (
      card.listId === targetListId &&
      beforeCardId === (previousOf(siblings, cardId)?.cardId ?? null)
    ) {
      return;
    }

    move.mutate({
      cardId: cardId as CardId,
      targetListId: targetListId as ListId,
      beforeCardId,
      afterCardId,
    });
  };

  if (lists.length === 0) {
    return <EmptyBoard orgId={orgId} boardId={boardId} />;
  }

  return (
    <div className="min-h-0 flex-1 overflow-x-auto">
      {/* No error banner. A failed move is reported by the toast the optimistic
          helper raises, next to where the card snapped back rather than pinned to
          the top of a horizontally scrolling board the user may have scrolled
          away from. */}
      {move.data?.wipExceeded === true && (
        <p className="border-b border-warning/40 bg-warning/10 px-4 py-1.5 text-xs text-ink">
          That list is over its WIP limit. The move was recorded anyway — the limit is a signal, not
          a gate.
        </p>
      )}

      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={() => {
          setDragging(null);
        }}
      >
        <div className={cn('flex h-full items-start gap-3 p-3')}>
          {lists.map((list) => {
            const columnCards = byList.get(list.listId) ?? [];
            return (
              <ListColumn
                key={list.listId}
                orgId={orgId}
                boardId={boardId}
                list={list}
                count={columnCards.length}
                siblings={lists}
              >
                <SortableContext
                  items={columnCards.map((card) => card.cardId)}
                  strategy={verticalListSortingStrategy}
                >
                  {columnCards.map((card) => (
                    <SortableCard key={card.cardId} card={card} onOpen={onOpenCard} />
                  ))}
                </SortableContext>
              </ListColumn>
            );
          })}

          {/* Always present, so a board is never a dead end. Cards are added
              from inside a column, which means "no lists" used to mean "no way
              to put anything on this board". */}
          <AddListColumn orgId={orgId} boardId={boardId} />
        </div>

        {/* The overlay is what the pointer carries. Without it the original tile
            is dragged out of its column and every other card reflows around a
            hole, which reads as the board rearranging itself. */}
        <DragOverlay>
          {dragging === null ? null : <CardTile card={dragging} dragging />}
        </DragOverlay>
      </DndContext>
    </div>
  );
}

function SortableCard({
  card,
  onOpen,
}: {
  readonly card: CardSummary;
  readonly onOpen: (cardId: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: card.cardId,
  });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(isDragging && 'opacity-40')}
      {...attributes}
      {...listeners}
    >
      <CardTile card={card} onOpen={onOpen} />
    </div>
  );
}

/** The card immediately above `cardId`, or null if it is first. */
function previousOf(ordered: readonly CardSummary[], cardId: string): CardSummary | null {
  const index = ordered.findIndex((card) => card.cardId === cardId);
  return index <= 0 ? null : (ordered[index - 1] ?? null);
}

/**
 * The optimistic patch: the card in its new list, in its new position.
 *
 * Rebuilds the ORDER rather than assigning a rank. Any rank invented here would
 * be a second opinion about placement that the server's answer could contradict,
 * and the board would visibly reorder a second time when the query settled.
 * Rewriting the array instead means the only claim being made is the one the
 * user just made with the pointer.
 */
function reorder(
  cards: readonly CardSummary[],
  input: { cardId: string; targetListId: string; beforeCardId: string | null },
): readonly CardSummary[] {
  const moved = cards.find((card) => card.cardId === input.cardId);
  if (moved === undefined) return cards;

  const rest = cards.filter((card) => card.cardId !== input.cardId);
  const relocated = { ...moved, listId: input.targetListId };

  if (input.beforeCardId === null) {
    // First in its list: ahead of everything already there.
    const at = rest.findIndex((card) => card.listId === input.targetListId);
    const index = at === -1 ? rest.length : at;
    return [...rest.slice(0, index), relocated, ...rest.slice(index)];
  }

  const after = rest.findIndex((card) => card.cardId === input.beforeCardId);
  const index = after === -1 ? rest.length : after + 1;
  return [...rest.slice(0, index), relocated, ...rest.slice(index)];
}
