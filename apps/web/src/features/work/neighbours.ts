import type { CardId } from '@taskflow/contracts';

/**
 * Turning a drop position into the neighbour pair `cards.move` expects.
 *
 * §10.1 is explicit that the client sends NEIGHBOURS and the server derives the
 * rank. There is no `position` and no `rank` on the wire, because a
 * client-computed rank is computed from a board that was read some time ago —
 * so two people dragging at once each place their card according to a different
 * past, and one of them lands somewhere nobody chose.
 *
 * That leaves this function as the whole client-side contribution to ordering,
 * and it is small enough to be obviously right and easy to get subtly wrong.
 * The two failures it exists to prevent:
 *
 *   - OFF BY ONE against the dragged card's own old position. When a card moves
 *     DOWN within its own list, the array still contains it at a lower index, so
 *     an index taken from the rendered list is one too high once it is removed.
 *     Callers pass the list WITHOUT the dragged card for exactly this reason,
 *     and `neighboursForDrop` documents that as a precondition it cannot check.
 *   - DIRECTION. `before` is the card the dropped one ends up AFTER — the lower
 *     rank — matching `between(before, after)` in @taskflow/contracts. Swapping
 *     them produces a move that lands one slot off, or an `InvalidRankError`
 *     when the two are out of order, which the server would then treat as a
 *     degenerate list and rebalance an entire column over a client bug.
 */

export interface Neighbours {
  readonly beforeCardId: CardId | null;
  readonly afterCardId: CardId | null;
}

/**
 * The neighbours for inserting at `index` in `siblings`.
 *
 * `siblings` must be the target list in rank order WITH THE DRAGGED CARD
 * REMOVED, and `index` the position it should occupy in that array — 0 for the
 * top, `siblings.length` for the bottom.
 *
 * Both null means an empty list, which is a legal move and not an error: it is
 * the first card in a new column.
 */
export function neighboursForDrop(
  siblings: readonly { readonly cardId: string }[],
  index: number,
): Neighbours {
  /* Clamped rather than trusted. dnd-kit reports the index of the element under
     the pointer, and a drop onto a list's empty area or its header produces a
     -1 that would otherwise read as "one before the first" — silently the same
     as dropping at the top, which is not what the user did. */
  const position = Math.max(0, Math.min(index, siblings.length));

  return {
    beforeCardId: (siblings[position - 1]?.cardId ?? null) as CardId | null,
    afterCardId: (siblings[position]?.cardId ?? null) as CardId | null,
  };
}

/**
 * Neighbours for dropping `cardId` onto `overId` within an ordered list.
 *
 * The shape dnd-kit actually gives on a sortable drop: an active id and the id
 * it was released over. Removing the active card first is what makes a downward
 * move inside one list land where the user let go rather than one slot short.
 *
 * `overId` naming the list itself — which is what dnd-kit reports when a card
 * is dropped on empty space below the last one — appends.
 */
export function neighboursForSortableDrop(
  ordered: readonly { readonly cardId: string }[],
  cardId: string,
  overId: string,
): Neighbours {
  const without = ordered.filter((card) => card.cardId !== cardId);

  /* Dropped on itself — a click, or a drag that ended where it started.
     Checked FIRST, because it has to be: the card has just been removed from
     `without`, so searching for it there returns -1, which falls through to the
     append branch below. That would report the bottom of the list as the drop
     position, and a card picked up and put straight back down would jump to the
     end of its column. Its own current position is the answer instead. */
  if (cardId === overId) {
    const original = ordered.findIndex((card) => card.cardId === cardId);
    return neighboursForDrop(without, original === -1 ? without.length : original);
  }

  const target = without.findIndex((card) => card.cardId === overId);

  // `overId` is the LIST rather than a card in it, which is what dnd-kit
  // reports for a drop below the last card.
  if (target === -1) return neighboursForDrop(without, without.length);

  /* Dropping ONTO a card means taking its place: the dragged card goes where
     the target currently is, pushing it down. `target` is therefore the
     insertion index, not `target + 1`. */
  return neighboursForDrop(without, target);
}
