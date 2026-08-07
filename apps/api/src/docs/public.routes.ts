import * as Y from 'yjs';
import type { FastifyInstance } from 'fastify';
import { eq, schema, withGlobalScope } from '@taskflow/db';
import { PageIdSchema } from '@taskflow/contracts';
import { renderPagePdf, renderPublicPage } from './render.js';

/**
 * The public docs route (ai/phase-6-docs.md §3.9, Wave 4).
 *
 * ⚠ HUMAN REVIEW SURFACE (§2.2) — the one place outside `apps/api/src/identity`
 * that calls `withGlobalScope`, and for the reason its own docstring already
 * named before this file existed: "reading a public share link." No
 * `Authorization` header, no `x-taskflow-org` header, no session at all — a
 * request here proves nothing about who is asking, by design.
 *
 * ## Why a page's visibility is the DATABASE's decision, not this file's
 *
 * This route does NOT check `page.publishedAt !== null` in application code
 * before deciding what to return. It runs the plain `SELECT` and lets
 * `docs.pages`'/`docs.page_versions`' `*_public_read` RLS policies (migration
 * 0026) decide what a connection with no `app.org_id` set is even allowed to
 * see. An unpublished page, an archived page, or a page in an org that never
 * existed all produce the identical outcome — zero rows, a 404 — through the
 * SAME code path, rather than this handler drawing its own parallel copy of
 * "is this visible" logic that could drift from what the database actually
 * enforces. That is the whole point of putting the check in RLS instead of
 * here: forgetting to ask the question here returns nothing, not another
 * org's page.
 *
 * ## No page tree, no navigation, no listing
 *
 * Deliberately narrower than a full public site: this route answers "render
 * THIS published page" and nothing else. There is no `/public/docs/spaces/:id`
 * or "list every published page in this org" — see `ai/phase-6-docs.md`'s §3.9
 * for why publish is scoped to one page at a time, and building a public tree
 * browser would be product surface this wave never scoped.
 */

async function loadPublished(
  pageId: string,
): Promise<{ readonly title: string; readonly fragment: Y.XmlFragment } | null> {
  // No org is known — see the file header. Every tenant table this touches
  // carries a `*_public_read` policy scoped to exactly this session state
  // (migration 0026); nothing else in `docs.pages`/`docs.page_versions` is
  // reachable from here.
  return withGlobalScope(async (tx) => {
    const pageRows = await tx
      .select({
        title: schema.pages.title,
        publishedVersionId: schema.pages.publishedVersionId,
      })
      .from(schema.pages)
      .where(eq(schema.pages.id, pageId))
      .limit(1);

    const page = pageRows[0];
    if (!page?.publishedVersionId) return null;

    const versionRows = await tx
      .select({ state: schema.pageVersions.state })
      .from(schema.pageVersions)
      .where(eq(schema.pageVersions.id, page.publishedVersionId))
      .limit(1);

    const version = versionRows[0];
    if (!version) return null;

    const doc = new Y.Doc();
    Y.applyUpdate(doc, version.state);

    return { title: page.title, fragment: doc.getXmlFragment('content') };
  });
}

export function registerPublicDocsRoutes(app: FastifyInstance): void {
  app.get('/public/docs/pages/:pageId', async (request, reply) => {
    const params = request.params as Record<string, unknown>;
    const parsed = PageIdSchema.safeParse(params['pageId']);
    if (!parsed.success) return reply.status(404).send({ error: 'not_found' });

    const published = await loadPublished(parsed.data);
    if (!published) return reply.status(404).send({ error: 'not_found' });

    return reply
      .header('content-type', 'text/html; charset=utf-8')
      .send(renderPublicPage({ title: published.title, fragment: published.fragment }));
  });

  app.get('/public/docs/pages/:pageId/export.pdf', async (request, reply) => {
    const params = request.params as Record<string, unknown>;
    const parsed = PageIdSchema.safeParse(params['pageId']);
    if (!parsed.success) return reply.status(404).send({ error: 'not_found' });

    const published = await loadPublished(parsed.data);
    if (!published) return reply.status(404).send({ error: 'not_found' });

    const pdf = await renderPagePdf({ title: published.title, fragment: published.fragment });

    return reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `inline; filename="${sanitizeFilename(published.title)}.pdf"`)
      .send(pdf);
  });
}

/** A filename derived from a page title — never trusted verbatim in a header. */
function sanitizeFilename(title: string): string {
  const cleaned = title.replaceAll(/[^a-zA-Z0-9 _-]/g, '').trim();
  return cleaned.length > 0 ? cleaned.slice(0, 100) : 'document';
}
