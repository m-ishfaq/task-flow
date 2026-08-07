import { eq, schema, withOrgScope, outboxWriter } from '@taskflow/db';
import { type PageId } from '@taskflow/contracts';
import { createEvent } from '@taskflow/events';
import { uuidv7 } from '@taskflow/security';
import { pagePublished, pageUnpublished } from './events.js';
import { materializeCurrentState } from './page-version.service.js';
import { enforceOnPage, envelopeOf, loadPage, orgOf, userOf, type DocsActor } from './shared.js';

/**
 * Publish-to-public (ai/phase-6-docs.md §3.9, Wave 4).
 *
 * `page:publish` — admin/owner only (packages/policy/src/roles.ts) — is the
 * authorization boundary for BOTH directions: exposing a page with no session
 * required at all is a bigger unilateral decision than editing it, and
 * un-exposing it needs the identical floor rather than reusing `page:update`.
 *
 * Publishing takes a materialized snapshot exactly like `savePageVersion`
 * does (§3.7's own machinery, reused per §3.9's own words: "reusing the
 * `page_versions` machinery from §3.7 rather than a parallel mechanism"), but
 * with `kind = 'publish'` and by repointing `pages.published_version_id`
 * rather than merely appending to history. Re-publishing after an edit
 * writes a NEW snapshot and repoints the column; it never mutates a past
 * 'publish' row in place, so a version-history reader still sees exactly
 * what was live at each point in time.
 *
 * Unpublishing clears the pointer and timestamp only. The snapshot row
 * itself is left alone as ordinary version history — deleting it would
 * destroy a legitimate save point over a visibility change, and
 * `pages_public_read`/`page_versions_public_read` (migration 0026) key
 * their visibility off `pages.published_at`/`published_version_id`, not off
 * `kind = 'publish'` alone, so clearing those two columns is already
 * sufficient to take the page off the public route.
 */

export async function publishPage(
  actor: DocsActor,
  input: { readonly pageId: PageId },
): Promise<{ readonly versionId: string }> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const page = await loadPage(tx, input.pageId);
    enforceOnPage(actor, 'page:publish', page);

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

    await tx
      .update(schema.pages)
      .set({ publishedAt: new Date(), publishedVersionId: versionId, updatedAt: new Date() })
      .where(eq(schema.pages.id, input.pageId));

    await outboxWriter.append(tx, [
      createEvent(pagePublished, { pageId: input.pageId, versionId }, envelopeOf(actor)),
    ]);

    return { versionId };
  });
}

export async function unpublishPage(
  actor: DocsActor,
  input: { readonly pageId: PageId },
): Promise<void> {
  await withOrgScope(orgOf(actor), async (tx) => {
    const page = await loadPage(tx, input.pageId);
    enforceOnPage(actor, 'page:publish', page);

    await tx
      .update(schema.pages)
      .set({ publishedAt: null, publishedVersionId: null, updatedAt: new Date() })
      .where(eq(schema.pages.id, input.pageId));

    await outboxWriter.append(tx, [
      createEvent(pageUnpublished, { pageId: input.pageId }, envelopeOf(actor)),
    ]);
  });
}
