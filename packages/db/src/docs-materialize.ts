import { sql } from 'drizzle-orm';
import type { TenantDb } from './client.js';

/**
 * WAL rows for a page created strictly after its latest saved snapshot — the
 * tail half of "latest snapshot plus everything since" that
 * `materializeCurrentState` (`apps/api/src/docs/page-version.service.ts`) and
 * `apps/collab/src/replay.ts`'s `replayPage` both reconstruct from.
 *
 * The boundary is a subquery evaluated INSIDE this one statement, never a JS
 * value compared afterward. `created_at` is `timestamptz`, which Postgres
 * stores with microsecond precision; a JS `Date` can only represent
 * milliseconds. Reading the snapshot's `created_at` into JS first and using
 * it as a `>` bound in a second query silently truncates it toward the start
 * of its millisecond — the truncated bound can land BEFORE the snapshot's
 * real insert instant, which wrongly admits any WAL row from the same
 * millisecond that landed just before it. A restore followed immediately by
 * a resave hits exactly this on a fast connection: `restorePageVersion`'s
 * new snapshot and the just-superseded edit's WAL row can both fall inside
 * one millisecond, and the truncated boundary let the superseded edit back
 * in as a CRDT union with the restored content —
 * `page-version.service.test.ts`'s "materializeCurrentState ... sees the
 * restored content, not a CRDT union" is the reproduction. Comparing against
 * `(SELECT ... LIMIT 1)` inside one statement never leaves Postgres, so it
 * always compares the real stored values, not a lossy copy of one of them.
 */
export async function walRowsSinceLatestSnapshot(
  tx: TenantDb,
  pageId: string,
): Promise<readonly { readonly data: Buffer }[]> {
  const result = await tx.execute(sql`
    SELECT data
      FROM docs.yjs_updates
     WHERE page_id = ${pageId}
       AND created_at > COALESCE(
             (SELECT created_at FROM docs.page_versions
               WHERE page_id = ${pageId}
               ORDER BY created_at DESC LIMIT 1),
             '-infinity'::timestamptz
           )
     ORDER BY created_at, id
  `);

  return result.rows.map((row) => {
    const record: Record<string, unknown> = row;
    return { data: record['data'] as Buffer };
  });
}
