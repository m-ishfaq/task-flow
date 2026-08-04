import { describe, expect, it } from 'vitest';
import { resolveListDrop } from './drop.js';

/**
 * The step between "dnd-kit reported a drop" and "the server is told to move a
 * card". Every way it can be wrong is silent — the card returns to where it
 * started and nothing says why — which is indistinguishable from the drop not
 * registering at all. That ambiguity is why these cases are asserted here
 * rather than inferred from watching a board.
 */

interface Card {
  readonly cardId: string;
  readonly listId: string;
}

const cards: readonly Card[] = [
  { cardId: 'a1', listId: 'todo' },
  { cardId: 'a2', listId: 'todo' },
  { cardId: 'a3', listId: 'todo' },
  { cardId: 'b1', listId: 'doing' },
  { cardId: 'b2', listId: 'doing' },
  { cardId: 'c1', listId: 'done' },
];

const lists = [{ listId: 'todo' }, { listId: 'doing' }, { listId: 'done' }, { listId: 'empty' }];

/** What `groupCards(cards, 'list', …)` produces: one bucket per column, rendered order. */
function groupsOf(all: readonly Card[]) {
  return lists.map((list) => ({
    key: list.listId,
    cards: all.filter((card) => card.listId === list.listId),
  }));
}

function drop(activeCardId: string, overId: string, all: readonly Card[] = cards) {
  return resolveListDrop({ cards: all, lists, groups: groupsOf(all), activeCardId, overId });
}

describe('dropping into another list', () => {
  it('lands above the card it was dropped onto', () => {
    // a1 onto b2: it takes b2's place, so b1 is above it and b2 below.
    expect(drop('a1', 'b2')).toEqual({
      targetListId: 'doing',
      beforeCardId: 'b1',
      afterCardId: 'b2',
    });
  });

  it('lands at the top when dropped onto the first card of the target', () => {
    expect(drop('a1', 'b1')).toEqual({
      targetListId: 'doing',
      beforeCardId: null,
      afterCardId: 'b1',
    });
  });

  it('appends when dropped on the column itself rather than a card', () => {
    // Empty space below the last card — dnd-kit reports the LIST id.
    expect(drop('a1', 'doing')).toEqual({
      targetListId: 'doing',
      beforeCardId: 'b2',
      afterCardId: null,
    });
  });

  it('is the first card of an empty column, with no neighbours either side', () => {
    expect(drop('a1', 'empty')).toEqual({
      targetListId: 'empty',
      beforeCardId: null,
      afterCardId: null,
    });
  });

  it('does not treat a cross-list drop as a no-op just because both are first', () => {
    /* The regression this file exists for. a1 is first in `todo` and c1 is
       first in `done`, so both have a null predecessor — a no-op guard that
       compared neighbours WITHOUT comparing the list would swallow the single
       most common drag on a board. */
    expect(drop('a1', 'c1')).toEqual({
      targetListId: 'done',
      beforeCardId: null,
      afterCardId: 'c1',
    });
  });
});

describe('reordering within one list', () => {
  it('moving down lands where the pointer was released, not one short', () => {
    // a1 onto a3: with a1 removed the array is [a2, a3], so it goes above a3.
    expect(drop('a1', 'a3')).toEqual({
      targetListId: 'todo',
      beforeCardId: 'a2',
      afterCardId: 'a3',
    });
  });

  it('moving up lands above the target', () => {
    expect(drop('a3', 'a1')).toEqual({
      targetListId: 'todo',
      beforeCardId: null,
      afterCardId: 'a1',
    });
  });

  it('is not a move when a card is dropped on itself', () => {
    expect(drop('a2', 'a2')).toBeNull();
  });

  it('is not a move when a card is dropped back onto the one already above it', () => {
    expect(drop('a2', 'a3')).toBeNull();
  });
});

describe('drops that resolve to nothing', () => {
  it('returns null when released over nothing on the board', () => {
    expect(drop('a1', 'not-a-card-or-list')).toBeNull();
  });

  it('returns null when the dragged card is not on the board', () => {
    expect(drop('ghost', 'b1')).toBeNull();
  });

  it('returns null rather than guessing when the target list is no longer rendered', () => {
    /* A list archived in another tab. Answering with a nearest column would put
       the card somewhere the user did not aim, and the server would accept it. */
    expect(
      resolveListDrop({
        cards,
        lists: [{ listId: 'todo' }],
        groups: [{ key: 'todo', cards: cards.filter((c) => c.listId === 'todo') }],
        activeCardId: 'a1',
        overId: 'doing',
      }),
    ).toBeNull();
  });
});
