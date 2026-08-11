import { describe, expect, it } from 'vitest';
import { filterCardsBySprint, type SprintFilter } from './sprints.js';
import type { CardSummary } from './api.js';

/**
 * The sprint dimension's filter — the whole definition of "which cards show
 * on this board" (`ai/phase-10.5-sprints.md`).
 *
 * Pure so the suite can pin it without rendering a board. Every way it could
 * be wrong is quiet — a backlog card vanishing from the backlog view, a card
 * from another project appearing in this one's sprint — and none of them fail
 * loudly. The three branches (all / backlog / one sprint) are the whole
 * behaviour; the `sprint=` URL param is just this function's input.
 */

const SPRINT_A = '0196-0000-7000-8000-0000000000a1';
const SPRINT_B = '0196-0000-7000-8000-0000000000a2';

function card(id: string, sprintId: string | null): CardSummary {
  return {
    cardId: id,
    listId: 'list-1',
    boardId: 'board-1',
    reference: `WEB-${id}`,
    title: `Card ${id}`,
    rank: '0',
    assigneeIds: [],
    statusId: null,
    priority: null,
    dueDate: null,
    sprintId,
    commentCount: 0,
    checklistDone: 0,
    checklistTotal: 0,
    version: 1,
    archivedAt: null,
  };
}

const CARDS: readonly CardSummary[] = [
  card('c1', SPRINT_A),
  card('c2', SPRINT_B),
  card('c3', null),
  card('c4', SPRINT_A),
];

describe('filterCardsBySprint', () => {
  it('passes everything through for All (null)', () => {
    expect(filterCardsBySprint(CARDS, null)).toHaveLength(4);
  });

  it('keeps only the cards with no sprint for Backlog', () => {
    const filtered = filterCardsBySprint(CARDS, 'backlog');
    expect(filtered.map((item) => item.cardId)).toEqual(['c3']);
  });

  it('keeps only the cards in the named sprint', () => {
    const filtered = filterCardsBySprint(CARDS, SPRINT_A as SprintFilter);
    expect(filtered.map((item) => item.cardId)).toEqual(['c1', 'c4']);
  });

  it('never leaks cards from another sprint', () => {
    const filtered = filterCardsBySprint(CARDS, SPRINT_B as SprintFilter);
    expect(filtered.every((item) => item.sprintId === SPRINT_B)).toBe(true);
  });

  it('returns the same array reference for All — the no-filter fast path', () => {
    expect(filterCardsBySprint(CARDS, null)).toBe(CARDS);
  });
});
