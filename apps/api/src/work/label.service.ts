import { eq, schema, withOrgScope, outboxWriter } from '@taskflow/db';
import { errors, type CardId, type LabelId, type ProjectId } from '@taskflow/contracts';
import { createEvent } from '@taskflow/events';
import { newId } from '@taskflow/security';
import { cardLabeled, labelCreated, labelDeleted, labelUpdated } from './events.js';
import { loadCard } from './card.service.js';
import { requireProject } from './project.service.js';
import {
  ancestorsOfCard,
  enforceOn,
  envelopeOf,
  orgOf,
  translatingConstraints,
  type WorkActor,
} from './shared.js';

/**
 * Labels (PLAN.md §3.1).
 *
 * Two different authorization questions live in this file, and conflating them
 * is the mistake worth avoiding:
 *
 *   - MANAGING the label set is editing the project's vocabulary. It affects
 *     every board and every card in the project, so it needs `project:update`
 *     — Owner and Admin.
 *   - ATTACHING a label to a card is editing that card. Any member who can edit
 *     the card can tag it, so it needs `card:update` on the card itself.
 *
 * A single permission for both would either stop members tagging their own work
 * or let them rewrite the project's label set from a card detail panel.
 */

export interface LabelSummary {
  readonly labelId: string;
  readonly projectId: string;
  readonly name: string;
  readonly color: string;
  readonly cardCount: number;
}

export async function listLabels(
  actor: WorkActor,
  input: { readonly projectId: ProjectId },
): Promise<readonly LabelSummary[]> {
  return withOrgScope(orgOf(actor), async (tx) => {
    await requireProject(tx, actor, input.projectId, 'project:read');

    const rows = await tx
      .select({
        labelId: schema.labels.id,
        projectId: schema.labels.projectId,
        name: schema.labels.name,
        color: schema.labels.color,
      })
      .from(schema.labels)
      .where(eq(schema.labels.projectId, input.projectId))
      .orderBy(schema.labels.name);

    const used = await tx
      .select({ labelId: schema.cardLabels.labelId })
      .from(schema.cardLabels)
      .where(eq(schema.cardLabels.projectId, input.projectId));

    const counts = new Map<string, number>();
    for (const row of used) counts.set(row.labelId, (counts.get(row.labelId) ?? 0) + 1);

    return rows.map((row) => ({ ...row, cardCount: counts.get(row.labelId) ?? 0 }));
  });
}

export async function createLabel(
  actor: WorkActor,
  input: {
    readonly projectId: ProjectId;
    readonly name: string;
    readonly color: string;
  },
): Promise<{ readonly labelId: LabelId }> {
  const labelId = newId<'LabelId'>();
  const orgId = orgOf(actor);

  await translatingConstraints(
    async () =>
      withOrgScope(orgId, async (tx) => {
        await requireProject(tx, actor, input.projectId, 'project:update');

        await tx.insert(schema.labels).values({
          id: labelId,
          orgId,
          projectId: input.projectId,
          name: input.name,
          color: input.color,
        });

        await outboxWriter.append(tx, [
          createEvent(
            labelCreated,
            { labelId, projectId: input.projectId, name: input.name, color: input.color },
            envelopeOf(actor),
          ),
        ]);
      }),
    // The unique index is on lower(name): "Bug" and "bug" are the same label,
    // and two of them make every filter silently incomplete.
    () => errors.conflict('A label with that name already exists in this project.'),
  );

  return { labelId };
}

export async function updateLabel(
  actor: WorkActor,
  input: {
    readonly labelId: LabelId;
    readonly name: string;
    readonly color: string;
  },
): Promise<{ readonly name: string }> {
  const orgId = orgOf(actor);

  return translatingConstraints(
    async () =>
      withOrgScope(orgId, async (tx) => {
        const label = await loadLabel(tx, input.labelId);
        await requireProject(tx, actor, label.projectId as ProjectId, 'project:update');

        await tx
          .update(schema.labels)
          .set({ name: input.name, color: input.color, updatedAt: new Date() })
          .where(eq(schema.labels.id, input.labelId));

        await outboxWriter.append(tx, [
          createEvent(
            labelUpdated,
            {
              labelId: input.labelId,
              projectId: label.projectId,
              before: { name: label.name, color: label.color },
              after: { name: input.name, color: input.color },
            },
            envelopeOf(actor),
          ),
        ]);

        return { name: input.name };
      }),
    () => errors.conflict('A label with that name already exists in this project.'),
  );
}

/**
 * Deletes a label, removing it from every card that carried it.
 *
 * A genuine delete rather than an archive, unlike almost everything else in
 * Work. A label holds no content of its own — removing it un-tags some cards
 * and destroys nothing anybody wrote — so an archived label would be a
 * restorable nothing, permanently cluttering the project's vocabulary.
 *
 * The count of affected cards goes into the event because the audit reader's
 * first question is "how much did that touch?", and it is unanswerable
 * afterwards.
 */
export async function deleteLabel(
  actor: WorkActor,
  input: { readonly labelId: LabelId },
): Promise<{ readonly deleted: true; readonly cardCount: number }> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const label = await loadLabel(tx, input.labelId);
    await requireProject(tx, actor, label.projectId as ProjectId, 'project:update');

    const attached = await tx
      .select({ cardId: schema.cardLabels.cardId })
      .from(schema.cardLabels)
      .where(eq(schema.cardLabels.labelId, input.labelId));

    // `card_labels` cascades from the foreign key, so this one delete is the
    // whole operation.
    await tx.delete(schema.labels).where(eq(schema.labels.id, input.labelId));

    await outboxWriter.append(tx, [
      createEvent(
        labelDeleted,
        {
          labelId: input.labelId,
          projectId: label.projectId,
          name: label.name,
          cardCount: attached.length,
        },
        envelopeOf(actor),
      ),
    ]);

    return { deleted: true as const, cardCount: attached.length };
  });
}

/**
 * Replaces a card's label set.
 *
 * Takes the whole set rather than add/remove, for the same reason as
 * `assignCard`: two people editing labels concurrently with deltas produce a
 * set neither of them chose.
 *
 * The cross-project case needs no check here. `card_labels` carries
 * `project_id` and references BOTH the card and the label on it, so a label
 * from another project is refused by the database rather than by a lookup this
 * code could forget.
 */
export async function setCardLabels(
  actor: WorkActor,
  input: { readonly cardId: CardId; readonly labelIds: readonly LabelId[] },
): Promise<{ readonly labelIds: readonly string[] }> {
  const orgId = orgOf(actor);

  return translatingConstraints(
    async () =>
      withOrgScope(orgId, async (tx) => {
        const card = await loadCard(tx, input.cardId);

        // `card:update` — tagging a card is editing that card, not managing the
        // project's label vocabulary.
        enforceOn(
          actor,
          'card:update',
          { type: 'card', id: input.cardId },
          card,
          ancestorsOfCard(card),
        );

        const existing = await tx
          .select({ labelId: schema.cardLabels.labelId })
          .from(schema.cardLabels)
          .where(eq(schema.cardLabels.cardId, input.cardId));

        const before = existing.map((row) => row.labelId).sort();
        const after = [...new Set(input.labelIds)].sort();

        if (before.length === after.length && before.every((id, index) => id === after[index])) {
          // Nothing changed. Returning early keeps a no-op save out of the audit
          // log, which is otherwise the noisiest entry in the system — a card
          // detail panel that saves on blur produces one per focus change.
          return { labelIds: after };
        }

        await tx.delete(schema.cardLabels).where(eq(schema.cardLabels.cardId, input.cardId));

        if (after.length > 0) {
          await tx.insert(schema.cardLabels).values(
            after.map((labelId) => ({
              orgId,
              projectId: card.projectId,
              cardId: input.cardId,
              labelId,
            })),
          );
        }

        await outboxWriter.append(tx, [
          createEvent(
            cardLabeled,
            { cardId: input.cardId, boardId: card.boardId, before, after },
            envelopeOf(actor),
          ),
        ]);

        return { labelIds: after };
      }),
    () => errors.conflict('That label is already on this card.'),
  );
}

/** Every label on a card, for the card detail panel. */
export async function listCardLabels(
  actor: WorkActor,
  input: { readonly cardId: CardId },
): Promise<readonly LabelSummary[]> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const card = await loadCard(tx, input.cardId);
    enforceOn(actor, 'card:read', { type: 'card', id: input.cardId }, card, ancestorsOfCard(card));

    const rows = await tx
      .select({
        labelId: schema.labels.id,
        projectId: schema.labels.projectId,
        name: schema.labels.name,
        color: schema.labels.color,
      })
      .from(schema.cardLabels)
      .innerJoin(schema.labels, eq(schema.labels.id, schema.cardLabels.labelId))
      .where(eq(schema.cardLabels.cardId, input.cardId))
      .orderBy(schema.labels.name);

    return rows.map((row) => ({ ...row, cardCount: 0 }));
  });
}

interface LabelRow {
  readonly orgId: string;
  readonly projectId: string;
  readonly name: string;
  readonly color: string;
}

async function loadLabel(
  tx: Parameters<Parameters<typeof withOrgScope>[1]>[0],
  labelId: LabelId,
): Promise<LabelRow> {
  const rows = await tx
    .select({
      orgId: schema.labels.orgId,
      projectId: schema.labels.projectId,
      name: schema.labels.name,
      color: schema.labels.color,
    })
    .from(schema.labels)
    .where(eq(schema.labels.id, labelId))
    .limit(1);

  const label = rows[0];
  if (!label) throw errors.notFound();
  return label;
}
