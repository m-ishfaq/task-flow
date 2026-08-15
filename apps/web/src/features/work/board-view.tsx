import { useMemo, useState, type ReactNode } from 'react';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MeasuringStrategy,
  PointerSensor,
  useDroppable,
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
import type { BoardId, CardId, ListId, StatusId, UserId } from '@taskflow/contracts';
import { api } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { useOptimistic } from '../../lib/optimistic.js';
import { useToast } from '../../lib/toast-context.js';
import { cn } from '../../lib/cn.js';
import { CardTile } from './card-tile.js';
import { ListColumn } from './list-column.js';
import { resolveListDrop } from './drop.js';
import { boardCollisionDetection } from './collision.js';
import { AddListColumn, EmptyBoard } from './add-list.js';
import { patchBoardCards, type CardSummary, type ListSummary, type Status } from './api.js';
import { useUpdateCard } from './use-update-card.js';
import {
  NONE_KEY,
  fieldPatchForGroup,
  groupCards,
  isDraggable,
  sortCards,
  type Group,
  type GroupBy,
  type SortBy,
} from './grouping.js';
import type { Person } from '../org/use-members.js';

interface MoveInput {
  readonly cardId: CardId;
  readonly targetListId: ListId;
  readonly beforeCardId: CardId | null;
  readonly afterCardId: CardId | null;
}

/**
 * The kanban board (§10.4, dnd-kit; grouping per `ai/phase-3.5-work-ux.md` §5.6).
 *
 * ## What is sent on a drop
 *
 * Grouped by LIST, neighbours — never a rank or a position, see neighbours.ts.
 * The server derives the rank inside the same transaction that moves the
 * card, so two people dragging at once are adjudicated against one present
 * rather than two pasts.
 *
 * Grouped by anything else, there is no rank to derive: `fieldPatchForGroup`
 * (grouping.ts) says which field the drop sets — status, assignee, or
 * priority — and the mutation for that field runs instead of `cards.move`.
 * §3.2's rule is why: a group has no stored order of its own, so dragging
 * within one is not persisted, only dragging ACROSS groups.
 *
 * ## Two id schemes share one DndContext
 *
 * Every grouping but `assignee` gives a card exactly one group, so its own
 * `cardId` is a safe, unique dnd-kit element id. `assignee` does not — a
 * card assigned to two people renders once in EACH of their columns — so
 * dnd-kit would see the same id twice in the tree, which it cannot resolve.
 * `elementIdOf`/`cardIdOfElement` exist only for that one grouping: they
 * compose a group-scoped id (`groupKey::cardId`) and decode it back, so two
 * renders of the same card get two distinct, draggable identities.
 *
 * ## The optimistic update
 *
 * Through `useOptimistic` (lib/optimistic.ts), which owns the cancel →
 * snapshot → patch → rollback → invalidate cycle so it cannot be implemented
 * two-thirds of the way. `patchBoardCards` resolves every cached filter
 * variant by prefix, so a card moved while a filter is applied does not
 * appear to jump back the instant the filter clears.
 */

export interface BoardViewProps {
  readonly orgId: string;
  readonly boardId: BoardId;
  readonly lists: readonly ListSummary[];
  readonly cards: readonly CardSummary[];
  readonly statuses: readonly Status[];
  readonly people: readonly Person[];
  readonly groupBy: GroupBy;
  readonly sortBy: SortBy;
  readonly selected: ReadonlySet<string>;
  /** `extend` is a shift-click — a range from the anchor, not a single toggle. */
  readonly onToggleSelect: (cardId: string, extend: boolean) => void;
  readonly onOpenCard: (cardId: string) => void;
}

const GROUP_SEP = '::';

function elementIdOf(groupBy: GroupBy, groupKey: string, cardId: string): string {
  return groupBy === 'assignee' ? `${groupKey}${GROUP_SEP}${cardId}` : cardId;
}

function cardIdOfElement(groupBy: GroupBy, elementId: string): string {
  if (groupBy !== 'assignee') return elementId;
  const index = elementId.indexOf(GROUP_SEP);
  return index === -1 ? elementId : elementId.slice(index + GROUP_SEP.length);
}

export function BoardView({
  orgId,
  boardId,
  lists,
  cards,
  statuses,
  people,
  groupBy,
  sortBy,
  selected,
  onToggleSelect,
  onOpenCard,
}: BoardViewProps) {
  const queryClient = useQueryClient();
  const optimistic = useOptimistic();
  const toast = useToast();
  const updateCard = useUpdateCard(orgId, boardId);
  const [dragging, setDragging] = useState<CardSummary | null>(null);

  const groups = useMemo(
    () => groupCards(cards, groupBy, { lists, statuses, people }),
    [cards, groupBy, lists, statuses, people],
  );

  /* The column droppable ids, so collision detection can tell a container from
     the cards inside it. Under LIST grouping the columns are the lists
     themselves — including any with no cards, which still accept a drop. */
  const collisionDetection = useMemo(
    () =>
      boardCollisionDetection(
        new Set(groupBy === 'list' ? lists.map((list) => list.listId) : groups.map((g) => g.key)),
      ),
    [groupBy, lists, groups],
  );

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

    /* A WIP breach is a transient NOTICE about one move, and `move.data` is
       persistent STATE about the last one. Rendering the notice from that state
       — which this did — leaves it on screen indefinitely after the drop that
       caused it, because nothing clears `data` until another move replaces it.
       The result is a warning about a card the user has long since stopped
       looking at, pinned above a board they may have scrolled away from, with
       no way to dismiss it and no indication of which list it means.

       A toast is the right shape: it is raised by the event, it names the list,
       and it expires on its own. `neutral`, not `danger` — the limit is
       advisory by design (§10.1) and the move succeeded, so colouring it as a
       failure would contradict the sentence it is showing. */
    onSuccess: (result, variables) => {
      if (!result.wipExceeded) return;
      const name = lists.find((list) => list.listId === variables.targetListId)?.name;

      toast.show(
        name === undefined ? 'That list is over its WIP limit' : `${name} is over its WIP limit`,
        { description: 'The move was recorded anyway — the limit is a signal, not a gate.' },
      );
    },

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

  const optimisticStatus = optimistic<{ cardId: CardId; statusId: StatusId | null }>({
    keys: [keys.cardsOfBoard(orgId, boardId)],
    patch: (client, { cardId, statusId }) => {
      patchBoardCards(client, orgId, boardId, (current) =>
        current.map((card) => (card.cardId === cardId ? { ...card, statusId } : card)),
      );
    },
    failureTitle: 'Status was not saved',
  });
  const setStatus = useMutation({
    mutationFn: (input: { cardId: CardId; statusId: StatusId | null }) =>
      api.work.cards.setStatus.mutate(input),
    ...optimisticStatus,
  });

  const optimisticAssignees = optimistic<{ cardId: CardId; assigneeIds: readonly UserId[] }>({
    keys: [keys.cardsOfBoard(orgId, boardId)],
    patch: (client, { cardId, assigneeIds }) => {
      patchBoardCards(client, orgId, boardId, (current) =>
        current.map((card) => (card.cardId === cardId ? { ...card, assigneeIds } : card)),
      );
    },
    failureTitle: 'Assignees were not saved',
  });
  const setAssignees = useMutation({
    mutationFn: (input: { cardId: CardId; assigneeIds: readonly UserId[] }) =>
      api.work.cards.assign.mutate({ cardId: input.cardId, assigneeIds: [...input.assigneeIds] }),
    ...optimisticAssignees,
  });

  const onDragStart = (event: DragStartEvent) => {
    const cardId = cardIdOfElement(groupBy, String(event.active.id));
    const card = cards.find((entry) => entry.cardId === cardId);
    setDragging(card ?? null);
  };

  const onDragEnd = (event: DragEndEvent) => {
    setDragging(null);

    const { active, over } = event;
    if (over === null) return;

    const cardId = cardIdOfElement(groupBy, String(active.id));
    const card = cards.find((entry) => entry.cardId === cardId);
    if (card === undefined) return;

    if (groupBy === 'list') {
      // Resolved in drop.ts, where it is unit tested — see that file's header.
      const resolved = resolveListDrop({
        cards,
        lists,
        groups,
        activeCardId: cardId,
        overId: String(over.id),
      });
      if (resolved === null) return;

      move.mutate({
        cardId: cardId as CardId,
        targetListId: resolved.targetListId,
        beforeCardId: resolved.beforeCardId,
        afterCardId: resolved.afterCardId,
      });
      return;
    }

    const targetGroupKey = resolveTargetGroupKey(String(over.id), groupBy, groups, cards);
    if (targetGroupKey === null) return;

    const alreadyThere = groups.some(
      (g) => g.key === targetGroupKey && g.cards.some((entry) => entry.cardId === cardId),
    );
    if (alreadyThere) return;

    const patch = fieldPatchForGroup(groupBy, targetGroupKey);
    if (patch === null) return;

    if ('statusId' in patch) {
      setStatus.mutate({ cardId: cardId as CardId, statusId: patch.statusId as StatusId | null });
    } else if ('assigneeIds' in patch) {
      setAssignees.mutate({ cardId: cardId as CardId, assigneeIds: patch.assigneeIds as UserId[] });
    } else {
      updateCard.mutate({ cardId: cardId as CardId, patch: { priority: patch.priority } });
    }
  };

  if (lists.length === 0) {
    return <EmptyBoard orgId={orgId} boardId={boardId} />;
  }

  if (!isDraggable(groupBy)) {
    return (
      <div className="min-h-0 flex-1 overflow-x-auto">
        <div className="flex h-full items-start gap-3 p-3">
          {groups.map((group) => (
            <StaticColumn key={group.key} group={group}>
              {sortCards(group.cards, sortBy).map((card) => (
                <CardTile
                  key={card.cardId}
                  orgId={orgId}
                  card={card}
                  selected={selected.has(card.cardId)}
                  onToggleSelect={onToggleSelect}
                  onOpen={onOpenCard}
                />
              ))}
            </StaticColumn>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-x-auto">
      {/* No banners of any kind. A failed move is reported by the toast the
          optimistic helper raises, and a WIP breach by the one `move.onSuccess`
          raises — both next to where the card landed rather than pinned to the
          top of a horizontally scrolling board the user may have scrolled away
          from. See `onSuccess` for why this one cannot be rendered from
          `move.data`. */}
      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetection}
        /* Re-measure the columns continuously, not once at drag start.

           This is what makes dragging BETWEEN columns work at all. dnd-kit's
           default droppable strategy is `WhileDragging`, which measures every
           droppable once when the drag begins. Each column here is its own
           scroll container inside a horizontally scrolling board, and the
           moment cards reflow — which they do as soon as the dragged card is
           lifted out of its column — every OTHER column's cached rect is
           stale. `closestCorners` then compares the pointer against rectangles
           that no longer describe the page, resolves `over` to nothing, and
           `onDragEnd` returns early having never called a mutation.

           The failure is silent by construction: no request is made, so there
           is no error, no toast, and nothing in the network tab. The card
           simply snaps home, which reads as "drag and drop is broken" with no
           thread to pull. Reordering WITHIN a column keeps working the whole
           time, because that collision is resolved against sortable items
           whose transforms dnd-kit is already tracking — which is what makes
           it look like a cross-list bug rather than a measurement one.

           `resolveListDrop` is unit tested (drop.ts) and was correct
           throughout; no amount of reading it would have found this. */
        measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={() => {
          setDragging(null);
        }}
      >
        <div className={cn('flex h-full items-start gap-3 p-3')}>
          {groupBy === 'list'
            ? lists.map((list) => {
                const columnCards = groups.find((g) => g.key === list.listId)?.cards ?? [];
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
                        <SortableCard
                          key={card.cardId}
                          orgId={orgId}
                          card={card}
                          elementId={card.cardId}
                          selected={selected.has(card.cardId)}
                          onToggleSelect={onToggleSelect}
                          onOpen={onOpenCard}
                        />
                      ))}
                    </SortableContext>
                  </ListColumn>
                );
              })
            : groups.map((group) => {
                const ordered = sortCards(group.cards, sortBy);
                return (
                  <DroppableColumn key={group.key} group={group}>
                    <SortableContext
                      items={ordered.map((card) => elementIdOf(groupBy, group.key, card.cardId))}
                      strategy={verticalListSortingStrategy}
                    >
                      {ordered.map((card) => (
                        <SortableCard
                          key={elementIdOf(groupBy, group.key, card.cardId)}
                          orgId={orgId}
                          card={card}
                          elementId={elementIdOf(groupBy, group.key, card.cardId)}
                          selected={selected.has(card.cardId)}
                          onToggleSelect={onToggleSelect}
                          onOpen={onOpenCard}
                        />
                      ))}
                    </SortableContext>
                  </DroppableColumn>
                );
              })}

          {/* Always present in list grouping, so a board is never a dead end —
              cards are added from inside a column. Other groupings add no
              column of their own: the vocabulary (a status, say) is managed
              from project settings, not invented mid-drag. */}
          {groupBy === 'list' && <AddListColumn orgId={orgId} boardId={boardId} />}
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

/**
 * Which group a drop lands in, for every grouping but `list` (handled inline
 * in `onDragEnd` because it alone produces neighbours rather than a group key).
 *
 * `over` is either a column itself — its id IS the group key — or a card
 * rendered inside one. For `assignee`, that card's rendered id already
 * carries its group as a prefix (`elementIdOf`), because the same card can
 * render in several columns and only the ELEMENT says which one the pointer
 * is over. For `status` and `priority`, a card has exactly one group, so it
 * is read straight off the card's own field.
 */
function resolveTargetGroupKey(
  overRaw: string,
  groupBy: GroupBy,
  groups: readonly Group[],
  cards: readonly CardSummary[],
): string | null {
  if (groups.some((g) => g.key === overRaw)) return overRaw;

  if (groupBy === 'assignee') {
    const index = overRaw.indexOf(GROUP_SEP);
    return index === -1 ? null : overRaw.slice(0, index);
  }

  const overCard = cards.find((entry) => entry.cardId === overRaw);
  if (overCard === undefined) return null;

  if (groupBy === 'status') return overCard.statusId ?? NONE_KEY;
  if (groupBy === 'priority') return overCard.priority ?? NONE_KEY;
  return null;
}

/** A column for any grouping but `list`, which keeps its own `ListColumn` and its settings menu. */
function DroppableColumn({
  group,
  children,
}: {
  readonly group: Group;
  readonly children: ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: group.key });

  return (
    <section
      ref={setNodeRef}
      aria-label={group.label}
      className={cn(
        'flex max-h-full w-72 shrink-0 flex-col rounded-card bg-surface-sunken',
        isOver && 'ring-1 ring-accent',
      )}
    >
      <ColumnHeader group={group} />
      <div className="flex min-h-16 flex-col gap-2 overflow-y-auto px-2 pb-2">{children}</div>
    </section>
  );
}

/** Same header, for the non-draggable `due` grouping — no droppable registration, nothing to drop onto. */
function StaticColumn({
  group,
  children,
}: {
  readonly group: Group;
  readonly children: ReactNode;
}) {
  return (
    <section
      aria-label={group.label}
      className="flex max-h-full w-72 shrink-0 flex-col rounded-card bg-surface-sunken"
    >
      <ColumnHeader group={group} />
      <div className="flex min-h-16 flex-col gap-2 overflow-y-auto px-2 pb-2">{children}</div>
    </section>
  );
}

function ColumnHeader({ group }: { readonly group: Group }) {
  return (
    <header className="flex items-center gap-2 px-3 py-2">
      {group.color !== null && (
        <span
          className="size-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: group.color }}
          aria-hidden="true"
        />
      )}
      <h2 className="min-w-0 flex-1 truncate text-xs font-semibold tracking-wide text-ink-muted uppercase">
        {group.label}
      </h2>
      <span className="font-mono text-[11px] text-ink-faint">{group.cards.length}</span>
    </header>
  );
}

function SortableCard({
  orgId,
  card,
  elementId,
  selected,
  onToggleSelect,
  onOpen,
}: {
  readonly orgId: string;
  readonly card: CardSummary;
  readonly elementId: string;
  readonly selected: boolean;
  readonly onToggleSelect: (cardId: string, extend: boolean) => void;
  readonly onOpen: (cardId: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: elementId,
  });

  return (
    <div
      ref={setNodeRef}
      style={{
        /* The DRAGGED card must not translate. Everything else must.

           A `DragOverlay` is what follows the pointer here, so the original
           node stays where it was, dimmed. Applying `transform` to it as well
           moved the real node under the cursor too — and a droppable is
           measured from its node, so the dragged card's own drop target
           travelled with the pointer and stayed permanently underneath it.
           Collision detection then answered "you are over the card you are
           dragging" for the entire gesture, no matter which column the pointer
           reached, and `resolveListDrop` correctly read that as a drop onto
           itself: a no-op. Every drag ended with the card back where it began
           and no request made.

           The other cards' transforms are what open a gap to drop into, so this
           is conditional rather than removed. `undefined` rather than `'none'`
           so nothing is written to the style attribute at all — the overlay
           owns the moving copy. */
        transform: isDragging ? undefined : CSS.Transform.toString(transform),
        transition,
      }}
      className={cn(isDragging && 'opacity-40')}
      {...attributes}
      {...listeners}
    >
      <CardTile
        orgId={orgId}
        card={card}
        selected={selected}
        onToggleSelect={onToggleSelect}
        onOpen={onOpen}
      />
    </div>
  );
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
