import { and, asc, eq, schema, withOrgScope, outboxWriter } from '@taskflow/db';
import {
  between,
  errors,
  type CardId,
  type ChecklistId,
  type ChecklistItemId,
} from '@taskflow/contracts';
import { createEvent, type DomainEvent } from '@taskflow/events';
import { newId } from '@taskflow/security';
import {
  checklistCreated,
  checklistDeleted,
  checklistItemCreated,
  checklistItemDeleted,
  checklistItemUpdated,
} from './events.js';
import { loadCard } from './card.service.js';
import { recountChecklist } from './counters.js';
import { ancestorsOfCard, enforceOn, envelopeOf, orgOf, type WorkActor } from './shared.js';

/**
 * Checklists (PLAN.md §3.1).
 *
 * Every mutation here ends with `recountChecklist`, and that is the interesting
 * part of the file. `cards.checklist_done` and `checklist_total` exist so that
 * rendering a board does not count items per card — a denormalization whose
 * whole value depends on being exactly right, because a wrong badge is
 * indistinguishable from a correct one.
 *
 * So the recount is a SELECT over the card's items inside the same transaction
 * as the write, not an increment. An increment is faster and drifts: a delete
 * that removed a done item has to decrement two counters, and getting that
 * arithmetic wrong in one branch is invisible until someone notices "3/2".
 * Recomputing is O(items on one card), which is a handful of rows.
 *
 * Authorization is `card:update` throughout — a checklist is part of its card,
 * not a resource anyone grants access to separately.
 */

export interface ChecklistItemSummary {
  readonly itemId: string;
  readonly text: string;
  readonly rank: string;
  readonly done: boolean;
  readonly doneBy: string | null;
  readonly doneAt: Date | null;
}

export interface ChecklistSummary {
  readonly checklistId: string;
  readonly cardId: string;
  readonly name: string;
  readonly rank: string;
  readonly items: readonly ChecklistItemSummary[];
}

export async function listChecklists(
  actor: WorkActor,
  input: { readonly cardId: CardId },
): Promise<readonly ChecklistSummary[]> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const card = await loadCard(tx, input.cardId);
    enforceOn(actor, 'card:read', { type: 'card', id: input.cardId }, card, ancestorsOfCard(card));

    const lists = await tx
      .select({
        checklistId: schema.checklists.id,
        cardId: schema.checklists.cardId,
        name: schema.checklists.name,
        rank: schema.checklists.rank,
      })
      .from(schema.checklists)
      .where(eq(schema.checklists.cardId, input.cardId))
      .orderBy(asc(schema.checklists.rank), asc(schema.checklists.id));

    const items = await tx
      .select({
        itemId: schema.checklistItems.id,
        checklistId: schema.checklistItems.checklistId,
        text: schema.checklistItems.text,
        rank: schema.checklistItems.rank,
        done: schema.checklistItems.done,
        doneBy: schema.checklistItems.doneBy,
        doneAt: schema.checklistItems.doneAt,
      })
      .from(schema.checklistItems)
      .where(eq(schema.checklistItems.cardId, input.cardId))
      .orderBy(asc(schema.checklistItems.rank), asc(schema.checklistItems.id));

    const grouped = new Map<string, ChecklistItemSummary[]>();
    for (const { checklistId, ...item } of items) {
      const bucket = grouped.get(checklistId) ?? [];
      bucket.push(item);
      grouped.set(checklistId, bucket);
    }

    return lists.map((list) => ({ ...list, items: grouped.get(list.checklistId) ?? [] }));
  });
}

export async function createChecklist(
  actor: WorkActor,
  input: { readonly cardId: CardId; readonly name: string },
): Promise<{ readonly checklistId: ChecklistId }> {
  const checklistId = newId<'ChecklistId'>();
  const orgId = orgOf(actor);

  await withOrgScope(orgId, async (tx) => {
    const card = await loadCard(tx, input.cardId);
    enforceOn(
      actor,
      'card:update',
      { type: 'card', id: input.cardId },
      card,
      ancestorsOfCard(card),
    );

    const siblings = await tx
      .select({ rank: schema.checklists.rank })
      .from(schema.checklists)
      .where(eq(schema.checklists.cardId, input.cardId))
      .orderBy(asc(schema.checklists.rank), asc(schema.checklists.id));

    await tx.insert(schema.checklists).values({
      id: checklistId,
      orgId,
      cardId: input.cardId,
      name: input.name,
      rank: between(siblings.at(-1)?.rank ?? null, null),
    });

    await outboxWriter.append(tx, [
      createEvent(
        checklistCreated,
        { checklistId, cardId: input.cardId, boardId: card.boardId, name: input.name },
        envelopeOf(actor),
      ),
    ]);
  });

  return { checklistId };
}

/**
 * Deletes a checklist and every item on it.
 *
 * A delete rather than an archive: a checklist is a grouping, and an archived
 * one would clutter the card forever. Its items go with it through the
 * cascade, which is why the recount afterwards is not optional — the card's
 * counters were computed with those items in them.
 */
export async function deleteChecklist(
  actor: WorkActor,
  input: { readonly checklistId: ChecklistId },
): Promise<{ readonly deleted: true }> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const checklist = await loadChecklist(tx, input.checklistId);
    const card = await loadCard(tx, checklist.cardId as CardId);

    enforceOn(
      actor,
      'card:update',
      { type: 'card', id: checklist.cardId },
      card,
      ancestorsOfCard(card),
    );

    const items = await tx
      .select({ id: schema.checklistItems.id })
      .from(schema.checklistItems)
      .where(eq(schema.checklistItems.checklistId, input.checklistId));

    await tx.delete(schema.checklists).where(eq(schema.checklists.id, input.checklistId));

    await recountChecklist(tx, checklist.cardId as CardId);

    await outboxWriter.append(tx, [
      createEvent(
        checklistDeleted,
        {
          checklistId: input.checklistId,
          cardId: checklist.cardId,
          boardId: card.boardId,
          name: checklist.name,
          itemCount: items.length,
        },
        envelopeOf(actor),
      ),
    ]);

    return { deleted: true as const };
  });
}

export async function addItem(
  actor: WorkActor,
  input: { readonly checklistId: ChecklistId; readonly text: string },
): Promise<{ readonly itemId: ChecklistItemId }> {
  const itemId = newId<'ChecklistItemId'>();
  const orgId = orgOf(actor);

  await withOrgScope(orgId, async (tx) => {
    const checklist = await loadChecklist(tx, input.checklistId);
    const card = await loadCard(tx, checklist.cardId as CardId);

    enforceOn(
      actor,
      'card:update',
      { type: 'card', id: checklist.cardId },
      card,
      ancestorsOfCard(card),
    );

    const siblings = await tx
      .select({ rank: schema.checklistItems.rank })
      .from(schema.checklistItems)
      .where(eq(schema.checklistItems.checklistId, input.checklistId))
      .orderBy(asc(schema.checklistItems.rank), asc(schema.checklistItems.id));

    await tx.insert(schema.checklistItems).values({
      id: itemId,
      orgId,
      // From the CHECKLIST row rather than the caller, so the composite foreign
      // key has nothing to reject.
      cardId: checklist.cardId,
      checklistId: input.checklistId,
      text: input.text,
      rank: between(siblings.at(-1)?.rank ?? null, null),
    });

    await recountChecklist(tx, checklist.cardId as CardId);

    await outboxWriter.append(tx, [
      createEvent(
        checklistItemCreated,
        {
          itemId,
          checklistId: input.checklistId,
          cardId: checklist.cardId,
          boardId: card.boardId,
          text: input.text,
        },
        envelopeOf(actor),
      ),
    ]);
  });

  return { itemId };
}

/**
 * Edits an item's text, its done state, or both.
 *
 * `done`, `doneAt` and `doneBy` are written together because the migration's
 * CHECK requires them to agree — an item marked done with a null `doneAt` is a
 * failed write here rather than a row that renders three different ways
 * depending on which column the reader trusts.
 */
export async function updateItem(
  actor: WorkActor,
  input: {
    readonly itemId: ChecklistItemId;
    readonly text: string;
    readonly done: boolean;
  },
): Promise<{ readonly done: boolean }> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const item = await loadItem(tx, input.itemId);
    const card = await loadCard(tx, item.cardId as CardId);

    enforceOn(actor, 'card:update', { type: 'card', id: item.cardId }, card, ancestorsOfCard(card));

    /* Re-ticking an already-done item must not move `doneAt`. "Who finished
       this and when" is the useful fact, and a save-on-blur UI would otherwise
       rewrite it on every focus change. */
    const doneAt = input.done ? (item.doneAt ?? new Date()) : null;
    const doneBy = input.done ? (item.doneBy ?? actor.subject.userId) : null;

    await tx
      .update(schema.checklistItems)
      .set({ text: input.text, done: input.done, doneAt, doneBy, updatedAt: new Date() })
      .where(eq(schema.checklistItems.id, input.itemId));

    await recountChecklist(tx, item.cardId as CardId);

    await outboxWriter.append(tx, [
      createEvent(
        checklistItemUpdated,
        {
          itemId: input.itemId,
          checklistId: item.checklistId,
          cardId: item.cardId,
          boardId: card.boardId,
          before: { text: item.text, done: item.done },
          after: { text: input.text, done: input.done },
        },
        envelopeOf(actor),
      ),
    ]);

    return { done: input.done };
  });
}

export async function deleteItem(
  actor: WorkActor,
  input: { readonly itemId: ChecklistItemId },
): Promise<{ readonly deleted: true }> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const item = await loadItem(tx, input.itemId);
    const card = await loadCard(tx, item.cardId as CardId);

    enforceOn(actor, 'card:update', { type: 'card', id: item.cardId }, card, ancestorsOfCard(card));

    await tx.delete(schema.checklistItems).where(eq(schema.checklistItems.id, input.itemId));

    await recountChecklist(tx, item.cardId as CardId);

    const events: DomainEvent[] = [
      createEvent(
        checklistItemDeleted,
        {
          itemId: input.itemId,
          checklistId: item.checklistId,
          cardId: item.cardId,
          boardId: card.boardId,
          text: item.text,
        },
        envelopeOf(actor),
      ),
    ];

    await outboxWriter.append(tx, events);

    return { deleted: true as const };
  });
}

interface ChecklistRow {
  readonly orgId: string;
  readonly cardId: string;
  readonly name: string;
}

async function loadChecklist(
  tx: Parameters<Parameters<typeof withOrgScope>[1]>[0],
  checklistId: ChecklistId,
): Promise<ChecklistRow> {
  const rows = await tx
    .select({
      orgId: schema.checklists.orgId,
      cardId: schema.checklists.cardId,
      name: schema.checklists.name,
    })
    .from(schema.checklists)
    .where(eq(schema.checklists.id, checklistId))
    .limit(1);

  const checklist = rows[0];
  if (!checklist) throw errors.notFound();
  return checklist;
}

interface ItemRow {
  readonly orgId: string;
  readonly cardId: string;
  readonly checklistId: string;
  readonly text: string;
  readonly done: boolean;
  readonly doneAt: Date | null;
  readonly doneBy: string | null;
}

async function loadItem(
  tx: Parameters<Parameters<typeof withOrgScope>[1]>[0],
  itemId: ChecklistItemId,
): Promise<ItemRow> {
  const rows = await tx
    .select({
      orgId: schema.checklistItems.orgId,
      cardId: schema.checklistItems.cardId,
      checklistId: schema.checklistItems.checklistId,
      text: schema.checklistItems.text,
      done: schema.checklistItems.done,
      doneAt: schema.checklistItems.doneAt,
      doneBy: schema.checklistItems.doneBy,
    })
    .from(schema.checklistItems)
    .where(and(eq(schema.checklistItems.id, itemId)))
    .limit(1);

  const item = rows[0];
  if (!item) throw errors.notFound();
  return item;
}
