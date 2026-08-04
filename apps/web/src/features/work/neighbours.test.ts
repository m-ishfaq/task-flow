import { describe, expect, it } from 'vitest';
import { between } from '@taskflow/contracts';
import { neighboursForDrop, neighboursForSortableDrop } from './neighbours.js';

/**
 * The drop-to-neighbours mapping.
 *
 * Worth testing on its own because every failure it can produce is SILENT: the
 * card lands one slot from where it was dropped, which looks like a rendering
 * glitch, and the server cannot tell the difference — it faithfully places the
 * card between the two neighbours it was given.
 *
 * The last group closes the loop by feeding the result to the real `between()`
 * from @taskflow/contracts, which is the function the server actually calls. A
 * neighbour pair in the wrong order throws `InvalidRankError` there, and the
 * server responds by REBALANCING THE WHOLE COLUMN — treating a client bug as
 * the concurrency damage that error normally signals.
 */

const cards = (...ids: string[]) => ids.map((cardId) => ({ cardId }));

describe('neighboursForDrop', () => {
  it('reports both neighbours as null for an empty list', () => {
    expect(neighboursForDrop([], 0)).toEqual({ beforeCardId: null, afterCardId: null });
  });

  it('has no `before` at the top and no `after` at the bottom', () => {
    const list = cards('a', 'b', 'c');

    expect(neighboursForDrop(list, 0)).toEqual({ beforeCardId: null, afterCardId: 'a' });
    expect(neighboursForDrop(list, 3)).toEqual({ beforeCardId: 'c', afterCardId: null });
  });

  it('brackets the insertion point in the middle', () => {
    expect(neighboursForDrop(cards('a', 'b', 'c'), 2)).toEqual({
      beforeCardId: 'b',
      afterCardId: 'c',
    });
  });

  it('clamps an index from outside the list', () => {
    /* dnd-kit reports -1 when a card is released over a list's header or empty
       area. Left unclamped that reads as "one before the first", which is
       indistinguishable from a deliberate drop at the top. */
    const list = cards('a', 'b');

    expect(neighboursForDrop(list, -1)).toEqual({ beforeCardId: null, afterCardId: 'a' });
    expect(neighboursForDrop(list, 99)).toEqual({ beforeCardId: 'b', afterCardId: null });
  });
});

describe('neighboursForSortableDrop', () => {
  it('removes the dragged card before measuring — the downward-move bug', () => {
    /* The one that is wrong in every naive implementation. Dragging `a` onto
       `c` in [a, b, c]: with `a` still in the array `c` sits at index 2, so the
       neighbours come out as (b, c) and the card lands BEFORE c — one slot
       short of where it was dropped. Removing `a` first gives [b, c], `c` at
       index 1, and neighbours (b, c) meaning "between b and c", which is where
       the pointer was. */
    expect(neighboursForSortableDrop(cards('a', 'b', 'c'), 'a', 'c')).toEqual({
      beforeCardId: 'b',
      afterCardId: 'c',
    });
  });

  it('moves a card upward', () => {
    expect(neighboursForSortableDrop(cards('a', 'b', 'c'), 'c', 'a')).toEqual({
      beforeCardId: null,
      afterCardId: 'a',
    });
  });

  it('appends when dropped over something that is not a card in the list', () => {
    // dnd-kit reports the LIST's id when a card is released below the last one.
    expect(neighboursForSortableDrop(cards('a', 'b'), 'a', 'list-todo')).toEqual({
      beforeCardId: 'b',
      afterCardId: null,
    });
  });

  it('moves a card into an empty list', () => {
    expect(neighboursForSortableDrop([], 'a', 'list-doing')).toEqual({
      beforeCardId: null,
      afterCardId: null,
    });
  });

  it('is a no-op pair when a card is dropped on itself', () => {
    /* Dropping a card where it already is must not be a special case that
       lands it somewhere else. With `a` removed from [a, b], `b` is at index 0,
       so the pair is (null, b) — a's existing position. */
    expect(neighboursForSortableDrop(cards('a', 'b'), 'a', 'a')).toEqual({
      beforeCardId: null,
      afterCardId: 'b',
    });
  });
});

describe('the pair is always usable by the server', () => {
  /**
   * The ranks a real board would hold, in order. `between` requires
   * `before < after` and throws otherwise — which on the server triggers a
   * rebalance of the entire column, so a reversed pair from this module would
   * rewrite every card in a list because of a client-side mistake.
   */
  const ranked = [
    { cardId: 'a', rank: 'a0' },
    { cardId: 'b', rank: 'a1' },
    { cardId: 'c', rank: 'a2' },
  ];

  const rankOf = (cardId: string | null): string | null =>
    cardId === null ? null : (ranked.find((card) => card.cardId === cardId)?.rank ?? null);

  it('produces neighbours in ascending rank order for every drop position', () => {
    for (let index = 0; index <= ranked.length; index += 1) {
      const { beforeCardId, afterCardId } = neighboursForDrop(ranked, index);

      const generated = between(rankOf(beforeCardId), rankOf(afterCardId));

      const before = rankOf(beforeCardId);
      const after = rankOf(afterCardId);
      if (before !== null) expect(generated > before).toBe(true);
      if (after !== null) expect(generated < after).toBe(true);
    }
  });

  it('produces an ordered pair for every sortable drop combination', () => {
    for (const dragged of ['a', 'b', 'c']) {
      for (const over of ['a', 'b', 'c', 'list-id']) {
        const { beforeCardId, afterCardId } = neighboursForSortableDrop(ranked, dragged, over);

        // The assertion is simply that the server would not throw.
        expect(() => between(rankOf(beforeCardId), rankOf(afterCardId))).not.toThrow();
      }
    }
  });
});
