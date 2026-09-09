import { and, eq, isNull, schema, withOrgScope, outboxWriter } from '@taskflow/db';
import { errors, type ProjectId } from '@taskflow/contracts';
import { createEvent } from '@taskflow/events';
import { can } from '@taskflow/policy';
import { newId } from '@taskflow/security';
import { projectArchived, projectCreated, projectUpdated } from './events.js';
import {
  enforceOn,
  envelopeOf,
  manageCapabilitiesFor,
  orgOf,
  translatingConstraints,
  type ManageCapabilities,
  type WorkActor,
} from './shared.js';

/**
 * Projects (PLAN.md §3.1, §7.2).
 *
 * A project owns a card-number namespace — the `WEB` in `WEB-142` — which is
 * the only thing that makes it more than a folder. That namespace is why
 * `key` is immutable here: it appears in card URLs, in chat messages, and in
 * commit messages, so changing it would silently break every reference anyone
 * ever pasted. Renaming a project key is a migration, not an edit, and is
 * deliberately not offered.
 */

export interface ProjectSummary {
  readonly projectId: string;
  readonly name: string;
  readonly key: string;
  readonly description: string | null;
  readonly archivedAt: Date | null;
  readonly boardCount: number;
  /**
   * `update` covers rename, labels, statuses, custom fields, sprints, card
   * import, AND creating a board — `board.service.ts`'s `createBoard` enforces
   * `project:update` on the PARENT project, not `board:create` on anything
   * (the route floor names `board:create` only as the coarse pre-check;
   * `requireProject(..., 'project:update')` is what actually decides it), so
   * this one flag is genuinely what gates the "+Board" control too.
   */
  readonly capabilities: ManageCapabilities;
}

/**
 * Every live project in the organization the caller may actually see.
 *
 * No `org_id` in the WHERE clause — RLS enforces it (guardrail 2). The filter
 * that IS here excludes soft-deleted rows, which RLS knows nothing about.
 *
 * A per-row `can()` filter, NOT a bare return — the identical fix
 * `docs/space.service.ts`'s `listSpaces` already applies, for the identical
 * reason. `route({ permission: 'project:read' })`'s floor is `couldGrant`,
 * which passes on a relationship tuple as well as on a role — and `member`'s
 * grant set covers every `:read` permission in the catalog by action suffix.
 * So a Guest holding a `member` tuple on one chat channel (every user who
 * joins a channel holds one) cleared the floor and received every project's
 * name and key in the org, having no Work relationship of any kind. Every
 * non-guest role holds `project:read` flatly by role, which is why this was
 * invisible until a Guest could hold a Work-scoped tuple at all.
 *
 * A bounded loop over the org's projects, deliberately not a join — the same
 * shape and the same reasoning as `search/router.ts`'s per-hit check and
 * `listSpaces`'s own. Projects are org furniture and there are tens of them,
 * not thousands.
 */
export async function listProjects(
  actor: WorkActor,
  input: { readonly includeArchived: boolean },
): Promise<readonly ProjectSummary[]> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const rows = await tx
      .select({
        projectId: schema.projects.id,
        name: schema.projects.name,
        key: schema.projects.key,
        description: schema.projects.description,
        archivedAt: schema.projects.archivedAt,
      })
      .from(schema.projects)
      .where(
        input.includeArchived
          ? isNull(schema.projects.deletedAt)
          : and(isNull(schema.projects.deletedAt), isNull(schema.projects.archivedAt)),
      )
      .orderBy(schema.projects.name);

    const boards = await tx
      .select({ projectId: schema.boards.projectId })
      .from(schema.boards)
      .where(and(isNull(schema.boards.deletedAt), isNull(schema.boards.archivedAt)));

    const counts = new Map<string, number>();
    for (const board of boards) {
      counts.set(board.projectId, (counts.get(board.projectId) ?? 0) + 1);
    }

    const orgId = orgOf(actor);
    return rows
      .filter(
        (row) =>
          can(actor.subject, 'project:read', {
            orgId,
            resource: { type: 'project', id: row.projectId },
            ancestors: [],
          }).allowed,
      )
      .map((row) => ({
        ...row,
        boardCount: counts.get(row.projectId) ?? 0,
        capabilities: manageCapabilitiesFor(
          actor.subject,
          { update: 'project:update', delete: 'project:delete' },
          { type: 'project', id: row.projectId },
          { orgId },
          [],
        ),
      }));
  });
}

export async function createProject(
  actor: WorkActor,
  input: {
    readonly name: string;
    readonly key: string;
    readonly description: string | null;
  },
): Promise<{ readonly projectId: ProjectId; readonly key: string }> {
  const projectId = newId<'ProjectId'>();
  const orgId = orgOf(actor);

  await translatingConstraints(
    async () =>
      withOrgScope(orgId, async (tx) => {
        await tx.insert(schema.projects).values({
          id: projectId,
          orgId,
          name: input.name,
          key: input.key,
          description: input.description,
          createdBy: actor.subject.userId,
        });

        await outboxWriter.append(tx, [
          createEvent(
            projectCreated,
            { projectId, name: input.name, key: input.key },
            envelopeOf(actor),
          ),
        ]);
      }),
    // Per-org, not global: two tenants both wanting `WEB` is the normal case.
    () => errors.conflict('A project with that key already exists.'),
  );

  return { projectId, key: input.key };
}

export async function updateProject(
  actor: WorkActor,
  input: {
    readonly projectId: ProjectId;
    readonly name: string;
    readonly description: string | null;
  },
): Promise<{ readonly name: string }> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const rows = await tx
      .select({
        orgId: schema.projects.orgId,
        name: schema.projects.name,
        description: schema.projects.description,
      })
      .from(schema.projects)
      .where(and(eq(schema.projects.id, input.projectId), isNull(schema.projects.deletedAt)))
      .limit(1);

    const before = rows[0];
    if (!before) throw errors.notFound();

    /* Layer 2. The route already established that this ROLE may update projects
       in general; this establishes that this SUBJECT may update THIS one, which
       is where a restrictive tuple on the project takes the capability back. */
    enforceOn(
      actor,
      'project:update',
      { type: 'project', id: input.projectId },
      before,
      // A project has no ancestor — it is the top of the Work hierarchy.
      [],
    );

    await tx
      .update(schema.projects)
      .set({ name: input.name, description: input.description, updatedAt: new Date() })
      .where(eq(schema.projects.id, input.projectId));

    await outboxWriter.append(tx, [
      createEvent(
        projectUpdated,
        {
          projectId: input.projectId,
          before: { name: before.name, description: before.description },
          after: { name: input.name, description: input.description },
        },
        envelopeOf(actor),
      ),
    ]);

    return { name: input.name };
  });
}

/**
 * Archives or restores a project.
 *
 * One method for both directions, taking the target state rather than the
 * transition. Two methods would need the caller to know the current state to
 * pick one, and would answer a double-archive with an error for something that
 * is already true.
 *
 * Archiving does NOT cascade to boards and cards. They stay exactly as they
 * are, so restoring gives back what was archived rather than a project whose
 * contents were quietly rewritten — and so the cascade cannot become an
 * unbounded write triggered by one click.
 */
export async function archiveProject(
  actor: WorkActor,
  input: { readonly projectId: ProjectId; readonly archived: boolean },
): Promise<{ readonly archived: boolean }> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const rows = await tx
      .select({
        orgId: schema.projects.orgId,
        name: schema.projects.name,
        archivedAt: schema.projects.archivedAt,
      })
      .from(schema.projects)
      .where(and(eq(schema.projects.id, input.projectId), isNull(schema.projects.deletedAt)))
      .limit(1);

    const project = rows[0];
    if (!project) throw errors.notFound();

    /* `project:delete`, not `project:update`. Archiving is what this product
       offers instead of deletion (§7.1), so it is gated as the destructive
       action a user experiences it as — Owner and Admin only. */
    enforceOn(actor, 'project:delete', { type: 'project', id: input.projectId }, project, []);

    await tx
      .update(schema.projects)
      .set({ archivedAt: input.archived ? new Date() : null, updatedAt: new Date() })
      .where(eq(schema.projects.id, input.projectId));

    await outboxWriter.append(tx, [
      createEvent(
        projectArchived,
        { projectId: input.projectId, name: project.name, restored: !input.archived },
        envelopeOf(actor),
      ),
    ]);

    return { archived: input.archived };
  });
}

/**
 * Loads a project for a caller who named it, or 404s.
 *
 * Shared by the board service, which has to establish that the project exists
 * and is reachable before creating anything inside it. Exported from here
 * rather than duplicated so "reachable" has one definition.
 */
export async function requireProject(
  tx: Parameters<Parameters<typeof withOrgScope>[1]>[0],
  actor: WorkActor,
  projectId: ProjectId,
  permission: 'project:read' | 'project:update',
): Promise<{ readonly orgId: string; readonly name: string; readonly key: string }> {
  const rows = await tx
    .select({ orgId: schema.projects.orgId, name: schema.projects.name, key: schema.projects.key })
    .from(schema.projects)
    .where(and(eq(schema.projects.id, projectId), isNull(schema.projects.deletedAt)))
    .limit(1);

  const project = rows[0];
  if (!project) throw errors.notFound();

  enforceOn(actor, permission, { type: 'project', id: projectId }, project, []);
  return project;
}
