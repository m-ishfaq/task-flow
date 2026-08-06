import { sql } from 'drizzle-orm';
import type { GlobalDb } from './client.js';
import { backlinkDispatch } from './schema/docs.js';

/**
 * The backlinks relay's claim/mark primitives (ai/phase-6-docs.md §3.10,
 * migration 0025's own header, Wave 3).
 *
 * Mirrors `outbox.ts`'s `claimPending`/`markDispatched` shape closely, with
 * one deliberate difference: `docs.backlink_dispatch` marks PROCESSED, not
 * PENDING (see the migration's header on why — an existence anti-join, not
 * a position cursor, and no producer-side write for `taskflow_collab`).
 */

export interface UnprocessedPageVersion {
  readonly id: string;
  readonly orgId: string;
  readonly pageId: string;
}

/**
 * Claims up to `limit` `docs.page_versions` rows with no matching
 * `docs.backlink_dispatch` row, oldest first.
 *
 * Raw SQL, not the query builder — `taskflow_backlinks` holds only a
 * COLUMN-LEVEL grant on `docs.page_versions` (`id, org_id, page_id,
 * created_at`, never `state`), and Drizzle's `.select().from(pageVersions)`
 * has no way to express "every column except this one"; naming exactly the
 * four columns this role may read is what makes the grant meaningful rather
 * than aspirational. `FOR UPDATE OF pv` for the identical reason
 * `claimPending` uses it: Postgres requires an unqualified name in that
 * clause, and locking only the page_versions side (never the nullable
 * dispatch side) is what lets this scale past one process without two
 * instances contending on the same row.
 */
export async function claimUnprocessedPageVersions(
  tx: GlobalDb,
  limit = 100,
): Promise<readonly UnprocessedPageVersion[]> {
  const result = await tx.execute(sql`
    SELECT pv.id::text      AS id,
           pv.org_id::text  AS org_id,
           pv.page_id::text AS page_id
      FROM docs.page_versions pv
      LEFT JOIN docs.backlink_dispatch bd
        ON bd.page_version_id = pv.id
     WHERE bd.page_version_id IS NULL
     ORDER BY pv.created_at, pv.id
     LIMIT ${limit}
       FOR UPDATE OF pv SKIP LOCKED
  `);

  return result.rows.map((row): UnprocessedPageVersion => {
    const record: Record<string, unknown> = row;
    return {
      id: String(record['id']),
      orgId: String(record['org_id']),
      pageId: String(record['page_id']),
    };
  });
}

/** Marks `page_versions` rows processed. Called in the same transaction that claimed them. */
export async function markBacklinksProcessed(
  tx: GlobalDb,
  rows: readonly { readonly pageVersionId: string; readonly orgId: string }[],
): Promise<void> {
  if (rows.length === 0) return;

  await tx
    .insert(backlinkDispatch)
    .values(rows.map((row) => ({ pageVersionId: row.pageVersionId, orgId: row.orgId })));
}
