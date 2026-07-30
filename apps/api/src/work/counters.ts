import { and, eq, isNull, schema, type withOrgScope } from '@taskflow/db';
import type { CardId } from '@taskflow/contracts';

/**
 * Denormalized counter maintenance for cards (PLAN.md §7.2).
 *
 * `cards.comment_count`, `checklist_done` and `checklist_total` exist so that
 * rendering a board does not count children per card. The value of that
 * denormalization depends entirely on the numbers being exactly right: a wrong
 * badge looks exactly like a correct one, so an error here is discovered by a
 * user saying "it says 3 of 2" months later.
 *
 * ## Why recompute rather than increment
 *
 * An increment is one cheap statement and drifts. Deleting a checklist item has
 * to decrement `checklist_total` and ALSO `checklist_done`, but only if that
 * item was done; deleting a whole checklist has to subtract both counts of
 * whatever it held; toggling twice must not double-count. Every one of those is
 * a branch, and a branch that is wrong produces a number nothing ever corrects.
 *
 * Recomputing is a SELECT over one card's children — a handful of rows, on an
 * index that exists for it — inside the same transaction as the write. It has
 * no branches, so there is nothing to get wrong in one of them.
 *
 * ## Why this is not in a service file
 *
 * Guardrail 11 requires every state-mutating service method to emit a domain
 * event. This mutates and emits nothing, by design: the event belongs to the
 * operation that changed the children, and the caller emits it in the same
 * transaction. Same reasoning as `rebalance.ts`.
 */

type Tx = Parameters<Parameters<typeof withOrgScope>[1]>[0];

/**
 * Recomputes a card's checklist counters from its items.
 *
 * Counts every item on the CARD, not on one checklist: the counters describe
 * the card, and a card with three checklists shows one combined badge.
 */
export async function recountChecklist(tx: Tx, cardId: CardId): Promise<void> {
  const items = await tx
    .select({ done: schema.checklistItems.done })
    .from(schema.checklistItems)
    .where(eq(schema.checklistItems.cardId, cardId));

  const total = items.length;
  const done = items.filter((item) => item.done).length;

  await tx
    .update(schema.cards)
    .set({ checklistTotal: total, checklistDone: done })
    .where(eq(schema.cards.id, cardId));
}

/**
 * Recomputes a card's comment count.
 *
 * Excludes soft-deleted comments: the tombstone exists so a thread does not
 * lose its middle, but a deleted comment is not one the badge should promise.
 */
export async function recountComments(tx: Tx, cardId: CardId): Promise<void> {
  const comments = await tx
    .select({ id: schema.cardComments.id })
    .from(schema.cardComments)
    .where(and(eq(schema.cardComments.cardId, cardId), isNull(schema.cardComments.deletedAt)));

  await tx
    .update(schema.cards)
    .set({ commentCount: comments.length })
    .where(eq(schema.cards.id, cardId));
}
