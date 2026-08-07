import { eq, schema, type withOrgScope } from '@taskflow/db';
import {
  errors,
  OrgIdSchema,
  type OrgId,
  type PageId,
  type RequestId,
  type SpaceId,
  type UserId,
} from '@taskflow/contracts';
import {
  enforce,
  type Permission,
  type ResourceRef,
  type Subject,
  type Target,
} from '@taskflow/policy';

/**
 * Shared plumbing for the Docs services (ai/phase-6-docs.md §3.1, §3.4, §3.5).
 *
 * ## The one idea in this file
 *
 * `pageTarget()` is the single place that turns a loaded page row into the
 * `can()` target that carries its inheritance chain, and every authorization
 * decision about a page — in this app and in `apps/collab`'s `onAuthenticate`
 * hook — goes through it. Never build a page `Target` inline, for the same
 * reason `chat/shared.ts` gives for channels: a second place that assembles
 * `ancestors` is a second place that can forget to.
 *
 * `ancestorIds` is already nearest-first on the row (migration 0023's own
 * invariant), which is exactly what `Target.ancestors` expects — this file's
 * whole job is mapping ids to `ResourceRef`s and appending the space as the
 * final fallback, never reordering anything.
 */

export interface DocsActor {
  readonly subject: Subject;
  readonly requestId: RequestId;
}

export function orgOf(actor: DocsActor): OrgId {
  return actor.subject.orgId;
}

export function userOf(actor: DocsActor): UserId {
  return actor.subject.userId;
}

export function envelopeOf(actor: DocsActor): {
  readonly orgId: OrgId;
  readonly actorId: UserId;
  readonly requestId: RequestId;
} {
  return { orgId: actor.subject.orgId, actorId: actor.subject.userId, requestId: actor.requestId };
}

type DocsTx = Parameters<Parameters<typeof withOrgScope>[1]>[0];

/* -------------------------------------------------------------------------- *
 * Spaces
 * -------------------------------------------------------------------------- */

export interface SpaceRow {
  readonly id: string;
  readonly orgId: string;
  readonly name: string;
  readonly archivedAt: Date | null;
}

/**
 * The `can()` target for a space.
 *
 * A space has no ancestors — it is the top of the tree — and it is not
 * `closed` the way a private channel is: `MEMBER` holds `space:read` from the
 * role matrix, so a space is open to the org by default and a tuple only ADDS
 * or CAPS access on top of that, exactly like Work's boards.
 */
export function spaceTarget(space: SpaceRow): Target {
  return {
    orgId: OrgIdSchema.parse(space.orgId),
    resource: { type: 'space', id: space.id },
    ancestors: [],
  };
}

export async function loadSpace(tx: DocsTx, spaceId: SpaceId): Promise<SpaceRow> {
  const rows = await tx
    .select({
      id: schema.spaces.id,
      orgId: schema.spaces.orgId,
      name: schema.spaces.name,
      archivedAt: schema.spaces.archivedAt,
    })
    .from(schema.spaces)
    .where(eq(schema.spaces.id, spaceId))
    .limit(1);

  const space = rows[0];
  if (!space) throw errors.notFound();
  return space;
}

export function enforceOnSpace(actor: DocsActor, permission: Permission, space: SpaceRow): void {
  enforce(actor.subject, permission, spaceTarget(space));
}

/* -------------------------------------------------------------------------- *
 * Pages
 * -------------------------------------------------------------------------- */

export interface PageRow {
  readonly id: string;
  readonly orgId: string;
  readonly spaceId: string;
  readonly parentPageId: string | null;
  readonly title: string;
  readonly rank: string;
  /** Nearest-first: `[immediate parent, grandparent, ..., root]`. */
  readonly ancestorIds: readonly string[];
  readonly archivedAt: Date | null;
  /** Both null or both set (Wave 4, §3.9) — see migration 0026's `pages_published_pair`. */
  readonly publishedVersionId: string | null;
  readonly publishedAt: Date | null;
}

/**
 * The `can()` target for a page: the page itself, its ancestor pages
 * nearest-first, and its space last as the final fallback — the exact chain
 * `nearestApplicable()` needs to find the nearest tuple, whichever level it
 * was granted at. Not `closed`, for the same reason `spaceTarget` isn't: a
 * page is readable by role membership unless a tuple caps it, not invisible
 * by default.
 */
export function pageTarget(page: PageRow): Target {
  const ancestors: ResourceRef[] = page.ancestorIds.map((id) => ({ type: 'page', id }));
  ancestors.push({ type: 'space', id: page.spaceId });

  return {
    orgId: OrgIdSchema.parse(page.orgId),
    resource: { type: 'page', id: page.id },
    ancestors,
  };
}

export async function loadPage(tx: DocsTx, pageId: PageId): Promise<PageRow> {
  const rows = await tx
    .select({
      id: schema.pages.id,
      orgId: schema.pages.orgId,
      spaceId: schema.pages.spaceId,
      parentPageId: schema.pages.parentPageId,
      title: schema.pages.title,
      rank: schema.pages.rank,
      ancestorIds: schema.pages.ancestorIds,
      archivedAt: schema.pages.archivedAt,
      publishedVersionId: schema.pages.publishedVersionId,
      publishedAt: schema.pages.publishedAt,
    })
    .from(schema.pages)
    .where(eq(schema.pages.id, pageId))
    .limit(1);

  const page = rows[0];
  if (!page) throw errors.notFound();
  return page;
}

export function enforceOnPage(actor: DocsActor, permission: Permission, page: PageRow): void {
  enforce(actor.subject, permission, pageTarget(page));
}
