import { describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { BoardId, CardId } from '@taskflow/contracts';
import { keys } from '../../lib/query.js';
import {
  filterKey,
  patchBoardCards,
  patchCardLabels,
  patchChecklistCounters,
  patchCommentCount,
  patchComments,
  type CardSummary,
  type Comment,
} from './api.js';

/**
 * The optimistic cache patches.
 *
 * These are tested for the same reason `neighbours.ts` is: every way they can be
 * wrong is SILENT. A counter delta with the branch inverted, or a patch that
 * misses the board's second cached filter, produces a number that is simply
 * wrong on screen — and a stale badge looks exactly like a correct one, which is
 * the whole argument `apps/api/src/work/counters.ts` makes for recomputing
 * server-side. The client can undo that guarantee without anything failing.
 */

const ORG = 'org-1';
const BOARD = 'board-1' as BoardId;
const CARD = 'card-1' as CardId;

function card(overrides: Partial<CardSummary> = {}): CardSummary {
  return {
    cardId: CARD,
    listId: 'list-1',
    boardId: BOARD,
    reference: 'WEB-1',
    title: 'A card',
    rank: 'a0',
    assigneeIds: [],
    statusId: null,
    priority: null,
    dueDate: null,
    commentCount: 0,
    checklistDone: 0,
    checklistTotal: 0,
    version: 1,
    ...overrides,
  };
}

function comment(commentId: string): Comment {
  return {
    commentId,
    cardId: CARD,
    parentCommentId: null,
    authorId: 'user-1',
    body: { type: 'doc', content: [] },
    bodyText: '',
    editedAt: null,
    deletedAt: null,
    createdAt: '2026-08-04T00:00:00.000Z',
  };
}

function boardCards(client: QueryClient, filter: string): readonly CardSummary[] | undefined {
  return client.getQueryData<readonly CardSummary[]>(keys.cards(ORG, BOARD, filter));
}

describe('patchBoardCards', () => {
  it('rewrites EVERY cached filter variant of the same board', () => {
    /* The failure this rules out: a board holds one cache entry per filter the
       user has visited, so patching only the visible one leaves the others
       stale — and they render from cache the instant the filter is cleared,
       which reads as the change having been undone. */
    const client = new QueryClient();
    client.setQueryData(keys.cards(ORG, BOARD, filterKey(null)), [card()]);
    client.setQueryData(keys.cards(ORG, BOARD, 'mine'), [card()]);

    patchBoardCards(client, ORG, BOARD, (cards) =>
      cards.map((entry) => ({ ...entry, title: 'Renamed' })),
    );

    expect(boardCards(client, filterKey(null))?.[0]?.title).toBe('Renamed');
    expect(boardCards(client, 'mine')?.[0]?.title).toBe('Renamed');
  });

  it('changes the array identity when it changes the data', () => {
    // A patch that mutated in place would keep the same reference, React Query
    // would skip the re-render, and the optimistic update would look like no
    // update at all.
    const client = new QueryClient();
    const before = [card()];
    client.setQueryData(keys.cards(ORG, BOARD, filterKey(null)), before);

    patchBoardCards(client, ORG, BOARD, (cards) =>
      cards.map((entry) => ({ ...entry, title: 'Renamed' })),
    );

    expect(boardCards(client, filterKey(null))).not.toBe(before);
  });

  it('keeps the identity when the patch changes nothing', () => {
    /* Not incidental — React Query applies STRUCTURAL SHARING inside
       `setQueryData` and hands back the previous reference when the new value is
       deeply equal. So returning a fresh array is not by itself proof that a
       re-render happens, and a test asserting a new identity after a no-op patch
       fails against perfectly correct code. Worth knowing before writing the
       next one of these: identity tracks the DATA, not the allocation. */
    const client = new QueryClient();
    const before = [card()];
    client.setQueryData(keys.cards(ORG, BOARD, filterKey(null)), before);

    patchBoardCards(client, ORG, BOARD, (cards) => cards.map((entry) => ({ ...entry })));

    expect(boardCards(client, filterKey(null))).toBe(before);
  });

  it('leaves other cards on the board alone', () => {
    const client = new QueryClient();
    client.setQueryData(keys.cards(ORG, BOARD, filterKey(null)), [
      card(),
      card({ cardId: 'card-2', commentCount: 7 }),
    ]);

    patchCommentCount(client, ORG, BOARD, CARD, 1);

    const cards = boardCards(client, filterKey(null));
    expect(cards?.[0]?.commentCount).toBe(1);
    expect(cards?.[1]?.commentCount).toBe(7);
  });
});

describe('patchChecklistCounters', () => {
  it('moves done and total independently', () => {
    /* Deleting a TICKED item lowers both numbers; deleting an unticked one
       lowers only the total. That branch living in the caller is why it is
       expressed as a delta pair rather than as an operation name. */
    const client = new QueryClient();
    client.setQueryData(keys.cards(ORG, BOARD, filterKey(null)), [
      card({ checklistDone: 2, checklistTotal: 5 }),
    ]);

    patchChecklistCounters(client, ORG, BOARD, CARD, { done: -1, total: -1 });

    const patched = boardCards(client, filterKey(null))?.[0];
    expect(patched?.checklistDone).toBe(1);
    expect(patched?.checklistTotal).toBe(4);
  });

  it('clamps at zero rather than going negative', () => {
    // Two toggles landing before either settles must not render `-1/5`; a
    // negative count reads as a bug where a momentarily stale one does not.
    const client = new QueryClient();
    client.setQueryData(keys.cards(ORG, BOARD, filterKey(null)), [
      card({ checklistDone: 0, checklistTotal: 3 }),
    ]);

    patchChecklistCounters(client, ORG, BOARD, CARD, { done: -1, total: 0 });

    expect(boardCards(client, filterKey(null))?.[0]?.checklistDone).toBe(0);
  });
});

describe('patchCommentCount', () => {
  it('clamps at zero', () => {
    const client = new QueryClient();
    client.setQueryData(keys.cards(ORG, BOARD, filterKey(null)), [card({ commentCount: 0 })]);

    patchCommentCount(client, ORG, BOARD, CARD, -1);

    expect(boardCards(client, filterKey(null))?.[0]?.commentCount).toBe(0);
  });

  it('is a no-op when the board is not cached', () => {
    // The detail panel is deep-linkable, so a comment can be posted with no
    // board query in the cache at all. That must not throw.
    const client = new QueryClient();
    expect(() => {
      patchCommentCount(client, ORG, BOARD, CARD, 1);
    }).not.toThrow();
  });
});

describe('patchComments', () => {
  it('appends without touching the existing entries', () => {
    const client = new QueryClient();
    client.setQueryData(keys.comments(ORG, CARD), [comment('c1')]);

    patchComments(client, ORG, CARD, (current) => [...current, comment('pending:1')]);

    const after = client.getQueryData<readonly Comment[]>(keys.comments(ORG, CARD));
    expect(after?.map((entry) => entry.commentId)).toEqual(['c1', 'pending:1']);
  });

  it('is a no-op on a cold key', () => {
    const client = new QueryClient();

    patchComments(client, ORG, CARD, (current) => [...current, comment('pending:1')]);

    /* Deliberately NOT seeded. `optimistic.ts` rolls back by REMOVING a key that
       held nothing at snapshot time, so inventing an entry here would survive
       its own rollback and render as a real comment. */
    expect(client.getQueryData(keys.comments(ORG, CARD))).toBeUndefined();
  });
});

describe('patchCardLabels', () => {
  it('rewrites the card label set', () => {
    const client = new QueryClient();
    const label = (labelId: string) => ({
      labelId,
      projectId: 'project-1',
      name: labelId,
      color: '#ef4444',
      cardCount: 1,
    });
    client.setQueryData(keys.cardLabels(ORG, CARD), [label('a'), label('b')]);

    patchCardLabels(client, ORG, CARD, (labels) => labels.filter((entry) => entry.labelId === 'b'));

    expect(
      client
        .getQueryData<readonly { labelId: string }[]>(keys.cardLabels(ORG, CARD))
        ?.map((entry) => entry.labelId),
    ).toEqual(['b']);
  });
});
