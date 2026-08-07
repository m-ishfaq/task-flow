import { and, desc, eq, schema, withOrgScope } from '@taskflow/db';
import { errors, type PageId } from '@taskflow/contracts';
import { enforceOnPage, loadPage, orgOf, type DocsActor } from './shared.js';
import { materializeCurrentState } from './page-version.service.js';
import { renderState } from './render.js';
import { renderPdf } from './pdf.js';

/**
 * PDF export's "which content" resolution (ai/phase-6-docs.md §3.9, Wave 4).
 * The rendering itself is `pdf.ts` (pure) and `render.ts` (Yjs -> JSON); this
 * file is only the DB-facing "pick the right snapshot" step, kept separate
 * from `page-version.service.ts` because it authorizes at `page:read`
 * (exporting is a read, like `attachment:download`), not `page:update`.
 *
 * `versionId: null` means "the latest saved version" — NOT current live
 * content. The one exception, named rather than hidden: a page with a
 * currently-open live editing session that has not yet reached its first
 * compaction cycle has no `page_versions` row at all yet, and there is
 * therefore no non-live snapshot to prefer over `materializeCurrentState`.
 * That is not a violation of "never live state" so much as there being
 * nothing else available in that specific window.
 */

const FILENAME_UNSAFE = /[/\\:*?"<>|]/g;

function filenameOf(title: string): string {
  const safe = title.replace(FILENAME_UNSAFE, '_').trim();
  return `${safe.length > 0 ? safe : 'Untitled'}.pdf`;
}

export async function exportPagePdf(
  actor: DocsActor,
  input: { readonly pageId: PageId; readonly versionId: string | null },
): Promise<{ readonly filename: string; readonly bytes: Uint8Array }> {
  const { title, state } = await withOrgScope(orgOf(actor), async (tx) => {
    const page = await loadPage(tx, input.pageId);
    enforceOnPage(actor, 'page:read', page);

    if (input.versionId !== null) {
      const rows = await tx
        .select({ state: schema.pageVersions.state })
        .from(schema.pageVersions)
        .where(
          and(eq(schema.pageVersions.id, input.versionId), eq(schema.pageVersions.pageId, input.pageId)),
        )
        .limit(1);
      const version = rows[0];
      if (!version) throw errors.notFound();
      return { title: page.title, state: version.state };
    }

    const latestRows = await tx
      .select({ state: schema.pageVersions.state })
      .from(schema.pageVersions)
      .where(eq(schema.pageVersions.pageId, input.pageId))
      .orderBy(desc(schema.pageVersions.createdAt))
      .limit(1);
    const latest = latestRows[0];
    if (latest) return { title: page.title, state: latest.state };

    return {
      title: page.title,
      state: Buffer.from(await materializeCurrentState(tx, input.pageId)),
    };
  });

  const bytes = await renderPdf(title, renderState(state));
  return { filename: filenameOf(title), bytes };
}
