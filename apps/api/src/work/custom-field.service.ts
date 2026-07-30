import { and, asc, eq, isNull, schema, withOrgScope, outboxWriter } from '@taskflow/db';
import {
  between,
  errors,
  type CardId,
  type CustomFieldId,
  type ProjectId,
} from '@taskflow/contracts';
import { createEvent } from '@taskflow/events';
import { newId } from '@taskflow/security';
import {
  cardFieldSet,
  customFieldArchived,
  customFieldCreated,
  customFieldUpdated,
} from './events.js';
import { loadCard } from './card.service.js';
import { requireProject } from './project.service.js';
import { validateFieldValue, type CustomFieldType } from './custom-field-value.js';
import {
  ancestorsOfCard,
  enforceOn,
  envelopeOf,
  orgOf,
  translatingConstraints,
  type WorkActor,
} from './shared.js';

/**
 * Custom fields (PLAN.md §3.1).
 *
 * Definitions belong to the project and values belong to the card, and they are
 * permissioned accordingly: defining a field changes what every card in the
 * project has (`project:update`), while filling one in is editing one card
 * (`card:update`). This is the same split as labels, for the same reason.
 *
 * The alternative design — a real column per custom field — is a DDL change
 * triggered by a user clicking a button, taking a lock on the busiest table in
 * the product. This one costs a join and never migrates anything.
 */

export interface CustomFieldSummary {
  readonly fieldId: string;
  readonly projectId: string;
  readonly name: string;
  readonly type: string;
  readonly options: unknown;
  readonly rank: string;
  readonly archivedAt: Date | null;
}

export async function listFields(
  actor: WorkActor,
  input: { readonly projectId: ProjectId; readonly includeArchived: boolean },
): Promise<readonly CustomFieldSummary[]> {
  return withOrgScope(orgOf(actor), async (tx) => {
    await requireProject(tx, actor, input.projectId, 'project:read');

    return tx
      .select({
        fieldId: schema.customFieldDefs.id,
        projectId: schema.customFieldDefs.projectId,
        name: schema.customFieldDefs.name,
        type: schema.customFieldDefs.type,
        options: schema.customFieldDefs.options,
        rank: schema.customFieldDefs.rank,
        archivedAt: schema.customFieldDefs.archivedAt,
      })
      .from(schema.customFieldDefs)
      .where(
        input.includeArchived
          ? eq(schema.customFieldDefs.projectId, input.projectId)
          : and(
              eq(schema.customFieldDefs.projectId, input.projectId),
              isNull(schema.customFieldDefs.archivedAt),
            ),
      )
      .orderBy(asc(schema.customFieldDefs.rank), asc(schema.customFieldDefs.id));
  });
}

export async function createField(
  actor: WorkActor,
  input: {
    readonly projectId: ProjectId;
    readonly name: string;
    readonly type: CustomFieldType;
    readonly options: readonly string[] | null;
  },
): Promise<{ readonly fieldId: CustomFieldId }> {
  const fieldId = newId<'CustomFieldId'>();
  const orgId = orgOf(actor);

  await translatingConstraints(
    async () =>
      withOrgScope(orgId, async (tx) => {
        await requireProject(tx, actor, input.projectId, 'project:update');

        const siblings = await tx
          .select({ rank: schema.customFieldDefs.rank })
          .from(schema.customFieldDefs)
          .where(eq(schema.customFieldDefs.projectId, input.projectId))
          .orderBy(asc(schema.customFieldDefs.rank), asc(schema.customFieldDefs.id));

        await tx.insert(schema.customFieldDefs).values({
          id: fieldId,
          orgId,
          projectId: input.projectId,
          name: input.name,
          type: input.type,
          /* The migration's CHECK pairs these: a select field must have an
             options array and a non-select field must have none. Passing the
             array through unchanged means the database gets the final say. */
          options: input.options === null ? null : [...input.options],
          rank: between(siblings.at(-1)?.rank ?? null, null),
        });

        await outboxWriter.append(tx, [
          createEvent(
            customFieldCreated,
            { fieldId, projectId: input.projectId, name: input.name, type: input.type },
            envelopeOf(actor),
          ),
        ]);
      }),
    () => errors.conflict('A field with that name already exists in this project.'),
  );

  return { fieldId };
}

/**
 * Renames a field.
 *
 * The TYPE is deliberately not editable. Changing `number` to `text` would
 * leave every existing value stored in the old shape while the definition
 * claims the new one — and there is no honest migration, because the right
 * answer for `select` -> `number` depends on data nobody has. Deleting the
 * field and making a new one is explicit about the loss.
 */
export async function updateField(
  actor: WorkActor,
  input: { readonly fieldId: CustomFieldId; readonly name: string },
): Promise<{ readonly name: string }> {
  const orgId = orgOf(actor);

  return translatingConstraints(
    async () =>
      withOrgScope(orgId, async (tx) => {
        const field = await loadField(tx, input.fieldId);
        await requireProject(tx, actor, field.projectId as ProjectId, 'project:update');

        await tx
          .update(schema.customFieldDefs)
          .set({ name: input.name, updatedAt: new Date() })
          .where(eq(schema.customFieldDefs.id, input.fieldId));

        await outboxWriter.append(tx, [
          createEvent(
            customFieldUpdated,
            {
              fieldId: input.fieldId,
              projectId: field.projectId,
              before: { name: field.name },
              after: { name: input.name },
            },
            envelopeOf(actor),
          ),
        ]);

        return { name: input.name };
      }),
    () => errors.conflict('A field with that name already exists in this project.'),
  );
}

/**
 * Archives or restores a field definition.
 *
 * Archived, not deleted — unlike a label. A field's VALUES are data users
 * entered card by card, and deleting the definition cascades every one of them
 * away. Archiving hides the field from the card panel and leaves the values
 * intact, so restoring it gives back what was there.
 */
export async function archiveField(
  actor: WorkActor,
  input: { readonly fieldId: CustomFieldId; readonly archived: boolean },
): Promise<{ readonly archived: boolean }> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const field = await loadField(tx, input.fieldId);
    await requireProject(tx, actor, field.projectId as ProjectId, 'project:update');

    await tx
      .update(schema.customFieldDefs)
      .set({ archivedAt: input.archived ? new Date() : null, updatedAt: new Date() })
      .where(eq(schema.customFieldDefs.id, input.fieldId));

    await outboxWriter.append(tx, [
      createEvent(
        customFieldArchived,
        {
          fieldId: input.fieldId,
          projectId: field.projectId,
          name: field.name,
          restored: !input.archived,
        },
        envelopeOf(actor),
      ),
    ]);

    return { archived: input.archived };
  });
}

/** Every custom field value on a card, for the detail panel. */
export async function listCardValues(
  actor: WorkActor,
  input: { readonly cardId: CardId },
): Promise<readonly { readonly fieldId: string; readonly value: unknown }[]> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const card = await loadCard(tx, input.cardId);
    enforceOn(actor, 'card:read', { type: 'card', id: input.cardId }, card, ancestorsOfCard(card));

    return tx
      .select({ fieldId: schema.customFieldValues.fieldId, value: schema.customFieldValues.value })
      .from(schema.customFieldValues)
      .where(eq(schema.customFieldValues.cardId, input.cardId));
  });
}

/**
 * Sets (or clears, with null) one custom field value on a card.
 *
 * The validation is the interesting part: `jsonb` accepts anything, so the
 * field's declared type is the only thing that makes a value readable. See
 * `custom-field-value.ts` for why it refuses rather than coerces.
 */
export async function setCardValue(
  actor: WorkActor,
  input: {
    readonly cardId: CardId;
    readonly fieldId: CustomFieldId;
    readonly value: unknown;
  },
): Promise<{ readonly value: unknown }> {
  const orgId = orgOf(actor);

  return translatingConstraints(
    async () =>
      withOrgScope(orgId, async (tx) => {
        const card = await loadCard(tx, input.cardId);
        enforceOn(
          actor,
          'card:update',
          { type: 'card', id: input.cardId },
          card,
          ancestorsOfCard(card),
        );

        const field = await loadField(tx, input.fieldId);

        /* The composite foreign key would refuse a cross-project field anyway,
           but a 404 here is the honest answer: as far as this card's project is
           concerned, that field does not exist. Letting the FK fire would
           surface it as a CONFLICT, which suggests retrying. */
        if (field.projectId !== card.projectId) throw errors.notFound();
        if (field.archivedAt !== null) {
          throw errors.conflict('That field has been archived and can no longer be set.');
        }

        const value = validateFieldValue(field, input.value);

        // A `user` field names someone; the same membership requirement as
        // `assignCard` applies, and RLS is what makes the read meaningful.
        if (field.type === 'user' && typeof value === 'string') {
          const members = await tx
            .select({ userId: schema.memberships.userId })
            .from(schema.memberships)
            .where(eq(schema.memberships.status, 'active'));

          if (!members.some((row) => row.userId === value)) {
            throw errors.validation({ [field.name]: 'Not a member of this organization.' });
          }
        }

        const existing = await tx
          .select({ value: schema.customFieldValues.value })
          .from(schema.customFieldValues)
          .where(
            and(
              eq(schema.customFieldValues.cardId, input.cardId),
              eq(schema.customFieldValues.fieldId, input.fieldId),
            ),
          )
          .limit(1);

        const before = existing[0]?.value ?? null;

        if (value === null) {
          // Clearing removes the row rather than storing a JSON null, so
          // "is this field set?" is a row existence question with one answer.
          await tx
            .delete(schema.customFieldValues)
            .where(
              and(
                eq(schema.customFieldValues.cardId, input.cardId),
                eq(schema.customFieldValues.fieldId, input.fieldId),
              ),
            );
        } else {
          await tx
            .insert(schema.customFieldValues)
            .values({
              orgId,
              projectId: card.projectId,
              cardId: input.cardId,
              fieldId: input.fieldId,
              value,
            })
            .onConflictDoUpdate({
              target: [schema.customFieldValues.cardId, schema.customFieldValues.fieldId],
              set: { value, updatedAt: new Date() },
            });
        }

        await outboxWriter.append(tx, [
          createEvent(
            cardFieldSet,
            {
              cardId: input.cardId,
              boardId: card.boardId,
              fieldId: input.fieldId,
              fieldType: field.type,
              before,
              after: value,
            },
            envelopeOf(actor),
          ),
        ]);

        return { value };
      }),
    () => errors.conflict('That field value was changed by someone else.'),
  );
}

interface FieldRow {
  readonly orgId: string;
  readonly projectId: string;
  readonly name: string;
  readonly type: string;
  readonly options: unknown;
  readonly archivedAt: Date | null;
}

async function loadField(
  tx: Parameters<Parameters<typeof withOrgScope>[1]>[0],
  fieldId: CustomFieldId,
): Promise<FieldRow> {
  const rows = await tx
    .select({
      orgId: schema.customFieldDefs.orgId,
      projectId: schema.customFieldDefs.projectId,
      name: schema.customFieldDefs.name,
      type: schema.customFieldDefs.type,
      options: schema.customFieldDefs.options,
      archivedAt: schema.customFieldDefs.archivedAt,
    })
    .from(schema.customFieldDefs)
    .where(eq(schema.customFieldDefs.id, fieldId))
    .limit(1);

  const field = rows[0];
  if (!field) throw errors.notFound();
  return field;
}
