import { and, asc, eq, or, schema, withOrgScope, outboxWriter } from '@taskflow/db';
import { errors, type BoardId, type ViewId } from '@taskflow/contracts';
import { createEvent } from '@taskflow/events';
import { newId } from '@taskflow/security';
import { FilterTree, validate, type FilterNode } from '@taskflow/filter';
import { viewCreated, viewDeleted, viewUpdated } from './events.js';
import { loadBoard } from './board.service.js';
import {
  enforceOn,
  envelopeOf,
  orgOf,
  translatingConstraints,
  userOf,
  type WorkActor,
} from './shared.js';

/**
 * Saved views (`ai/phase-3.5-work-ux.md` §6).
 *
 * A named, stored arrangement of one board. Three things about this file are
 * worth understanding before changing it.
 *
 * ## 1. Two audiences, two permissions, one route
 *
 * A PRIVATE view is a personal bookmark: it changes nothing anyone else sees,
 * so `board:read` — the permission to look at the board at all — is enough to
 * keep one. A SHARED view is part of the board's furniture for every reader,
 * so it is `board:update`, the same permission that adds a column.
 *
 * The route declares the floor (`board:read`) and `enforceSharing` below adds
 * the second check when, and only when, `isShared` is true. That is the same
 * shape as `moveCard` authorizing its DESTINATION separately: not a permission
 * checked twice, but a second, different question about a different thing.
 * Collapsing them either stops members keeping private views or lets any
 * reader rewrite the board's shared tabs.
 *
 * ## 2. `@me` is stored unresolved, and that is the point
 *
 * The filter is persisted as the AST `packages/filter` defines, with `@me`
 * symbolic. Resolving it at save time would make a shared "assigned to me"
 * view mean "assigned to whoever saved it" (§10.2) — the one thing a shared
 * view of that shape must not mean. Compilation substitutes the caller.
 *
 * ## 3. The stored tree is re-parsed on READ, never trusted
 *
 * `filter` is a jsonb column, and a column is not a parser. A tree written by
 * an older build, or edited by hand, would otherwise reach `compile()` — which
 * refuses unknown fields, so it could not become SQL, but it would surface as
 * a 500 from the board rather than as one broken view. `parseStoredFilter`
 * turns that into a view the caller is told is broken, with the rest of the
 * board's views still listed.
 */

/**
 * The three closed vocabularies, mirroring migration 0014's CHECK constraints.
 *
 * Narrowed with a cast on read, exactly as `card.service.ts` narrows
 * `priority`: the column is text and the CHECK is what actually limits it, so
 * the type here restates a guarantee the database is already enforcing rather
 * than adding one.
 */
export type ViewType = 'board' | 'table' | 'list';
export type ViewGroupBy = 'list' | 'status' | 'assignee' | 'priority' | 'due';
export type ViewSortBy = 'rank' | 'title' | 'due' | 'priority' | 'created';

export interface ViewSummary {
  readonly viewId: string;
  readonly boardId: string;
  readonly name: string;
  readonly type: ViewType;
  readonly groupBy: ViewGroupBy | null;
  readonly sortBy: ViewSortBy | null;
  readonly filter: FilterNode | null;
  readonly visibleColumns: readonly string[] | null;
  readonly isShared: boolean;
  readonly createdBy: string;
  readonly position: number;
  /** True when the stored tree no longer parses — see §3 in the file header. */
  readonly filterBroken: boolean;
}

interface ViewInput {
  readonly name: string;
  readonly type: string;
  readonly groupBy: string | null;
  readonly sortBy: string | null;
  readonly filter: FilterNode | null;
  readonly visibleColumns: readonly string[] | null;
  readonly isShared: boolean;
}

/**
 * Every view the caller may see on a board: all shared ones, plus their own
 * private ones.
 *
 * The `created_by` half of the OR is what makes private mean private. RLS
 * answers the TENANT question and has nothing to say here — two members of one
 * org are on the same side of that boundary.
 */
export async function listViews(
  actor: WorkActor,
  input: { readonly boardId: BoardId },
): Promise<readonly ViewSummary[]> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const board = await loadBoard(tx, input.boardId);
    enforceOn(actor, 'board:read', { type: 'board', id: input.boardId }, board, [
      { type: 'project', id: board.projectId },
    ]);

    const rows = await tx
      .select({
        viewId: schema.views.id,
        boardId: schema.views.boardId,
        name: schema.views.name,
        type: schema.views.type,
        groupBy: schema.views.groupBy,
        sortBy: schema.views.sortBy,
        filter: schema.views.filter,
        visibleColumns: schema.views.visibleColumns,
        isShared: schema.views.isShared,
        createdBy: schema.views.createdBy,
        position: schema.views.position,
      })
      .from(schema.views)
      .where(
        and(
          eq(schema.views.boardId, input.boardId),
          or(eq(schema.views.isShared, true), eq(schema.views.createdBy, userOf(actor))),
        ),
      )
      .orderBy(asc(schema.views.position), asc(schema.views.id));

    return rows.map((row) => {
      const parsed = parseStoredFilter(row.filter);
      return {
        ...row,
        // Narrowed, not validated — the CHECK constraints are the enforcement.
        type: row.type as ViewType,
        groupBy: row.groupBy as ViewGroupBy | null,
        sortBy: row.sortBy as ViewSortBy | null,
        filter: parsed.filter,
        filterBroken: parsed.broken,
        visibleColumns: parseStoredColumns(row.visibleColumns),
      };
    });
  });
}

export async function createView(
  actor: WorkActor,
  input: ViewInput & { readonly boardId: BoardId },
): Promise<{ readonly viewId: ViewId }> {
  const viewId = newId<'ViewId'>();
  const orgId = orgOf(actor);

  await translatingConstraints(
    async () =>
      withOrgScope(orgId, async (tx) => {
        const board = await loadBoard(tx, input.boardId);
        enforceOn(actor, 'board:read', { type: 'board', id: input.boardId }, board, [
          { type: 'project', id: board.projectId },
        ]);
        enforceSharing(actor, input.isShared, input.boardId, board);
        assertFilterUsable(input.filter);

        /* Appended, not inserted. `position` is a plain integer and the tabs
           are reordered explicitly; taking max+1 inside the transaction keeps
           two people saving a view at once from both claiming the same slot. */
        const siblings = await tx
          .select({ position: schema.views.position })
          .from(schema.views)
          .where(eq(schema.views.boardId, input.boardId))
          .orderBy(asc(schema.views.position));

        await tx.insert(schema.views).values({
          id: viewId,
          orgId,
          // From the BOARD row, not the caller — the composite FK would refuse
          // a mismatch anyway, and taking it from the row means it never has to.
          projectId: board.projectId,
          boardId: input.boardId,
          name: input.name,
          type: input.type,
          groupBy: input.groupBy,
          sortBy: input.sortBy,
          filter: input.filter,
          visibleColumns: input.visibleColumns === null ? null : [...input.visibleColumns],
          isShared: input.isShared,
          createdBy: userOf(actor),
          position: (siblings.at(-1)?.position ?? -1) + 1,
        });

        await outboxWriter.append(tx, [
          createEvent(
            viewCreated,
            {
              viewId,
              boardId: input.boardId,
              name: input.name,
              type: input.type,
              shared: input.isShared,
            },
            envelopeOf(actor),
          ),
        ]);
      }),
    () => errors.conflict('A view with that name already exists on this board.'),
  );

  return { viewId };
}

export async function updateView(
  actor: WorkActor,
  input: ViewInput & { readonly viewId: ViewId },
): Promise<{ readonly name: string }> {
  const orgId = orgOf(actor);

  await translatingConstraints(
    async () =>
      withOrgScope(orgId, async (tx) => {
        const view = await loadView(tx, input.viewId);
        const board = await loadBoard(tx, view.boardId as BoardId);

        enforceOn(actor, 'board:read', { type: 'board', id: view.boardId }, board, [
          { type: 'project', id: board.projectId },
        ]);
        enforceEditable(actor, view, board, view.boardId);

        /* Sharing a previously private view is a `board:update` act — it puts
           the view in front of everyone — so the NEW value is what is checked,
           not the stored one. Un-sharing is the same act in reverse: it removes
           a tab other people are using. */
        if (view.isShared !== input.isShared) {
          enforceSharing(actor, true, view.boardId, board);
        }

        assertFilterUsable(input.filter);

        await tx
          .update(schema.views)
          .set({
            name: input.name,
            type: input.type,
            groupBy: input.groupBy,
            sortBy: input.sortBy,
            filter: input.filter,
            visibleColumns: input.visibleColumns === null ? null : [...input.visibleColumns],
            isShared: input.isShared,
            updatedAt: new Date(),
          })
          .where(eq(schema.views.id, input.viewId));

        await outboxWriter.append(tx, [
          createEvent(
            viewUpdated,
            {
              viewId: input.viewId,
              boardId: view.boardId,
              name: input.name,
              shared: input.isShared,
            },
            envelopeOf(actor),
          ),
        ]);
      }),
    () => errors.conflict('A view with that name already exists on this board.'),
  );

  return { name: input.name };
}

export async function deleteView(
  actor: WorkActor,
  input: { readonly viewId: ViewId },
): Promise<{ readonly deleted: true }> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const view = await loadView(tx, input.viewId);
    const board = await loadBoard(tx, view.boardId as BoardId);

    enforceOn(actor, 'board:read', { type: 'board', id: view.boardId }, board, [
      { type: 'project', id: board.projectId },
    ]);
    enforceEditable(actor, view, board, view.boardId);

    /* A real delete, not an archive. A view holds no work — it is a saved
       question about work that already exists elsewhere — so there is nothing
       to preserve and nothing a restore would recover that re-saving would
       not. Same reasoning as labels and statuses. */
    await tx.delete(schema.views).where(eq(schema.views.id, input.viewId));

    await outboxWriter.append(tx, [
      createEvent(
        viewDeleted,
        { viewId: input.viewId, boardId: view.boardId, name: view.name, shared: view.isShared },
        envelopeOf(actor),
      ),
    ]);

    return { deleted: true as const };
  });
}

/* -------------------------------------------------------------------------- */

interface ViewRow {
  readonly boardId: string;
  readonly name: string;
  readonly isShared: boolean;
  readonly createdBy: string;
}

/**
 * What `enforceOn` needs of the resource row: `orgId` as well as `projectId`.
 *
 * `orgId` is not decoration — the policy engine compares it against the
 * subject's org, which is the check that makes a resource loaded under one
 * tenant unusable as evidence about another.
 */
interface BoardForAuthz {
  readonly orgId: string;
  readonly projectId: string;
}

async function loadView(
  tx: Parameters<Parameters<typeof withOrgScope>[1]>[0],
  viewId: ViewId,
): Promise<ViewRow> {
  const rows = await tx
    .select({
      boardId: schema.views.boardId,
      name: schema.views.name,
      isShared: schema.views.isShared,
      createdBy: schema.views.createdBy,
    })
    .from(schema.views)
    .where(eq(schema.views.id, viewId))
    .limit(1);

  const view = rows[0];
  if (!view) throw errors.notFound();
  return view;
}

/** The `board:update` half — see §1 in the file header. */
function enforceSharing(
  actor: WorkActor,
  isShared: boolean,
  boardId: string,
  board: BoardForAuthz,
): void {
  if (!isShared) return;
  enforceOn(actor, 'board:update', { type: 'board', id: boardId }, board, [
    { type: 'project', id: board.projectId },
  ]);
}

/**
 * Who may change an existing view.
 *
 * A private view is AUTHOR-ONLY with no permission override, for the same
 * reason comment editing is (CLAUDE.md, card detail): a personal bookmark an
 * administrator can silently rewrite is not personal. A shared view is
 * `board:update`, because it is part of the board.
 */
function enforceEditable(
  actor: WorkActor,
  view: ViewRow,
  board: BoardForAuthz,
  boardId: string,
): void {
  if (view.isShared) {
    enforceOn(actor, 'board:update', { type: 'board', id: boardId }, board, [
      { type: 'project', id: board.projectId },
    ]);
    return;
  }

  // NOT_FOUND rather than FORBIDDEN: another person's private view is one the
  // caller should not learn the existence of (§8.7).
  if (view.createdBy !== userOf(actor)) throw errors.notFound();
}

/**
 * Re-parses a stored filter tree.
 *
 * Returns `broken` rather than throwing so one unreadable view does not take
 * the whole list down with it — the board still renders its other tabs, and
 * the bad one is reported as bad instead of as an outage.
 */
function parseStoredFilter(stored: unknown): {
  readonly filter: FilterNode | null;
  readonly broken: boolean;
} {
  if (stored === null || stored === undefined) return { filter: null, broken: false };

  const parsed = FilterTree.safeParse(stored);
  if (!parsed.success) return { filter: null, broken: true };

  /* BOTH checks, and they are not the same check twice. `FilterTree` validates
     SHAPE and cannot validate MEANING — it does not know the tree is filtering
     cards, so it accepts `field: 'assignedTo'` as readily as `field:
     'assignee'` (validate.ts says so in its own header). A field removed in a
     later build leaves a structurally perfect tree that names nothing, and
     stopping at the Zod parse would call that view healthy right up until the
     board tried to compile it. */
  return validate('card', parsed.data).ok
    ? { filter: parsed.data, broken: false }
    : { filter: null, broken: true };
}

/**
 * Refuses a filter that would be stored only to read back broken.
 *
 * The route parses against `FilterTree`, which is shape-only for the reason
 * above — so without this a caller could save a view naming a field that does
 * not exist, get a 200, and find it permanently marked broken. Failing at the
 * write is the honest moment: the author is still looking at the filter they
 * built.
 */
function assertFilterUsable(filter: FilterNode | null): void {
  if (filter === null) return;

  const result = validate('card', filter);
  if (result.ok) return;

  throw errors.validation(
    { filter: result.errors.map((error) => error.message) },
    'That filter is not valid for cards.',
  );
}

/** Same argument as `parseStoredFilter`, for the table view's column selection. */
function parseStoredColumns(stored: unknown): readonly string[] | null {
  if (!Array.isArray(stored)) return null;

  const columns: string[] = [];
  for (const entry of stored) {
    /* All or nothing. Keeping the strings out of a partly-corrupt array would
       silently drop a column the author had selected, and a table quietly
       missing one column is harder to notice than one that fell back to its
       defaults. */
    if (typeof entry !== 'string') return null;
    columns.push(entry);
  }
  return columns;
}
