import { pointerWithin, rectIntersection, type CollisionDetection } from '@dnd-kit/core';

/**
 * Which droppable a board drag is currently over.
 *
 * ## Why `closestCorners` alone is wrong here
 *
 * Every column registers a droppable that CONTAINS the card droppables inside
 * it. `closestCorners` ranks by distance between corners, so the answer depends
 * on the geometry of a column rather than on what the pointer is touching: a
 * tall column whose corners happen to sit nearer the dragged card outranks the
 * card the user is actually hovering. When that happens `over` is the LIST id,
 * `resolveListDrop` reads it as "dropped on empty space below the last card",
 * and the card appends to the bottom of the column instead of landing where it
 * was released. The move succeeds, so nothing looks broken — the card is just
 * in the wrong place, which reads as ordering being unreliable rather than as a
 * collision bug.
 *
 * Continuous re-measuring (`MeasuringStrategy.Always` in board-view) is what
 * makes cross-column drops resolve at all, and it makes this worse rather than
 * better: correct, fresh column rectangles compete with the cards inside them
 * on every frame.
 *
 * ## The rule
 *
 * Pointer first, and prefer the innermost thing under it. A card and the column
 * containing it are both "under" the pointer and only one of them is what the
 * user means.
 */

/** The minimum a dnd-kit collision exposes. Structural so the test needs no dnd-kit. */
interface CollisionLike {
  readonly id: string | number;
}

/**
 * Drops the container droppables when any non-container is also a candidate.
 *
 * Falls back to the containers untouched rather than to an empty list — a
 * pointer over a column's header or the empty space below its last card has
 * genuinely collided with the column and nothing else, and that is a legal drop
 * meaning "append here".
 */
export function preferInnermost<T extends CollisionLike>(
  candidates: readonly T[],
  containerIds: ReadonlySet<string>,
): readonly T[] {
  const innermost = candidates.filter((candidate) => !containerIds.has(String(candidate.id)));
  return innermost.length > 0 ? innermost : candidates;
}

/**
 * `containerIds` are the column droppable ids — list ids under LIST grouping,
 * group keys otherwise.
 */
export function boardCollisionDetection(containerIds: ReadonlySet<string>): CollisionDetection {
  return (args) => {
    /* `pointerWithin` is the truthful answer when there is a pointer: it asks
       what the cursor is inside, not what is geometrically near. It returns
       nothing at all during a KEYBOARD drag, which is the only reason the
       second strategy is here rather than as a nearest-guess. */
    const underPointer = pointerWithin(args);
    const candidates = underPointer.length > 0 ? underPointer : rectIntersection(args);

    /* Deliberately no `closestCorners` fallback. Empty means the card is over
       nothing droppable — dragged onto the sidebar, or off the board to abandon
       the drag — and `closestCorners` always answers with SOMETHING, so it
       would turn "put this back, I changed my mind" into a move to whichever
       column happened to be nearest. §10.1 makes the same argument about
       neighbours: a drop that cannot be resolved is a non-move, never a guess. */
    return [...preferInnermost(candidates, containerIds)];
  };
}
