import { and, eq, schema, withOrgScope } from '@taskflow/db';
import { errors, type OrgId, type PageId } from '@taskflow/contracts';
import { renderState, type RenderedNode } from './render.js';

/**
 * The anonymous, no-session read path for a published page (ai/phase-6-docs.md
 * §3.9, Wave 4).
 *
 * ## Why this takes `orgId` as a plain input, with no `DocsActor` anywhere
 *
 * Every other file in this directory authorizes through `can()`/`enforce()`
 * over a `Subject` derived from a verified token — there is no token here at
 * all, by design (`publicRoute`, `apps/api/src/trpc/builder.ts`). What makes
 * this safe without one is the identical reasoning
 * `ai/phase-4-realtime.md`'s own note gives for the realtime gateway's
 * client-supplied join org id: `orgId` here is nothing more than a WHERE
 * filter consumed by `withOrgScope`'s RLS session variable, never written to
 * `app.org_id` as a claim of membership and never used to derive a role. A
 * caller naming a real org and a real page that is not, in fact, published
 * gets exactly the same NOT_FOUND as a caller naming a nonexistent org or a
 * nonexistent page — there is nothing about this response that leaks whether
 * the org exists, whether the page exists, or why either failed, matching
 * `attachment.service.ts`'s own precedent of collapsing "not found" and
 * "found but not visible to you" into one answer.
 *
 * A page is visible here if and only if `published_version_id IS NOT NULL`
 * AND the page is not archived. Archived-but-still-published is a real state
 * the schema allows (archiving does not auto-unpublish — see
 * `publish.service.ts`), and serving it publicly while it is excluded from
 * the org's own tree and search (§7.5's now-decided archive semantics) would
 * make "archived" a lie for the one audience with no session to notice.
 *
 * Content is rendered from the PUBLISHED version's own snapshot — never
 * `materializeCurrentState` (current live content), which is the entire
 * point §3.9 makes: a public reader must never observe a page mid-edit.
 */

export interface PublishedPage {
  readonly pageId: string;
  readonly title: string;
  readonly publishedAt: string;
  readonly content: RenderedNode;
}

export async function getPublishedPage(input: {
  readonly orgId: OrgId;
  readonly pageId: PageId;
}): Promise<PublishedPage> {
  return withOrgScope(input.orgId, async (tx) => {
    const rows = await tx
      .select({
        title: schema.pages.title,
        archivedAt: schema.pages.archivedAt,
        publishedVersionId: schema.pages.publishedVersionId,
        publishedAt: schema.pages.publishedAt,
      })
      .from(schema.pages)
      .where(eq(schema.pages.id, input.pageId))
      .limit(1);

    const page = rows[0];
    if (!page?.publishedVersionId || page.archivedAt !== null || page.publishedAt === null) {
      throw errors.notFound();
    }

    const versionRows = await tx
      .select({ state: schema.pageVersions.state })
      .from(schema.pageVersions)
      .where(
        and(eq(schema.pageVersions.id, page.publishedVersionId), eq(schema.pageVersions.pageId, input.pageId)),
      )
      .limit(1);

    const version = versionRows[0];
    // The composite FK (migration 0026) makes this unreachable in practice —
    // named rather than silently coerced, the same defensive-but-honest shape
    // `restorePageVersion`'s own NOT_FOUND-on-missing-version has.
    if (!version) throw errors.notFound();

    return {
      pageId: input.pageId,
      title: page.title,
      publishedAt: page.publishedAt.toISOString(),
      content: renderState(version.state),
    };
  });
}
