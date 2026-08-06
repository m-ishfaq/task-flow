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
 * `origin: 'replay'` on every applied update, not `undefined` — Hocuspocus's
 * own `onChange`/`onStoreDocument` hooks fire on ANY applied update
 * regardless of origin (there is no origin-based skip for load-time
 * replay), so tagging these lets a future hook distinguish "this update
 * came from reconstructing history" from "this update just arrived over
 * the wire" if that distinction is ever needed — cheap to add now, real
 * work to retrofit once something depends on updates being untagged.
 */
export async function replayPage(document: Y.Doc, orgId: OrgId, pageId: PageId): Promise<void> {
  const snapshot = await latestVersion(orgId, pageId);
  if (snapshot !== null) {
    Y.applyUpdate(document, snapshot.state, 'replay');
  }

  const updates = await readUpdatesSince(orgId, pageId, snapshot?.createdAt ?? null);
  for (const row of updates) {
    Y.applyUpdate(document, row.data, 'replay');
  }
}
