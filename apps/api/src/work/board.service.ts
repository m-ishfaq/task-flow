import { and, asc, eq, isNull, schema, withOrgScope, outboxWriter } from '@taskflow/db';
import { between, errors, type BoardId, type ProjectId } from '@taskflow/contracts';
import { createEvent } from '@taskflow/events';
import { newId } from '@taskflow/security';
import { boardArchived, boardCreated, boardUpdated } from './events.js';
import { requireProject } from './project.service.js';
import {
  ancestorsOfBoard,
  enforceOn,
  envelopeOf,
  manageCapabilitiesFor,
  orgOf,
  translatingConstraints,
  type ManageCapabilities,
  type WorkActor,
} from './shared.js';

/**
 * Boards (PLAN.md §3.1, §10.1).
 *
 * A board is the kanban surface, and it is also the unit that per-resource
 * sharing is expressed against: `(user, viewer, board:xyz)` is the tuple that
 * §8.2 uses as its worked example, and `ancestorsOfCard` puts board FIRST so
 * that a grant here reaches every card on it.
 *
 * Boards are ordered within their project by the same fractional index as
 * cards, so the reasoning in §10.1 applies unchanged — including the part that
 * matters most: the API takes NEIGHBOURS and derives the rank, so two people
 * reordering at once converge instead of fighting over an index.
 */

export interface BoardSummary {
  readonly boardId: string;
  readonly projectId: string;
  readonly name: string;
  readonly rank: string;
  readonly archivedAt: Date | null;
  /**
   * Per-BOARD, not inherited from the project's own capabilities — a share
   * grant (`share-board.tsx`) can give a Member `board:update` on one board
   * with no project-wide access at all, and `nearestApplicable` picking the
   * board-level tuple over any project-level one is the whole point of the
   * ancestor hierarchy (`ancestorsOfBoard`). Approximating this from the
   * project's flag would hide a control that board's own tuple grants.
   */
  readonly capabilities: ManageCapabilities;
}

export async function listBoards(
  actor: WorkActor,
  input: { readonly projectId: ProjectId; readonly includeArchived: boolean },
): Promise<readonly BoardSummary[]> {
  return withOrgScope(orgOf(actor), async (tx) => {
    // Establishes that the project is reachable before its contents are listed.
    // Without it, an unreachable project id would return an empty array, which
    // reads as "no boards" rather than "not yours".
    await requireProject(tx, actor, input.projectId, 'project:read');

    const rows = await tx
      .select({
        boardId: schema.boards.id,
        projectId: schema.boards.projectId,
        name: schema.boards.name,
        rank: schema.boards.rank,
        archivedAt: schema.boards.archivedAt,
      })
      .from(schema.boards)
      .where(
        input.includeArchived
          ? and(eq(schema.boards.projectId, input.projectId), isNull(schema.boards.deletedAt))
          : and(
              eq(schema.boards.projectId, input.projectId),
              isNull(schema.boards.deletedAt),
              isNull(schema.boards.archivedAt),
            ),
      )
      // The (rank, id) tiebreak from §10.1. Equal ranks are legal and this is
      // what keeps two clients rendering them in the same order.
      .orderBy(asc(schema.boards.rank), asc(schema.boards.id));

    const orgId = orgOf(actor);
    return rows.map((row) => ({
      ...row,
      capabilities: manageCapabilitiesFor(
        actor.subject,
        { update: 'board:update', delete: 'board:delete' },
        { type: 'board', id: row.boardId },
        { orgId },
        ancestorsOfBoard(row),
      ),
    }));
  });
}

export async function createBoard(
  actor: WorkActor,
  input: { readonly projectId: ProjectId; readonly name: string },
): Promise<{ readonly boardId: BoardId }> {
  const boardId = newId<'BoardId'>();
  const orgId = orgOf(actor);

  await translatingConstraints(
    async () =>
      withOrgScope(orgId, async (tx) => {
        // `project:update` rather than `project:read`: adding a board changes
        // the project, and a caller who may only read it may not.
        await requireProject(tx, actor, input.projectId, 'project:update');

        const last = await tx
          .select({ rank: schema.boards.rank })
          .from(schema.boards)
          .where(and(eq(schema.boards.projectId, input.projectId), isNull(schema.boards.deletedAt)))
          .orderBy(asc(schema.boards.rank), asc(schema.boards.id));

        const lastRank = last.at(-1)?.rank ?? null;

        await tx.insert(schema.boards).values({
          id: boardId,
          orgId,
          projectId: input.projectId,
          name: input.name,
          rank: between(lastRank, null),
          createdBy: actor.subject.userId,
        });

        await outboxWriter.append(tx, [
          createEvent(
            boardCreated,
            { boardId, projectId: input.projectId, name: input.name },
            envelopeOf(actor),
          ),
        ]);
      }),
    () => errors.conflict('That board already exists.'),
  );

  return { boardId };
}

export async function updateBoard(
  actor: WorkActor,
  input: { readonly boardId: BoardId; readonly name: string },
): Promise<{ readonly name: string }> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const board = await loadBoard(tx, input.boardId);

    enforceOn(
      actor,
      'board:update',
      { type: 'board', id: input.boardId },
      board,
      ancestorsOfBoard(board),
    );

    await tx
      .update(schema.boards)
      .set({ name: input.name, updatedAt: new Date() })
      .where(eq(schema.boards.id, input.boardId));

    await outboxWriter.append(tx, [
      createEvent(
        boardUpdated,
        { boardId: input.boardId, before: { name: board.name }, after: { name: input.name } },
        envelopeOf(actor),
      ),
    ]);

    return { name: input.name };
  });
}

export async function archiveBoard(
  actor: WorkActor,
  input: { readonly boardId: BoardId; readonly archived: boolean },
): Promise<{ readonly archived: boolean }> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const board = await loadBoard(tx, input.boardId);

    enforceOn(
      actor,
      'board:delete',
      { type: 'board', id: input.boardId },
      board,
      ancestorsOfBoard(board),
    );

    await tx
      .update(schema.boards)
      .set({ archivedAt: input.archived ? new Date() : null, updatedAt: new Date() })
      .where(eq(schema.boards.id, input.boardId));

    await outboxWriter.append(tx, [
      createEvent(
        boardArchived,
        { boardId: input.boardId, name: board.name, restored: !input.archived },
        envelopeOf(actor),
      ),
    ]);

    return { archived: input.archived };
  });
}

export interface BoardRow {
  readonly orgId: string;
  readonly projectId: string;
  readonly name: string;
}

/**
 * Loads a board by id, or 404s.
 *
 * Not exported with an authorization check built in, because the permission
 * differs by caller — reading a board needs `board:read`, adding a list to it
 * needs `board:update`. Every caller here enforces immediately after loading,
 * and a caller that did not would be visible as a `loadBoard` with no
 * `enforceOn` beneath it.
 */
export async function loadBoard(
  tx: Parameters<Parameters<typeof withOrgScope>[1]>[0],
  boardId: BoardId,
): Promise<BoardRow> {
  const rows = await tx
    .select({
      orgId: schema.boards.orgId,
      projectId: schema.boards.projectId,
      name: schema.boards.name,
    })
    .from(schema.boards)
    .where(and(eq(schema.boards.id, boardId), isNull(schema.boards.deletedAt)))
    .limit(1);

  const board = rows[0];
  if (!board) throw errors.notFound();
  return board;
}
