import { and, asc, eq, isNull, schema, type withOrgScope } from '@taskflow/db';
import { needsRebalance, rankSequence, type PageId, type SpaceId } from '@taskflow/contracts';

/**
 * Rank renormalization for page siblings (PLAN.md §10.1, mirrored from
 * `work/rebalance.ts`).
 *
 * Not in `page.service.ts` for the reason that file's Work equivalent gives:
 * guardrail 11 requires every state-mutating SERVICE method to emit a domain
 * event, and this mutates every sibling under a parent while emitting nothing
 * itself — `movePage` emits `page.siblings_rebalanced` in the same
 * transaction that calls this, once it knows the count.
 */

type Tx = Parameters<Parameters<typeof withOrgScope>[1]>[0];

/**
 * Rewrites every rank among a parent's live children to an evenly spaced
 * sequence. `parentPageId: null` means the space's root pages.
 *
 * Returns how many rows were rewritten, for the `page.siblings_rebalanced`
 * event.
 */
export async function rebalancePageSiblings(
  tx: Tx,
  spaceId: SpaceId,
  parentPageId: PageId | null,
): Promise<number> {
  const parentCondition =
    parentPageId === null
      ? isNull(schema.pages.parentPageId)
      : eq(schema.pages.parentPageId, parentPageId);

  const rows = await tx
    .select({ pageId: schema.pages.id, rank: schema.pages.rank })
    .from(schema.pages)
    .where(and(eq(schema.pages.spaceId, spaceId), parentCondition, isNull(schema.pages.archivedAt)))
    // The existing (rank, id) order IS the intended order — renormalizing must
    // preserve what the user arranged, not reset it to creation order.
    .orderBy(asc(schema.pages.rank), asc(schema.pages.id));

  const ranks = rankSequence(rows.length);

  for (const [index, row] of rows.entries()) {
    const next = ranks[index];
    if (next === undefined) continue;
    await tx.update(schema.pages).set({ rank: next }).where(eq(schema.pages.id, row.pageId));
  }

  return rows.length;
}

/** Consulted by a future sweep job, mirroring `listNeedsRebalance`. */
export async function pageSiblingsNeedRebalance(
  tx: Tx,
  spaceId: SpaceId,
  parentPageId: PageId | null,
): Promise<boolean> {
  const parentCondition =
    parentPageId === null
      ? isNull(schema.pages.parentPageId)
      : eq(schema.pages.parentPageId, parentPageId);

  const rows = await tx
    .select({ rank: schema.pages.rank })
    .from(schema.pages)
    .where(and(eq(schema.pages.spaceId, spaceId), parentCondition, isNull(schema.pages.archivedAt)));

  return needsRebalance(rows.map((row) => row.rank));
}
