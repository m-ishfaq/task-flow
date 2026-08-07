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
 * than aspirational.
 *
 * NO `FOR UPDATE`, and that is not an oversight — it was the first version
 * of this function, modeled on `claimPending`'s own `FOR UPDATE OF o SKIP
 * LOCKED`, and it failed against a real database with `permission denied
 * for table page_versions` despite the column grant being exactly right.
 * Postgres row-locking clauses need SELECT on every column of the table,
 * not just the ones a query projects — confirmed directly by testing a bare
 * `SELECT ... FOR UPDATE` of only the granted columns as `taskflow_backlinks`
 * against a real database, which is refused the identical way. Granting
 * full-table SELECT to get the lock back would undo the one property this
 * role exists for: that it cannot read `state` even if compromised. So this
 * accepts the trade `claimPending` did not have to: two relay instances
 * ticking at the same moment can both claim the same unprocessed row and
 * both redundantly rewrite the same page's backlinks — wasteful, never
 * wrong, since the rewrite is idempotent and `markBacklinksProcessed` below
 * tolerates the resulting double-insert. A single process's own timer
 * cannot race itself (`startBacklinksRelay`'s `running` guard), so this only
 * matters the day a second instance runs the relay at once — the same
 * "belongs in apps/worker eventually" placeholder scope `tenancy/relay.ts`
 * already names for the identical reason.
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

/**
 * Marks `page_versions` rows processed. Called in the same transaction that
 * claimed them.
 *
 * `onConflictDoNothing` — see `claimUnprocessedPageVersions`'s own header on
 * why a duplicate claim across two racing instances is possible now that
 * neither can lock the row: without this, the second instance's insert
 * would hit `backlink_dispatch`'s primary key and abort its whole
 * transaction over a row that is, by then, correctly marked anyway.
 */
export async function markBacklinksProcessed(
  tx: GlobalDb,
  rows: readonly { readonly pageVersionId: string; readonly orgId: string }[],
): Promise<void> {
  if (rows.length === 0) return;

  await tx
    .insert(backlinkDispatch)
    .values(rows.map((row) => ({ pageVersionId: row.pageVersionId, orgId: row.orgId })))
    .onConflictDoNothing();
}
