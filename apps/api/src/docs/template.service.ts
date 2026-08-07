import { and, asc, eq, isNull, schema, withOrgScope, outboxWriter } from '@taskflow/db';
import { errors, type PageId, type SpaceId, type TemplateId } from '@taskflow/contracts';
import { createEvent } from '@taskflow/events';
import { enforce } from '@taskflow/policy';
import { newId, uuidv7 } from '@taskflow/security';
import { pageVersionSaved, templateArchived, templateCreated } from './events.js';
import { materializeCurrentState } from './page-version.service.js';
import { createPage } from './page.service.js';
import { enforceOnPage, envelopeOf, loadPage, orgOf, userOf, type DocsActor } from './shared.js';

/**
 * Page templates (ai/phase-6-docs.md §5, Wave 4).
 *
 * §5's own words: "almost certainly a `page_versions`-shaped 'seed content'
 * concept rather than new machinery" — a template's `state` is a full
 * materialized Yjs snapshot, the identical shape `page_versions.state`
 * already uses, captured with the same `materializeCurrentState` helper
 * `savePageVersion` and `publishPage` both call. It is a DETACHED copy, not
 * a live reference: migration 0026's own header explains why templates are
 * their own table rather than `page_versions` rows (those cascade-delete
 * with their source page; a template must outlive it).
 *
 * ## Authorization has no per-template resource
 *
 * A template is an org-wide reusable asset, not something a tuple can point
 * at (`RESOURCE_TYPES` has no `template` entry — see `page.published`'s own
 * note in `tenancy/audit.projection.ts` for why that is deliberate, mirroring
 * `page.version_saved`'s "no independently grantable version" precedent).
 * `createTemplate`/`listTemplates` are role-only `enforce()` calls with no
 * target — the same shape `channel:create` uses in `chat/channel.service.ts`
 * for the identical reason: there is no resource row yet to load a `Target`
 * from. `createTemplate` ALSO enforces `page:read` on the source page itself,
 * since reading its content to snapshot is a second, real authorization
 * question independent of "may I create templates at all". Archiving is
 * `page:delete` rather than `page:create` — admin/owner only, matching the
 * moderation-tier split `comment:delete` draws elsewhere in this codebase:
 * any member may add a reusable template, only an admin or owner may retire
 * one that other members might be relying on.
 */

export interface TemplateSummary {
  readonly templateId: string;
  readonly name: string;
  readonly description: string | null;
  readonly sourcePageId: string | null;
  readonly createdBy: string | null;
  readonly createdAt: Date;
  readonly archivedAt: Date | null;
}

export async function listTemplates(actor: DocsActor): Promise<readonly TemplateSummary[]> {
  enforce(actor.subject, 'page:read');

  return withOrgScope(orgOf(actor), async (tx) => {
    const rows = await tx
      .select({
        id: schema.templates.id,
        name: schema.templates.name,
        description: schema.templates.description,
        sourcePageId: schema.templates.sourcePageId,
        createdBy: schema.templates.createdBy,
        createdAt: schema.templates.createdAt,
        archivedAt: schema.templates.archivedAt,
      })
      .from(schema.templates)
      .where(isNull(schema.templates.archivedAt))
      .orderBy(asc(schema.templates.name));

    return rows.map((row) => ({
      templateId: row.id,
      name: row.name,
      description: row.description,
      sourcePageId: row.sourcePageId,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
      archivedAt: row.archivedAt,
    }));
  });
}

export async function createTemplate(
  actor: DocsActor,
  input: {
    readonly name: string;
    readonly description: string | null;
    readonly sourcePageId: PageId;
  },
): Promise<{ readonly templateId: TemplateId }> {
  enforce(actor.subject, 'page:create');

  return withOrgScope(orgOf(actor), async (tx) => {
    const sourcePage = await loadPage(tx, input.sourcePageId);
    enforceOnPage(actor, 'page:read', sourcePage);

    const state = await materializeCurrentState(tx, input.sourcePageId);
    const templateId = newId<'TemplateId'>();

    await tx.insert(schema.templates).values({
      id: templateId,
      orgId: orgOf(actor),
      name: input.name,
      description: input.description,
      state: Buffer.from(state),
      sourcePageId: input.sourcePageId,
      createdBy: userOf(actor),
    });

    await outboxWriter.append(tx, [
      createEvent(templateCreated, { templateId, name: input.name }, envelopeOf(actor)),
    ]);

    return { templateId };
  });
}

export async function archiveTemplate(
  actor: DocsActor,
  input: { readonly templateId: TemplateId; readonly restore: boolean },
): Promise<void> {
  enforce(actor.subject, 'page:delete');

  await withOrgScope(orgOf(actor), async (tx) => {
    const rows = await tx
      .select({ id: schema.templates.id })
      .from(schema.templates)
      .where(eq(schema.templates.id, input.templateId))
      .limit(1);
    if (!rows[0]) throw errors.notFound();

    await tx
      .update(schema.templates)
      .set({ archivedAt: input.restore ? null : new Date() })
      .where(eq(schema.templates.id, input.templateId));

    await outboxWriter.append(tx, [
      createEvent(
        templateArchived,
        { templateId: input.templateId, restored: input.restore },
        envelopeOf(actor),
      ),
    ]);
  });
}

/**
 * Creates a page seeded with a template's content.
 *
 * ## Not one atomic transaction, and that is a named limitation
 *
 * Tree insertion is `page.service.ts#createPage` ITSELF, called rather than
 * reimplemented — the authorization, rank, and ancestor-chain rules a new
 * page needs are exactly what that function already enforces, and a second
 * copy here would be precisely the drift risk `pageTarget()`'s own header
 * warns about ("a second place that assembles ancestors is a second place
 * that can forget to"). It commits in its own `withOrgScope` transaction,
 * and the content seed below runs in a second one — a crash between them
 * leaves a real, authorized, empty page with no seeded version, a
 * legitimate and fully repairable state (the page opens empty, exactly like
 * one created without a template), never a security or tenancy defect. The
 * same category of trade-off `restorePageVersion`'s own header names for a
 * live session not observing a restore: a known limitation, named rather
 * than assumed away.
 */
export async function createPageFromTemplate(
  actor: DocsActor,
  input: {
    readonly spaceId: SpaceId;
    readonly parentPageId: PageId | null;
    readonly title: string;
    readonly templateId: TemplateId;
  },
): Promise<{ readonly pageId: PageId }> {
  const orgId = orgOf(actor);

  const template = await withOrgScope(orgId, async (tx) => {
    const rows = await tx
      .select({ state: schema.templates.state })
      .from(schema.templates)
      .where(and(eq(schema.templates.id, input.templateId), isNull(schema.templates.archivedAt)))
      .limit(1);
    const row = rows[0];
    if (!row) throw errors.notFound();
    return row;
  });

  const { pageId } = await createPage(actor, {
    spaceId: input.spaceId,
    parentPageId: input.parentPageId,
    title: input.title,
  });

  await withOrgScope(orgId, async (tx) => {
    const versionId = uuidv7();

    await tx.insert(schema.pageVersions).values({
      id: versionId,
      orgId,
      pageId,
      kind: 'manual',
      state: template.state,
      createdBy: userOf(actor),
    });

    await outboxWriter.append(tx, [
      createEvent(pageVersionSaved, { pageId, versionId }, envelopeOf(actor)),
    ]);
  });

  return { pageId };
}
