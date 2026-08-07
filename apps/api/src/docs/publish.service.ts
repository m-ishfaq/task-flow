import { eq, schema, withOrgScope, outboxWriter } from '@taskflow/db';
import { errors, type PageId } from '@taskflow/contracts';
import { createEvent } from '@taskflow/events';
import { uuidv7 } from '@taskflow/security';
import { pagePublished } from './events.js';
import { enforceOnPage, envelopeOf, loadPage, orgOf, userOf, type DocsActor } from './shared.js';
import { materializeCurrentState } from './page-version.service.js';

/**
 * Publish-to-public (ai/phase-6-docs.md §3.9, Wave 4).
 *
 * ## Why `page:update`, not a new `page:publish` permission
 *
 * §7 has no open item asking for publish to be its own grantable tier, and
 * the spec never names one. Every other Wave 2/3 content mutation that is
 * not literally "type characters into the live document" — on-demand save,
 * restore — already sits at `page:update` (`page-version.service.ts`), not
 * a bespoke permission, and publish is the same shape of action: a
 * privileged, occasional, whole-document operation performed by whoever can
 * already edit the page. Inventing `page:publish` now would be exactly the
 * abstraction-ahead-of-a-real-need CLAUDE.md warns against, and unlike
 * `page:delete` (present in the catalog since Wave 1, deliberately unused by
 * Member — see `page.service.ts`'s own header), there is no existing asymmetry
 * here to preserve: nothing in this codebase has ever asked "can this person
 * edit but not publish." If that product question gets asked for real, it is
 * a new permission plus a role-matrix change, not a reinterpretation of this
 * file — the same three-place-change `permissions.ts`'s own header describes.
 *
 * ## What "publish" actually writes
 *
 * A fresh `docs.page_versions` row, `kind = 'publish'`, holding the CURRENT
 * materialized state at the moment of publishing — not a live reference, not
 * the most recent autosave reused in place. `pages.published_version_id`
 * then points at that row (migration 0026's composite FK is what proves it
 * belongs to this page and this org). Publishing again while already
 * published (re-publish after further edits) writes ANOTHER fresh 'publish'
 * row and repoints the pointer — the superseded row is left in place as
 * ordinary version history, exactly like every other page_versions row,
 * rather than deleted.
 *
 * Unpublishing clears `published_version_id`/`published_at` and leaves the
 * 'publish' row itself alone, for the same reason: it is a legitimate part of
 * this page's version history, and `pageVersions.list` (§3.7) already shows
 * every kind without distinction. Nothing about "no longer published" implies
 * "never happened."
 */

export async function publishPage(
  actor: DocsActor,
  input: { readonly pageId: PageId },
): Promise<void> {
  await withOrgScope(orgOf(actor), async (tx) => {
    const page = await loadPage(tx, input.pageId);
    enforceOnPage(actor, 'page:update', page);

    const state = await materializeCurrentState(tx, input.pageId);
    const versionId = uuidv7();

    await tx.insert(schema.pageVersions).values({
      id: versionId,
      orgId: orgOf(actor),
      pageId: input.pageId,
      kind: 'publish',
      state: Buffer.from(state),
      createdBy: userOf(actor),
    });

    const publishedAt = new Date();
    await tx
      .update(schema.pages)
      .set({ publishedVersionId: versionId, publishedAt, updatedAt: publishedAt })
      .where(eq(schema.pages.id, input.pageId));

    await outboxWriter.append(tx, [
      createEvent(
        pagePublished,
        { pageId: input.pageId, versionId, published: true },
        envelopeOf(actor),
      ),
    ]);
  });
}

export async function unpublishPage(
  actor: DocsActor,
  input: { readonly pageId: PageId },
): Promise<void> {
  await withOrgScope(orgOf(actor), async (tx) => {
    const page = await loadPage(tx, input.pageId);
    enforceOnPage(actor, 'page:update', page);

    if (page.publishedVersionId === null) throw errors.notFound();

    await tx
      .update(schema.pages)
      .set({ publishedVersionId: null, publishedAt: null, updatedAt: new Date() })
      .where(eq(schema.pages.id, input.pageId));

    await outboxWriter.append(tx, [
      createEvent(
        pagePublished,
        { pageId: input.pageId, versionId: null, published: false },
        envelopeOf(actor),
      ),
    ]);
  });
}
