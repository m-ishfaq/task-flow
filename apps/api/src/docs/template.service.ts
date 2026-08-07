import { and, eq, schema, withOrgScope, outboxWriter } from '@taskflow/db';
import {
  errors,
  SpaceIdSchema,
  type PageId,
  type PageTemplateId,
  type SpaceId,
} from '@taskflow/contracts';
import { createEvent } from '@taskflow/events';
import { uuidv7 } from '@taskflow/security';
import { pageTemplateCreated, pageTemplateDeleted, pageVersionSaved } from './events.js';
import { materializeCurrentState } from './page-version.service.js';
import * as pages from './page.service.js';
import {
  enforceOnSpace,
  envelopeOf,
  loadPage,
  loadSpace,
  orgOf,
  userOf,
  type DocsActor,
} from './shared.js';

/**
 * Page templates (ai/phase-6-docs.md §5, Wave 4) — "page_versions-shaped
 * seed content" for a space, per migration 0026's own header.
 *
 * ## Why `space:manage` / `space:read`, and no new permission
 *
 * A template is the space's reusable vocabulary for creating new pages in
 * it — the identical relationship a project's label set or custom field
 * DEFINITIONS have to its cards (`card.service.ts`'s own "two authorization
 * questions, deliberately not merged" note): managing the vocabulary is a
 * space-level capability, using it is not. `createPageFromTemplate` needs
 * nothing beyond the `page:create` a plain `pages.createPage` call already
 * requires — a template is just where the starting content came from, not a
 * new thing to be authorized. `space:manage` already exists (Wave 1,
 * `spaces.archive`'s own permission) and `space:read` covers `list`, so this
 * file adds no entry to `packages/policy`'s catalog, the role matrix, or its
 * matrix test at all — the three-place change `permissions.ts`'s header
 * describes never triggers, because there was nothing here that needed a
 * fourth tier.
 *
 * ## Why `createPageFromTemplate` is two transactions, not one
 *
 * Every other service in this directory does its own single `withOrgScope`
 * transaction — nothing in `apps/api/src/docs` currently calls INTO another
 * resource's service function (`router.ts` is the only place that imports
 * more than one), and reimplementing `pages.createPage`'s rank/ancestor-path
 * logic here instead would be exactly the "second place that assembles
 * ancestors is a second place that can forget to" trap `shared.ts`'s own
 * header warns about for `pageTarget`. So this calls `pages.createPage`
 * (its own transaction, authorized on its own terms) and then seeds the new
 * page's first `page_versions` row in a SECOND transaction. The accepted
 * cost, named rather than hidden: a crash between the two leaves a real,
 * empty page with no seeded content — never a corrupted or partially-tree'd
 * one, since the first transaction is already fully committed and valid on
 * its own. That failure mode is strictly milder than what a shared
 * rank-computation bug could produce, which is why the split was chosen
 * over the reuse.
 */

export interface TemplateSummary {
  readonly templateId: string;
  readonly spaceId: string;
  readonly name: string;
  readonly createdBy: string | null;
  readonly createdAt: Date;
}

export async function listTemplates(
  actor: DocsActor,
  input: { readonly spaceId: SpaceId },
): Promise<readonly TemplateSummary[]> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const space = await loadSpace(tx, input.spaceId);
    enforceOnSpace(actor, 'space:read', space);

    const rows = await tx
      .select({
        id: schema.pageTemplates.id,
        spaceId: schema.pageTemplates.spaceId,
        name: schema.pageTemplates.name,
        createdBy: schema.pageTemplates.createdBy,
        createdAt: schema.pageTemplates.createdAt,
      })
      .from(schema.pageTemplates)
      .where(eq(schema.pageTemplates.spaceId, input.spaceId))
      .orderBy(schema.pageTemplates.name);

    return rows.map((row) => ({
      templateId: row.id,
      spaceId: row.spaceId,
      name: row.name,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
    }));
  });
}

export async function createTemplateFromPage(
  actor: DocsActor,
  input: { readonly pageId: PageId; readonly name: string },
): Promise<{ readonly templateId: string }> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const page = await loadPage(tx, input.pageId);
    const space = await loadSpace(tx, SpaceIdSchema.parse(page.spaceId));
    enforceOnSpace(actor, 'space:manage', space);

    const state = await materializeCurrentState(tx, input.pageId);
    const templateId = uuidv7();

    await tx.insert(schema.pageTemplates).values({
      id: templateId,
      orgId: orgOf(actor),
      spaceId: page.spaceId,
      name: input.name,
      state: Buffer.from(state),
      createdBy: userOf(actor),
    });

    await outboxWriter.append(tx, [
      createEvent(
        pageTemplateCreated,
        { templateId, spaceId: page.spaceId, name: input.name },
        envelopeOf(actor),
      ),
    ]);

    return { templateId };
  });
}

export async function deleteTemplate(
  actor: DocsActor,
  input: { readonly templateId: PageTemplateId },
): Promise<void> {
  await withOrgScope(orgOf(actor), async (tx) => {
    const rows = await tx
      .select({ id: schema.pageTemplates.id, spaceId: schema.pageTemplates.spaceId })
      .from(schema.pageTemplates)
      .where(eq(schema.pageTemplates.id, input.templateId))
      .limit(1);

    const template = rows[0];
    if (!template) throw errors.notFound();

    const space = await loadSpace(tx, SpaceIdSchema.parse(template.spaceId));
    enforceOnSpace(actor, 'space:manage', space);

    await tx.delete(schema.pageTemplates).where(eq(schema.pageTemplates.id, input.templateId));

    await outboxWriter.append(tx, [
      createEvent(
        pageTemplateDeleted,
        { templateId: input.templateId, spaceId: template.spaceId },
        envelopeOf(actor),
      ),
    ]);
  });
}

export async function createPageFromTemplate(
  actor: DocsActor,
  input: {
    readonly spaceId: SpaceId;
    readonly parentPageId: PageId | null;
    readonly title: string;
    readonly templateId: PageTemplateId;
  },
): Promise<{ readonly pageId: PageId }> {
  const state = await withOrgScope(orgOf(actor), async (tx) => {
    const rows = await tx
      .select({ state: schema.pageTemplates.state, spaceId: schema.pageTemplates.spaceId })
      .from(schema.pageTemplates)
      .where(
        and(
          eq(schema.pageTemplates.id, input.templateId),
          eq(schema.pageTemplates.spaceId, input.spaceId),
        ),
      )
      .limit(1);

    const template = rows[0];
    if (!template) throw errors.notFound();
    return template.state;
  });

  const { pageId } = await pages.createPage(actor, {
    spaceId: input.spaceId,
    parentPageId: input.parentPageId,
    title: input.title,
  });

  await withOrgScope(orgOf(actor), async (tx) => {
    const versionId = uuidv7();

    await tx.insert(schema.pageVersions).values({
      id: versionId,
      orgId: orgOf(actor),
      pageId,
      kind: 'manual',
      state: Buffer.from(state),
      createdBy: userOf(actor),
    });

    // A real page_versions row was written, the identical fact
    // `pageVersions.save` reports — see `page-version.service.ts`'s own
    // `savePageVersion`. Reused rather than a new event: "content was seeded
    // from a template" is not a distinct enough fact from "a version was
    // saved" for a consumer (search indexing, notifications) to need to
    // treat it differently.
    await outboxWriter.append(tx, [
      createEvent(pageVersionSaved, { pageId, versionId }, envelopeOf(actor)),
    ]);
  });

  return { pageId };
}
