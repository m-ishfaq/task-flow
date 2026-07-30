import { and, asc, eq, isNull, schema, type withOrgScope } from '@taskflow/db';
import { needsRebalance, rankSequence, type ListId } from '@taskflow/contracts';

/**
 * Rank renormalization (PLAN.md §10.1).
 *
 * ## Why this is not in card.service.ts
 *
 * Guardrail 11 requires every state-mutating SERVICE method to emit a domain
 * event, and this mutates a great many rows while emitting nothing. That is not
 * an exemption being taken — it is what the rule's own scope means: repositories
 * mutate without emitting by design, and the event belongs to the operation the
 * user actually performed. `moveCard` emits `list.rebalanced` in the same
 * transaction that calls this.
 *
 * Keeping it in the service file and reaching for a lint disable would have
 * inverted that: the rule would stop watching a file where a genuinely silent
 * mutation could later be added.
 *
 * ## Why the whole list
 *
 * A partial renormalization leaves exactly the long ranks it was run to remove.
 * Rewriting every row is also what makes the result predictable — after this
 * runs, the list's ranks are `rankSequence(n)` and nothing else, which is a
 * property a test can assert.
 *
 * ## Where this will live
 *
 * §10.1 describes a `rank-rebalance` JOB. This is the synchronous half, run by
 * the move that discovers the problem so the pathology stays bounded by the
 * operation that caused it. A scheduled sweep for lists that degraded without
 * anyone moving a card belongs in `apps/worker` from Phase 4, and will call
 * this same function.
 */

type Tx = Parameters<Parameters<typeof withOrgScope>[1]>[0];

/**
 * Rewrites every rank in a list to an evenly spaced sequence.
 *
 * Returns how many rows were rewritten, which is what the caller puts in the
 * `list.rebalanced` event — consumers need it to decide whether refetching the
 * column is worth it.
 */
export async function rebalanceList(tx: Tx, listId: ListId): Promise<number> {
  const rows = await tx
    .select({ cardId: schema.cards.id, rank: schema.cards.rank })
    .from(schema.cards)
    .where(and(eq(schema.cards.listId, listId), isNull(schema.cards.deletedAt)))
    // The existing (rank, id) order IS the intended order — renormalizing must
    // preserve what the user arranged, not reset it to creation order.
    .orderBy(asc(schema.cards.rank), asc(schema.cards.id));

  const ranks = rankSequence(rows.length);

  for (const [index, row] of rows.entries()) {
    const next = ranks[index];
    if (next === undefined) continue;
    await tx.update(schema.cards).set({ rank: next }).where(eq(schema.cards.id, row.cardId));
  }

  return rows.length;
}

/**
 * True when a list's ranks have degraded far enough to be worth rewriting.
 *
 * Consulted by the future sweep job rather than by `moveCard`, which does not
 * need to predict the problem: it discovers it when `between` refuses to
 * produce a value, which is the only moment the degradation actually matters.
 */
export async function listNeedsRebalance(tx: Tx, listId: ListId): Promise<boolean> {
  const rows = await tx
    .select({ rank: schema.cards.rank })
    .from(schema.cards)
    .where(and(eq(schema.cards.listId, listId), isNull(schema.cards.deletedAt)));

  return needsRebalance(rows.map((row) => row.rank));
}
