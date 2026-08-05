import { and, desc, eq, isNull, schema, withOrgScope, outboxWriter } from '@taskflow/db';
import { errors, type ProjectId, type StatusCategory, type StatusId } from '@taskflow/contracts';
import { createEvent } from '@taskflow/events';
import { newId } from '@taskflow/security';
import { statusCreated, statusDeleted, statusUpdated } from './events.js';
import { requireProject } from './project.service.js';
import { envelopeOf, orgOf, translatingConstraints, type WorkActor } from './shared.js';

/**
 * Statuses (`ai/phase-3.5-work-ux.md` §5) — a card's grouping and done-ness,
 * independent of `listId`.
 *
 * Same authorization split as labels and custom fields, and for the same
 * reason (CLAUDE.md, card detail notes): managing the status SET is editing
 * the project's vocabulary and needs `project:update`. There is no
 * "setting a card's status" mutation here — that is `cards.update`, in
 * `card.service.ts`, gated `card:update`, exactly like priority and every
 * other per-card field.
 */

export interface StatusSummary {
  readonly statusId: string;
  readonly projectId: string;
  readonly name: string;
  readonly category: StatusCategory;
  readonly color: string;
  readonly position: number;
  readonly isDefault: boolean;
  readonly cardCount: number;
}

export async function listStatuses(
  actor: WorkActor,
  input: { readonly projectId: ProjectId },
): Promise<readonly StatusSummary[]> {
  return withOrgScope(orgOf(actor), async (tx) => {
    await requireProject(tx, actor, input.projectId, 'project:read');

    const rows = await tx
      .select({
        statusId: schema.statuses.id,
        projectId: schema.statuses.projectId,
        name: schema.statuses.name,
        category: schema.statuses.category,
        color: schema.statuses.color,
        position: schema.statuses.position,
        isDefault: schema.statuses.isDefault,
      })
      .from(schema.statuses)
      .where(eq(schema.statuses.projectId, input.projectId))
      .orderBy(schema.statuses.position, schema.statuses.id);

    const used = await tx
      .select({ statusId: schema.cards.statusId })
      .from(schema.cards)
      .where(and(eq(schema.cards.projectId, input.projectId), isNull(schema.cards.deletedAt)));

    const counts = new Map<string, number>();
    for (const row of used) {
      if (row.statusId === null) continue;
      counts.set(row.statusId, (counts.get(row.statusId) ?? 0) + 1);
    }

    return rows.map((row) => ({
      ...row,
      category: row.category as StatusCategory,
      cardCount: counts.get(row.statusId) ?? 0,
    }));
  });
}

export async function createStatus(
  actor: WorkActor,
  input: {
    readonly projectId: ProjectId;
    readonly name: string;
    readonly category: StatusCategory;
    readonly color: string;
    readonly isDefault: boolean;
  },
): Promise<{ readonly statusId: StatusId }> {
  const statusId = newId<'StatusId'>();
  const orgId = orgOf(actor);

  await translatingConstraints(
    async () =>
      withOrgScope(orgId, async (tx) => {
        await requireProject(tx, actor, input.projectId, 'project:update');

        const existing = await tx
          .select({ position: schema.statuses.position })
          .from(schema.statuses)
          .where(eq(schema.statuses.projectId, input.projectId))
          .orderBy(desc(schema.statuses.position))
          .limit(1);

        const position = (existing[0]?.position ?? 0) + 1;

        /* Cleared inline rather than through a shared helper: guardrail 11
           checks that a mutation in a `*.service.ts` file is paired with the
           event ITS OWN function emits, and a separate helper's `UPDATE`
           would be a mutation this function's `statusCreated` does not
           obviously cover. The clear and the insert are one fact — "this
           status is now the default" — so one event describing the row
           being created is the correct and only event for both. */
        if (input.isDefault) {
          await tx
            .update(schema.statuses)
            .set({ isDefault: false })
            .where(
              and(
                eq(schema.statuses.projectId, input.projectId),
                eq(schema.statuses.isDefault, true),
              ),
            );
        }

        await tx.insert(schema.statuses).values({
          id: statusId,
          orgId,
          projectId: input.projectId,
          name: input.name,
          category: input.category,
          color: input.color,
          position,
          isDefault: input.isDefault,
        });

        await outboxWriter.append(tx, [
          createEvent(
            statusCreated,
            { statusId, projectId: input.projectId, name: input.name, category: input.category },
            envelopeOf(actor),
          ),
        ]);
      }),
    // The unique index is on lower(name): "Done" and "done" are the same
    // status, and two of them would give a board two columns for one concept.
    () => errors.conflict('A status with that name already exists in this project.'),
  );

  return { statusId };
}

export async function updateStatus(
  actor: WorkActor,
  input: {
    readonly statusId: StatusId;
    readonly name: string;
    readonly category: StatusCategory;
    readonly color: string;
    readonly isDefault: boolean;
  },
): Promise<{ readonly name: string }> {
  const orgId = orgOf(actor);

  return translatingConstraints(
    async () =>
      withOrgScope(orgId, async (tx) => {
        const status = await loadStatus(tx, input.statusId);
        await requireProject(tx, actor, status.projectId as ProjectId, 'project:update');

        /* Cleared BEFORE this row is written, and only when this row is about
           to become the default. Writing both in the other order would trip
           `statuses_project_default_key` — the partial unique index allows
           at most one TRUE per project, and for one transaction that briefly
           has two, the index does not know which one is "about to stop being
           true". Inline for the same guardrail-11 reason as `createStatus`:
           the clear and the update below are one fact, covered by the one
           `statusUpdated` event this function already emits. */
        if (input.isDefault && !status.isDefault) {
          await tx
            .update(schema.statuses)
            .set({ isDefault: false })
            .where(
              and(
                eq(schema.statuses.projectId, status.projectId),
                eq(schema.statuses.isDefault, true),
              ),
            );
        }

        await tx
          .update(schema.statuses)
          .set({
            name: input.name,
            category: input.category,
            color: input.color,
            isDefault: input.isDefault,
          })
          .where(eq(schema.statuses.id, input.statusId));

        await outboxWriter.append(tx, [
          createEvent(
            statusUpdated,
            {
              statusId: input.statusId,
              projectId: status.projectId,
              before: {
                name: status.name,
                category: status.category,
                color: status.color,
                isDefault: status.isDefault,
              },
              after: {
                name: input.name,
                category: input.category,
                color: input.color,
                isDefault: input.isDefault,
              },
            },
            envelopeOf(actor),
          ),
        ]);

        return { name: input.name };
      }),
    () => errors.conflict('A status with that name already exists in this project.'),
  );
}

/**
 * Deletes a status, un-classifying every card that carried it.
 *
 * A real delete, not an archive — same reasoning as `deleteLabel`. The
 * migration's `ON DELETE SET NULL (status_id)` does the un-classifying; this
 * function only has to count the cards affected before the delete runs, since
 * afterwards there is nothing left to count them by.
 */
export async function deleteStatus(
  actor: WorkActor,
  input: { readonly statusId: StatusId },
): Promise<{ readonly deleted: true; readonly cardCount: number }> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const status = await loadStatus(tx, input.statusId);
    await requireProject(tx, actor, status.projectId as ProjectId, 'project:update');

    const attached = await tx
      .select({ cardId: schema.cards.id })
      .from(schema.cards)
      .where(and(eq(schema.cards.statusId, input.statusId), isNull(schema.cards.deletedAt)));

    await tx.delete(schema.statuses).where(eq(schema.statuses.id, input.statusId));

    await outboxWriter.append(tx, [
      createEvent(
        statusDeleted,
        {
          statusId: input.statusId,
          projectId: status.projectId,
          name: status.name,
          cardCount: attached.length,
        },
        envelopeOf(actor),
      ),
    ]);

    return { deleted: true as const, cardCount: attached.length };
  });
}

interface StatusRow {
  readonly orgId: string;
  readonly projectId: string;
  readonly name: string;
  readonly category: string;
  readonly color: string;
  readonly isDefault: boolean;
}

async function loadStatus(
  tx: Parameters<Parameters<typeof withOrgScope>[1]>[0],
  statusId: StatusId,
): Promise<StatusRow> {
  const rows = await tx
    .select({
      orgId: schema.statuses.orgId,
      projectId: schema.statuses.projectId,
      name: schema.statuses.name,
      category: schema.statuses.category,
      color: schema.statuses.color,
      isDefault: schema.statuses.isDefault,
    })
    .from(schema.statuses)
    .where(eq(schema.statuses.id, statusId))
    .limit(1);

  const status = rows[0];
  if (!status) throw errors.notFound();
  return status;
}
