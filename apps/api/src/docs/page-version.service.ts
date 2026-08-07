import * as Y from 'yjs';
import { and, asc, desc, eq, gt, schema, withOrgScope, outboxWriter } from '@taskflow/db';
import { errors, type PageId } from '@taskflow/contracts';
import { createEvent } from '@taskflow/events';
import { uuidv7 } from '@taskflow/security';
import { pageVersionRestored, pageVersionSaved } from './events.js';
import { renderPagePdf } from './render.js';
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
 * ## Why restore writes ONLY a new snapshot, never a WAL row
 *
 * The first version of this function also appended the restored state as a
 * new `docs.yjs_updates` row, on the theory that "a full encoded Yjs state is
 * a valid `Y.applyUpdate` input, so it converges correctly." That is false
 * for what restore actually needs, and a real end-to-end test — driving a
 * live `apps/collab` session, not just this function in isolation — caught
 * it within one run. Yjs updates are additive CRDT operations, never
 * subtractive: re-applying an OLD state as a new update merges its
 * (already-known) operations back in as a no-op, it does not delete or
 * supersede whatever was inserted AFTER that snapshot. A page saved as
 * "original content", edited further to "edited, original content", then
 * "restored" to the save point and replayed still came back as "edited,
 * original content" — the append-only WAL row could not un-insert the later
 * edit.
 *
 * The fix relies on a property `materializeCurrentState` below and
 * `apps/collab/src/replay.ts`'s `replayPage` already both have: BOTH always
 * start from the LATEST `page_versions` snapshot and replay only the WAL
 * tail newer than it, never the full history from empty. So writing a new
 * 'manual' snapshot whose `state` is the target version's own bytes is
 * sufficient on its own — any future replay finds this row as "latest",
 * applies it to a fresh `Y.Doc`, and reconstructs exactly the restored
 * content, with nothing from the superseded edits surviving. No delete/
 * insert diff needs computing, and no WAL row needs writing at all.
 *
 * ## What "restore" does NOT do
 *
 * A currently-open LIVE editing session for this page will not see the
 * restore until it reconnects: propagating it into an already-loaded,
 * in-memory `Y.Doc` would need `apps/collab` to be notified (a
 * `NOTIFY`/outbox-consumed signal telling it to re-apply or reload), which is
 * not built in this wave. Named here explicitly as a known limitation rather
 * than assumed away — the property Wave 2's own acceptance criteria requires
 * is that a restore round-trips (a fresh load reflects it), which this
 * satisfies.
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

/**
 * The current materialized state: latest snapshot, if any, plus every WAL
 * row since. Exported for `backlinks.relay.ts` (Wave 3) — the identical
 * "latest snapshot plus WAL tail" reconstruction this file's own header
 * already argues is always accurate, reused rather than re-derived a third
 * time (`apps/collab/src/replay.ts` is the second).
 */
export async function materializeCurrentState(tx: Tx, pageId: PageId): Promise<Uint8Array> {
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
      .where(
        and(
          eq(schema.pageVersions.id, input.versionId),
          eq(schema.pageVersions.pageId, input.pageId),
        ),
      )
      .limit(1);

    const version = rows[0];
    if (!version) throw errors.notFound();

    const orgId = orgOf(actor);

    // Deliberately NOT a `docs.yjs_updates` row — see the file header on why
    // reapplying an old state as a new WAL entry does not undo later edits.
    // A fresh 'manual' snapshot is both necessary and sufficient: it becomes
    // the new "latest", and every replay starts there.
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

/**
 * Renders a version to PDF, base64-encoded (§3.9, Wave 4).
 *
 * `versionId: null` exports the CURRENT materialized state — the same
 * on-demand materialization `savePageVersion` performs, just not persisted
 * as a new row. A named `versionId` exports exactly that snapshot, "never
 * the live socket": both paths read a value already fixed in the database
 * (or fixed the instant this function reads it, for the current-state case),
 * never a document another editor could be mid-keystroke into.
 *
 * Returned as base64 in an ordinary tRPC response rather than a second
 * binary HTTP route — see `router.ts`'s own note on why: a Docs page's
 * rendered PDF is small (typography, not embedded media), and reusing the
 * existing authenticated, `can()`-checked request path costs nothing here
 * that a dedicated route would save, while a dedicated route would be a
 * second place to get authentication right.
 */
export async function exportPageVersionPdf(
  actor: DocsActor,
  input: { readonly pageId: PageId; readonly versionId: string | null },
): Promise<{ readonly filename: string; readonly base64: string }> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const page = await loadPage(tx, input.pageId);
    enforceOnPage(actor, 'page:read', page);

    let state: Uint8Array;
    if (input.versionId === null) {
      state = await materializeCurrentState(tx, input.pageId);
    } else {
      const rows = await tx
        .select({ state: schema.pageVersions.state })
        .from(schema.pageVersions)
        .where(
          and(
            eq(schema.pageVersions.id, input.versionId),
            eq(schema.pageVersions.pageId, input.pageId),
          ),
        )
        .limit(1);
      const version = rows[0];
      if (!version) throw errors.notFound();
      state = version.state;
    }

    const doc = new Y.Doc();
    Y.applyUpdate(doc, state);

    const pdf = await renderPagePdf({ title: page.title, fragment: doc.getXmlFragment('content') });

    return { filename: `${page.title || 'document'}.pdf`, base64: pdf.toString('base64') };
  });
}
