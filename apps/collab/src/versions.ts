import { desc, eq, schema, withCollabScope } from '@taskflow/db';
import { uuidv7 } from '@taskflow/security';
import type { OrgId, PageId } from '@taskflow/contracts';

/**
 * `docs.page_versions` — the compacted/human-meaningful snapshots
 * (ai/phase-6-docs.md §3.7). Written and read here as `taskflow_collab`,
 * since compaction (this process) is the only writer for 'autosave' rows;
 * `apps/api/src/docs`'s manual-save/restore routes write 'manual' rows over
 * the ORDINARY `taskflow_app` connection instead — that path is an ordinary
 * HTTP mutation, not the write-exception this role exists for.
 */

export interface PageVersionSummary {
  readonly id: string;
  readonly kind: string;
  readonly createdAt: Date;
}

export interface PageVersionState extends PageVersionSummary {
  readonly state: Buffer;
}

/** The most recent snapshot for a page, or null if none has been taken yet. */
export async function latestVersion(orgId: OrgId, pageId: PageId): Promise<PageVersionState | null> {
  return withCollabScope(orgId, async (tx) => {
    const rows = await tx
      .select({
        id: schema.pageVersions.id,
        kind: schema.pageVersions.kind,
        state: schema.pageVersions.state,
        createdAt: schema.pageVersions.createdAt,
      })
      .from(schema.pageVersions)
      .where(eq(schema.pageVersions.pageId, pageId))
      .orderBy(desc(schema.pageVersions.createdAt))
      .limit(1);

    return rows[0] ?? null;
  });
}

/**
 * Writes a new snapshot. `kind` is always `'autosave'` from this module —
 * compaction is the only caller — but the parameter stays explicit rather
 * than hard-coded, since a value silently baked in here is easy to miss the
 * one time it needs to change.
 */
export async function writeVersion(
  orgId: OrgId,
  pageId: PageId,
  kind: 'autosave',
  state: Uint8Array,
): Promise<void> {
  await withCollabScope(orgId, async (tx) => {
    await tx.insert(schema.pageVersions).values({
      id: uuidv7(),
      orgId,
      pageId,
      kind,
      state: Buffer.from(state),
      // Null createdBy — see migration 0024's own comment on why: autosave
      // is not an act any user performed.
      createdBy: null,
    });
  });
}
