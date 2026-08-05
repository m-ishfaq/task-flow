import type { ListId } from '@taskflow/contracts';
import { neighboursForSortableDrop, type Neighbours } from './neighbours.js';

/**
 * Turning a dnd-kit drop into the `cards.move` input, for LIST grouping.
 *
 * Extracted from `board-view.tsx` rather than left inline, because a drop that
 * resolves to the wrong list is indistinguishable from a drop that does not
 * resolve at all: both end with the card back where it started and nothing on
 * screen to say why. `neighbours.ts` is unit tested and this — the step that
 * decides WHICH LIST those neighbours are measured in — was not, which is how a
 * board shipped where dragging across columns did nothing.
 *
 * Note what this does NOT do: it never invents a rank, and it never guesses a
 * nearest list. An unresolvable drop returns null so the caller stays still,
 * because the server treats a neighbour from the wrong list as a 404 (§10.1) and
 * a silent nearest-guess is exactly how a drag lands in a column nobody chose.
 */

/** The minimum a card must expose to be placed. Structural so tests need no wire type. */
interface CardPlacement {
  readonly cardId: string;
  readonly listId: string;
}

interface ListLike {
  readonly listId: string;
}

/** A grouping bucket — `key` is the list id under LIST grouping. */
interface GroupLike {
  readonly key: string;
  readonly cards: readonly CardPlacement[];
}

export interface ListDrop extends Neighbours {
  readonly targetListId: ListId;
}

export interface ListDropInput {
  /** Every card on the board, filtered exactly as rendered. */
  readonly cards: readonly CardPlacement[];
  /** Every column, so a drop on empty space below the last card still resolves. */
  readonly lists: readonly ListLike[];
  /** `groupCards(cards, 'list', …)` — the rendered order, which is what the user aimed at. */
  readonly groups: readonly GroupLike[];
  readonly activeCardId: string;
  readonly overId: string;
}

/**
 * The move a drop represents, or null if it is not a move.
 *
 * Null covers three genuinely different non-moves that the caller treats
 * identically — the card was released over nothing droppable, over a list that
 * is no longer rendered, or back in the position it already occupied. None of
 * them should reach `cards.move`: the first two have no destination, and the
 * third would spend a round trip and an audit entry recording that nothing
 * changed.
 */
export function resolveListDrop(input: ListDropInput): ListDrop | null {
  const card = input.cards.find((entry) => entry.cardId === input.activeCardId);
  if (card === undefined) return null;

  /* Which list was it dropped into? `over` is either a card — whose list is the
     answer — or a column, whose id IS the list id. Anything else means the
     pointer was released outside the board. */
  const overCard = input.cards.find((entry) => entry.cardId === input.overId);
  const targetListId =
    overCard?.listId ?? (input.lists.some((l) => l.listId === input.overId) ? input.overId : null);
  if (targetListId === null) return null;

  const siblings = input.groups.find((group) => group.key === targetListId)?.cards ?? [];
  const { beforeCardId, afterCardId } = neighboursForSortableDrop(
    siblings,
    input.activeCardId,
    input.overId,
  );

  /* Dropping a card back exactly where it was is not a move. Guarded on the
     list as well as the neighbour: the same `beforeCardId` in a DIFFERENT list
     is a real move, and comparing neighbours alone would swallow the most
     common drag on a board — the leftmost card to the top of the next column,
     where both are "first" and both have no predecessor. */
  if (
    card.listId === targetListId &&
    beforeCardId === (previousOf(siblings, input.activeCardId)?.cardId ?? null)
  ) {
    return null;
  }

  return { targetListId: targetListId as ListId, beforeCardId, afterCardId };
}

/** The card immediately above `cardId`, or null if it is first or absent. */
function previousOf(ordered: readonly CardPlacement[], cardId: string): CardPlacement | null {
  const index = ordered.findIndex((card) => card.cardId === cardId);
  return index <= 0 ? null : (ordered[index - 1] ?? null);
}
