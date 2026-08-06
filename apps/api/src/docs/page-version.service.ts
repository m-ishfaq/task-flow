import * as Y from 'yjs';
import { and, asc, desc, eq, gt, schema, withOrgScope, outboxWriter } from '@taskflow/db';
import { errors, type PageId } from '@taskflow/contracts';
import { createEvent } from '@taskflow/events';
import { uuidv7 } from '@taskflow/security';
import { pageVersionRestored, pageVersionSaved } from './events.js';
import { enforceOnPage, envelopeOf, loadPage, orgOf, userOf, type DocsActor } from './shared.js';

/**
 * Page versions — on-demand save and restore (ai/phase-6-docs.md §3.7,
 * Wave 2). Compaction's own periodic 'autosave' rows are written by
 * `apps/collab` directly against `docs.page_versions`, as `taskflow_collab`
 * — nothing here writes those. This file is the ORDINARY API-path half:
 * guardrail 11 and guardrail 6 apply exactly as they do everywhere else
 * (§6.3), because a manual save or a restore is a normal authenticated HTTP
 * mutation, not the write-exception `apps/collab` exists for.
 *
 * ## Reading content with no live document to ask
 *
 * `apps/api` has no connection to whichever `apps/collab` process might
 * currently hold this page's `Y.Doc` in memory — and does not need one.
 * `beforeHandleMessage` durably persists every incoming update to
 * `docs.yjs_updates` before it is even applied live (Wave 2's own
 * durability guarantee), so "the latest snapshot plus the WAL tail since
 * it" — the exact replay `apps/collab/src/replay.ts` performs on load — is
 * always an accurate reconstruction of current content, computed here
 * independently rather than by asking the other process. `taskflow_app`
 * already holds full access to both tables via the schema-wide default
 * privileges migration 0001 grants (confirmed directly against a running
 * database before writing this file — `taskflow_collab`'s migration 0024
 * grant is narrower, not exclusive).
 *
 * ## What "restore" does NOT do
 *
 * It appends the restored state as a new WAL row — a full encoded Yjs state
 * is a valid `Y.applyUpdate` input and converges correctly — and records a
 * new 'manual' snapshot at that point. A currently-open LIVE editing
 * session for this page will not see the restore until it reconnects:
 * propagating it into an already-loaded, in-memory `Y.Doc` would need
 * `apps/collab` to be notified (a `NOTIFY`/outbox-consumed signal telling it
 * to re-apply or reload), which is not built in this wave. Named here
 * explicitly as a known limitation rather than assumed away — the property
 * Wave 2's own acceptance criteria requires is that a restore round-trips
 * (a fresh load reflects it), which this satisfies.
 */

export interface PageVersionSummary {
  readonly versionId: string;
  readonly kind: string;
  readonly createdBy: string | null;
  readonly createdAt: Date;
}

export async function listPageVersions(
  actor: DocsActor,
  input: { readonly pageId: PageId },
): Promise<readonly PageVersionSummary[]> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const page = await loadPage(tx, input.pageId);
    enforceOnPage(actor, 'page:read', page);

    const rows = await tx
      .select({
        id: schema.pageVersions.id,
        kind: schema.pageVersions.kind,
        createdBy: schema.pageVersions.createdBy,
        createdAt: schema.pageVersions.createdAt,
      })
      .from(schema.pageVersions)
      .where(eq(schema.pageVersions.pageId, input.pageId))
      .orderBy(desc(schema.pageVersions.createdAt));

    return rows.map((row) => ({
      versionId: row.id,
      kind: row.kind,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
    }));
  });
}

type Tx = Parameters<Parameters<typeof withOrgScope>[1]>[0];

/** The current materialized state: latest snapshot, if any, plus every WAL row since. */
async function materializeCurrentState(tx: Tx, pageId: PageId): Promise<Uint8Array> {
  const snapshotRows = await tx
    .select({ state: schema.pageVersions.state, createdAt: schema.pageVersions.createdAt })
    .from(schema.pageVersions)
    .where(eq(schema.pageVersions.pageId, pageId))
    .orderBy(desc(schema.pageVersions.createdAt))
    .limit(1);
  const snapshot = snapshotRows[0] ?? null;

  const doc = new Y.Doc();
  if (snapshot) Y.applyUpdate(doc, snapshot.state);

  const updateRows = await tx
    .select({ data: schema.yjsUpdates.data })
    .from(schema.yjsUpdates)
    .where(
      and(
        eq(schema.yjsUpdates.pageId, pageId),
        snapshot === null ? undefined : gt(schema.yjsUpdates.createdAt, snapshot.createdAt),
      ),
    )
    .orderBy(asc(schema.yjsUpdates.createdAt), asc(schema.yjsUpdates.id));

  for (const row of updateRows) Y.applyUpdate(doc, row.data);

  return Y.encodeStateAsUpdate(doc);
}

export async function savePageVersion(
  actor: DocsActor,
  input: { readonly pageId: PageId },
): Promise<{ readonly versionId: string }> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const page = await loadPage(tx, input.pageId);
    enforceOnPage(actor, 'page:update', page);

    const state = await materializeCurrentState(tx, input.pageId);
    const versionId = uuidv7();

    await tx.insert(schema.pageVersions).values({
      id: versionId,
      orgId: orgOf(actor),
      pageId: input.pageId,
      kind: 'manual',
      state: Buffer.from(state),
      createdBy: userOf(actor),
    });

    await outboxWriter.append(tx, [
      createEvent(pageVersionSaved, { pageId: input.pageId, versionId }, envelopeOf(actor)),
    ]);

    return { versionId };
  });
}

export async function restorePageVersion(
  actor: DocsActor,
  input: { readonly pageId: PageId; readonly versionId: string },
): Promise<void> {
  await withOrgScope(orgOf(actor), async (tx) => {
    const page = await loadPage(tx, input.pageId);
    enforceOnPage(actor, 'page:update', page);

    const rows = await tx
      .select({ state: schema.pageVersions.state })
      .from(schema.pageVersions)
      .where(and(eq(schema.pageVersions.id, input.versionId), eq(schema.pageVersions.pageId, input.pageId)))
      .limit(1);

    const version = rows[0];
    if (!version) throw errors.notFound();

    const orgId = orgOf(actor);

    // A full encoded Yjs state is a valid `Y.applyUpdate` input, so this
    // converges correctly on replay without needing a diff against current
    // content.
    await tx.insert(schema.yjsUpdates).values({
      id: uuidv7(),
      orgId,
      pageId: input.pageId,
      data: version.state,
    });

    await tx.insert(schema.pageVersions).values({
      id: uuidv7(),
      orgId,
      pageId: input.pageId,
      kind: 'manual',
      state: version.state,
      createdBy: userOf(actor),
    });

    await outboxWriter.append(tx, [
      createEvent(
        pageVersionRestored,
        { pageId: input.pageId, versionId: input.versionId },
        envelopeOf(actor),
      ),
    ]);
  });
}
