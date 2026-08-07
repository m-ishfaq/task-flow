import * as Y from 'yjs';
import type { OrgId, PageId } from '@taskflow/contracts';
import { enforceContentWhitelist } from './content-guard.js';
import { pruneUpdates, readUpdatesSince } from './persist.js';
import { latestVersion, writeVersion } from './versions.js';

/**
 * Periodic compaction (ai/phase-6-docs.md §3.7) — triggered by Hocuspocus's
 * own `onStoreDocument` hook, not a separate timer.
 *
 * ## Why `onStoreDocument`, and not a standalone scheduled job
 *
 * A standalone job reading purely from Postgres would only ever see a
 * disconnected replica it builds from persisted rows — never the actual
 * live `Y.Doc` Hocuspocus holds in memory for an active session. §3.8/§7.3's
 * decided mechanism is explicit that the content-whitelist strip has to
 * reach "the live `Y.Doc` itself... so every connected client converges to
 * the sanitized state too" — a job that can only touch a disconnected copy
 * can never do that. `onStoreDocument` fires on the real, live document,
 * debounced (Hocuspocus's own `debounce`/`maxDebounce` config, left at the
 * library's defaults of 2s/10s), which is both the correct target for the
 * strip and a naturally self-limiting compaction cadence: it only fires
 * when there has been a real change, which is exactly when the WAL is
 * growing and pruning has something to do. A page nobody is editing needs
 * no compaction, and gets none.
 *
 * ## What this function does NOT persist as its own WAL entry
 *
 * `enforceContentWhitelist` mutates `document` directly (a local
 * `doc.transact()`, not a message from any connection), so it never passes
 * through `beforeHandleMessage` and is never written to `docs.yjs_updates`
 * as a separate row. That is fine: the stripped state is captured in the
 * `page_versions` snapshot this function writes immediately afterward, and
 * Yjs's own update-broadcast mechanism — which does not care whether a
 * transaction's origin was a client message or a local mutation — still
 * propagates the strip to every currently connected client.
 *
 * ## Pruning is race-safe by construction
 *
 * `pruneUpdates` deletes exactly the row ids `readUpdatesSince` returned
 * here, never a timestamp range. A new update arriving on the live document
 * WHILE this function runs gets its own new WAL row with a new id — outside
 * the id list this pass computed — so it is never pruned before a LATER
 * compaction pass has actually folded it into a snapshot, even though the
 * snapshot written here (encoding `document`'s live state at that instant)
 * may incidentally already reflect it. The next pass re-reads and
 * re-prunes that row redundantly; see `readUpdatesSince`'s own doc comment
 * on why redundant inclusion is the safe direction, not the dangerous one.
 */
export interface CompactionResult {
  readonly compacted: boolean;
  readonly prunedCount: number;
  readonly strippedNodes: number;
  readonly strippedTextRuns: number;
}

export async function compactPage(
  document: Y.Doc,
  orgId: OrgId,
  pageId: PageId,
): Promise<CompactionResult> {
  const snapshot = await latestVersion(orgId, pageId);
  const rows = await readUpdatesSince(orgId, pageId, snapshot?.createdAt ?? null);

  if (rows.length === 0) {
    return { compacted: false, prunedCount: 0, strippedNodes: 0, strippedTextRuns: 0 };
  }

  const guardResult = enforceContentWhitelist(document.getXmlFragment('content'));

  await writeVersion(orgId, pageId, 'autosave', Y.encodeStateAsUpdate(document));
  await pruneUpdates(
    orgId,
    pageId,
    rows.map((row) => row.id),
  );

  return {
    compacted: true,
    prunedCount: rows.length,
    strippedNodes: guardResult.strippedNodes,
    strippedTextRuns: guardResult.strippedTextRuns,
  };
}
