import * as Y from 'yjs';
import type { OrgId, PageId } from '@taskflow/contracts';
import { readUpdatesSince } from './persist.js';
import { latestVersion } from './versions.js';

/**
 * Reconstructs a page's live state on first load (ai/phase-6-docs.md §3.7).
 *
 * Load the latest snapshot, if one exists, then replay every WAL row since
 * — never the whole history from scratch, which is the entire reason
 * `docs.page_versions` exists alongside the log rather than the log alone.
 * A page nobody has ever opened has no snapshot and no WAL rows, and this
 * is correctly a no-op for it: a fresh `Y.Doc` IS the right starting state.
 *
 * Every applied update carries `{ source: 'local', skipStoreHooks: true }`
 * as its transaction origin — Hocuspocus's own `LocalTransactionOrigin`
 * shape, checked via its exported `shouldSkipStoreHooks`. Without this,
 * reconstructing a page on load would itself trigger `onStoreDocument`
 * (compaction.ts's hook) immediately afterward: a redundant snapshot of
 * state that is, by construction, already exactly what the snapshot it was
 * just built from plus the WAL tail already represent, and a wasted prune
 * pass over WAL rows this same function just finished reading.
 */
export async function replayPage(document: Y.Doc, orgId: OrgId, pageId: PageId): Promise<void> {
  const origin = { source: 'local' as const, skipStoreHooks: true };

  const snapshot = await latestVersion(orgId, pageId);
  if (snapshot !== null) {
    Y.applyUpdate(document, snapshot.state, origin);
  }

  const updates = await readUpdatesSince(orgId, pageId, snapshot?.createdAt ?? null);
  for (const row of updates) {
    Y.applyUpdate(document, row.data, origin);
  }
}
