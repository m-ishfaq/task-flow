import { and, asc, eq, isNull, ne, schema, withOrgScope, outboxWriter } from '@taskflow/db';
import { between, errors, type BoardId, type ListId } from '@taskflow/contracts';
import { createEvent } from '@taskflow/events';
import { newId } from '@taskflow/security';
import { listArchived, listCreated, listReordered, listUpdated } from './events.js';
import { loadBoard } from './board.service.js';
import {
  ancestorsOfBoard,
  enforceOn,
  envelopeOf,
  orgOf,
  translatingConstraints,
  type WorkActor,
} from './shared.js';

/**
 * Lists — the columns of a board (PLAN.md §3.1).
 *
 * A card's list IS its status. There is deliberately no separate status column:
 * two representations of one fact drift, and the drift shows up as a card that
 * renders in "Done" while every filter still counts it as open.
 *
 * `wipLimit` is advisory. `moveCard` reports a breach and completes the move
 * anyway — see the note there, which is the interesting half of that decision.
 */

export interface ListSummary {
  readonly listId: string;
  readonly boardId: string;
  readonly name: string;
  readonly rank: string;
  readonly wipLimit: number | null;
  readonly cardCount: number;
}

export async function listLists(
  actor: WorkActor,
  input: { readonly boardId: BoardId },
): Promise<readonly ListSummary[]> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const board = await loadBoard(tx, input.boardId);
    enforceOn(actor, 'board:read', { type: 'board', id: input.boardId }, board, [
      { type: 'project', id: board.projectId },
    ]);

    const rows = await tx
      .select({
        listId: schema.lists.id,
        boardId: schema.lists.boardId,
        name: schema.lists.name,
        rank: schema.lists.rank,
        wipLimit: schema.lists.wipLimit,
      })
      .from(schema.lists)
      .where(
        and(
          eq(schema.lists.boardId, input.boardId),
          isNull(schema.lists.deletedAt),
          isNull(schema.lists.archivedAt),
        ),
      )
      .orderBy(asc(schema.lists.rank), asc(schema.lists.id));

    const cards = await tx
      .select({ listId: schema.cards.listId })
      .from(schema.cards)
      .where(
        and(
          eq(schema.cards.boardId, input.boardId),
          isNull(schema.cards.deletedAt),
          isNull(schema.cards.archivedAt),
        ),
      );

    const counts = new Map<string, number>();
    for (const card of cards) counts.set(card.listId, (counts.get(card.listId) ?? 0) + 1);

    return rows.map((row) => ({ ...row, cardCount: counts.get(row.listId) ?? 0 }));
  });
}

export async function createList(
  actor: WorkActor,
  input: {
    readonly boardId: BoardId;
    readonly name: string;
    readonly wipLimit: number | null;
  },
): Promise<{ readonly listId: ListId }> {
  const listId = newId<'ListId'>();
  const orgId = orgOf(actor);

  await translatingConstraints(
    async () =>
      withOrgScope(orgId, async (tx) => {
        const board = await loadBoard(tx, input.boardId);
        enforceOn(actor, 'board:update', { type: 'board', id: input.boardId }, board, [
          { type: 'project', id: board.projectId },
        ]);

        const existing = await tx
          .select({ rank: schema.lists.rank })
          .from(schema.lists)
          .where(and(eq(schema.lists.boardId, input.boardId), isNull(schema.lists.deletedAt)))
          .orderBy(asc(schema.lists.rank), asc(schema.lists.id));

        await tx.insert(schema.lists).values({
          id: listId,
          orgId,
          // From the BOARD row, not from the caller. The composite foreign key
          // would refuse a mismatch anyway; taking it from the row means the
          // refusal never has to happen.
          projectId: board.projectId,
          boardId: input.boardId,
          name: input.name,
          rank: between(existing.at(-1)?.rank ?? null, null),
          wipLimit: input.wipLimit,
        });

        await outboxWriter.append(tx, [
          createEvent(
            listCreated,
            { listId, boardId: input.boardId, name: input.name },
            envelopeOf(actor),
          ),
        ]);
      }),
    () => errors.conflict('That list already exists.'),
  );

  return { listId };
}

export async function updateList(
  actor: WorkActor,
  input: {
    readonly listId: ListId;
    readonly name: string;
    readonly wipLimit: number | null;
  },
): Promise<{ readonly name: string }> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const list = await loadList(tx, input.listId);

    enforceOn(
      actor,
      'board:update',
      { type: 'board', id: list.boardId },
      list,
      ancestorsOfBoard(list),
    );

    await tx
      .update(schema.lists)
      .set({ name: input.name, wipLimit: input.wipLimit, updatedAt: new Date() })
      .where(eq(schema.lists.id, input.listId));

    await outboxWriter.append(tx, [
      createEvent(
        listUpdated,
        {
          listId: input.listId,
          boardId: list.boardId,
          before: { name: list.name, wipLimit: list.wipLimit },
          after: { name: input.name, wipLimit: input.wipLimit },
        },
        envelopeOf(actor),
      ),
    ]);

    return { name: input.name };
  });
}

/**
 * Moves a list to a new position on its board.
 *
 * Takes NEIGHBOURS, never a rank or an index (§10.1). The server reads both
 * neighbours inside the transaction and derives the value between them, so a
 * client cannot compute a rank from a stale board and place a column somewhere
 * it no longer belongs.
 */
export async function reorderList(
  actor: WorkActor,
  input: {
    readonly listId: ListId;
    readonly beforeListId: ListId | null;
    readonly afterListId: ListId | null;
  },
): Promise<{ readonly rank: string }> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const list = await loadList(tx, input.listId);

    enforceOn(
      actor,
      'board:update',
      { type: 'board', id: list.boardId },
      list,
      ancestorsOfBoard(list),
    );

    const siblings = await tx
      .select({ listId: schema.lists.id, rank: schema.lists.rank })
      .from(schema.lists)
      .where(
        and(
          eq(schema.lists.boardId, list.boardId),
          ne(schema.lists.id, input.listId),
          isNull(schema.lists.deletedAt),
        ),
      );

    const rankOf = (id: ListId | null): string | null => {
      if (id === null) return null;
      const sibling = siblings.find((row) => row.listId === id);
      // A neighbour that is not on this board is a stale client, not a server
      // fault. 404 rather than a guess at where the user meant.
      if (!sibling) throw errors.notFound();
      return sibling.rank;
    };

    const rank = between(rankOf(input.beforeListId), rankOf(input.afterListId));

    await tx
      .update(schema.lists)
      .set({ rank, updatedAt: new Date() })
      .where(eq(schema.lists.id, input.listId));

    await outboxWriter.append(tx, [
      createEvent(
        listReordered,
        { listId: input.listId, boardId: list.boardId, fromRank: list.rank, toRank: rank },
        envelopeOf(actor),
      ),
    ]);

    return { rank };
  });
}

/**
 * Archives a list.
 *
 * Refuses while it still holds live cards. The alternative — cascading the
 * archive to every card — is an unbounded write behind one click, and worse, it
 * is not reversible: restoring the list cannot know which of its cards were
 * already archived beforehand. Making the caller empty it first keeps both the
 * write and the undo bounded.
 */
export async function archiveList(
  actor: WorkActor,
  input: { readonly listId: ListId },
): Promise<{ readonly archived: true }> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const list = await loadList(tx, input.listId);

    enforceOn(
      actor,
      'board:update',
      { type: 'board', id: list.boardId },
      list,
      ancestorsOfBoard(list),
    );

    const remaining = await tx
      .select({ id: schema.cards.id })
      .from(schema.cards)
      .where(
        and(
          eq(schema.cards.listId, input.listId),
          isNull(schema.cards.deletedAt),
          isNull(schema.cards.archivedAt),
        ),
      )
      .limit(1);

    if (remaining[0]) {
      throw errors.conflict('Move or archive the cards in this list before archiving it.');
    }

    await tx
      .update(schema.lists)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.lists.id, input.listId));

    await outboxWriter.append(tx, [
      createEvent(
        listArchived,
        { listId: input.listId, boardId: list.boardId, name: list.name },
        envelopeOf(actor),
      ),
    ]);

    return { archived: true as const };
  });
}

export interface ListRow {
  readonly orgId: string;
  readonly projectId: string;
  readonly boardId: string;
  readonly name: string;
  readonly rank: string;
  readonly wipLimit: number | null;
}

/** Loads a list by id, or 404s. Every caller enforces immediately afterwards. */
export async function loadList(
  tx: Parameters<Parameters<typeof withOrgScope>[1]>[0],
  listId: ListId,
): Promise<ListRow> {
  const rows = await tx
    .select({
      orgId: schema.lists.orgId,
      projectId: schema.lists.projectId,
      boardId: schema.lists.boardId,
      name: schema.lists.name,
      rank: schema.lists.rank,
      wipLimit: schema.lists.wipLimit,
    })
    .from(schema.lists)
    .where(and(eq(schema.lists.id, listId), isNull(schema.lists.deletedAt)))
    .limit(1);

  const list = rows[0];
  if (!list) throw errors.notFound();
  return list;
}
