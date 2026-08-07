import {
  and,
  asc,
  eq,
  isNull,
  ne,
  schema,
  uuidArrayContains,
  withOrgScope,
  outboxWriter,
} from '@taskflow/db';
import {
  InvalidRankError,
  SpaceIdSchema,
  between,
  errors,
  type PageId,
  type SpaceId,
} from '@taskflow/contracts';
import { createEvent, type DomainEvent } from '@taskflow/events';
import { newId } from '@taskflow/security';
import { rebalancePageSiblings } from './rebalance.js';
import {
  pageArchived,
  pageCreated,
  pageMoved,
  pageSiblingsRebalanced,
  pageUpdated,
} from './events.js';
import {
  enforceOnPage,
  enforceOnSpace,
  envelopeOf,
  loadPage,
  loadSpace,
  orgOf,
  userOf,
  type DocsActor,
  type PageRow,
} from './shared.js';

/**
 * Pages — the tree (ai/phase-6-docs.md §3.1, §3.4, §3.5, Wave 1).
 *
 * `page:delete` is in the permission catalog and is used below for
 * archive/restore, exactly like `board:delete` gates Work's reversible
 * archive — but there is no HARD delete route here. §7.5 (trash / soft-delete
 * semantics — reuse Work's `deleted_at` pattern, or something else) is still
 * an open decision in the approved spec, and building a purge mechanism ahead
 * of that call would be guessing at product behaviour the spec itself says
 * isn't settled yet. Archiving is fully reversible regardless of how that
 * question resolves, so it does not need to wait on it.
 */

export async function listPages(
  actor: DocsActor,
  input: { readonly spaceId: SpaceId },
): Promise<readonly PageSummary[]> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const space = await loadSpace(tx, input.spaceId);
    enforceOnSpace(actor, 'space:read', space);

    const rows = await tx
      .select({
        id: schema.pages.id,
        parentPageId: schema.pages.parentPageId,
        title: schema.pages.title,
        rank: schema.pages.rank,
        archivedAt: schema.pages.archivedAt,
      })
      .from(schema.pages)
      .where(eq(schema.pages.spaceId, input.spaceId))
      .orderBy(asc(schema.pages.rank), asc(schema.pages.id));

    /* Flat, not a tree — the client groups by `parentPageId` and sorts each
       group by `rank`, exactly how Work's board rendering groups cards by
       `listId` client-side rather than the server shipping a nested shape. No
       server-side `enforce` per row: everyone who can read the space can read
       every page in it unless a CLOSED tuple says otherwise, and Wave 1 does
       not use `closed` on pages (§3.1's baseline is org-role-open, capped by
       tuples, not gated by them) — see `pageTarget`'s own note. */
    return rows.map((row) => ({
      pageId: row.id,
      parentPageId: row.parentPageId,
      title: row.title,
      rank: row.rank,
      archivedAt: row.archivedAt,
    }));
  });
}

interface PageSummary {
  readonly pageId: string;
  readonly parentPageId: string | null;
  readonly title: string;
  readonly rank: string;
  readonly archivedAt: Date | null;
}

export async function createPage(
  actor: DocsActor,
  input: {
    readonly spaceId: SpaceId;
    readonly parentPageId: PageId | null;
    readonly title: string;
  },
): Promise<{ readonly pageId: PageId }> {
  const pageId = newId<'PageId'>();
  const orgId = orgOf(actor);

  await withOrgScope(orgId, async (tx) => {
    const space = await loadSpace(tx, input.spaceId);
    let ancestorIds: readonly string[] = [];

    if (input.parentPageId !== null) {
      const parent = await loadPage(tx, input.parentPageId);
      if (parent.spaceId !== input.spaceId) {
        throw errors.validation(
          { parentPageId: 'That page belongs to a different space.' },
          'A page cannot be created under a page in another space.',
        );
      }
      if (parent.archivedAt !== null) {
        throw errors.validation(
          { parentPageId: 'That page is archived.' },
          'A page cannot be created under an archived page.',
        );
      }
      // The chain that matters is the PARENT's — a grant on the parent (or one
      // of ITS ancestors) is what "may create a child here" is asking about.
      enforceOnPage(actor, 'page:create', parent);
      ancestorIds = [parent.id, ...parent.ancestorIds];
    } else {
      enforceOnSpace(actor, 'page:create', space);
    }

    const siblings = await loadPageSiblings(tx, input.spaceId, input.parentPageId, null);
    const rank = between(siblings.at(-1)?.rank ?? null, null);

    await tx.insert(schema.pages).values({
      id: pageId,
      orgId,
      spaceId: input.spaceId,
      parentPageId: input.parentPageId,
      title: input.title,
      rank,
      ancestorIds: [...ancestorIds],
      createdBy: userOf(actor),
    });

    await outboxWriter.append(tx, [
      createEvent(
        pageCreated,
        { pageId, spaceId: input.spaceId, parentPageId: input.parentPageId, title: input.title },
        envelopeOf(actor),
      ),
    ]);
  });

  return { pageId };
}

export async function updatePage(
  actor: DocsActor,
  input: { readonly pageId: PageId; readonly title: string },
): Promise<void> {
  await withOrgScope(orgOf(actor), async (tx) => {
    const page = await loadPage(tx, input.pageId);
    enforceOnPage(actor, 'page:update', page);

    if (page.title === input.title) return;

    await tx
      .update(schema.pages)
      .set({ title: input.title, updatedAt: new Date() })
      .where(eq(schema.pages.id, input.pageId));

    await outboxWriter.append(tx, [
      createEvent(
        pageUpdated,
        { pageId: input.pageId, before: { title: page.title }, after: { title: input.title } },
        envelopeOf(actor),
      ),
    ]);
  });
}

export async function archivePage(
  actor: DocsActor,
  input: { readonly pageId: PageId; readonly restore: boolean },
): Promise<void> {
  await withOrgScope(orgOf(actor), async (tx) => {
    const page = await loadPage(tx, input.pageId);
    enforceOnPage(actor, 'page:delete', page);

    await tx
      .update(schema.pages)
      .set({ archivedAt: input.restore ? null : new Date(), updatedAt: new Date() })
      .where(eq(schema.pages.id, input.pageId));

    await outboxWriter.append(tx, [
      createEvent(
        pageArchived,
        { pageId: input.pageId, restored: input.restore },
        envelopeOf(actor),
      ),
    ]);
  });
}

export async function movePage(
  actor: DocsActor,
  input: {
    readonly pageId: PageId;
    readonly targetParentId: PageId | null;
    readonly beforePageId: PageId | null;
    readonly afterPageId: PageId | null;
  },
): Promise<{ readonly rank: string; readonly rebalanced: boolean }> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const page = await loadPage(tx, input.pageId);
    enforceOnPage(actor, 'page:update', page);

    // Branded once here — `PageRow.spaceId` is a plain string off the Drizzle
    // row, and every call below that requires `SpaceId` is the trust boundary
    // for it, same reasoning as `pageTarget`'s `OrgIdSchema.parse`.
    const spaceId = SpaceIdSchema.parse(page.spaceId);

    let newParent: PageRow | null = null;

    if (input.targetParentId !== null) {
      if (input.targetParentId === page.id) {
        throw errors.validation(
          { targetParentId: 'A page cannot be its own parent.' },
          'That move is not possible.',
        );
      }

      newParent = await loadPage(tx, input.targetParentId);

      if (newParent.spaceId !== page.spaceId) {
        throw errors.validation(
          { targetParentId: 'That page belongs to a different space.' },
          'A page cannot be moved to another space.',
        );
      }

      /* Moving a page under its own descendant would create a cycle — the
         descendant's ancestor_ids already contains this page's id, which is
         exactly the check that catches it without a recursive query. */
      if (newParent.ancestorIds.includes(page.id)) {
        throw errors.validation(
          { targetParentId: 'A page cannot be moved under its own descendant.' },
          'That move would create a cycle.',
        );
      }

      /* The DESTINATION is authorized separately from the source, mirroring
         `moveCard`'s two-sided check — holding `page:update` on the page being
         moved must not imply the caller may place it anywhere. `page:create`
         is what "may put a page here" actually means. */
      enforceOnPage(actor, 'page:create', newParent);
    } else {
      const space = await loadSpace(tx, spaceId);
      enforceOnSpace(actor, 'page:create', space);
    }

    const newAncestorIds: readonly string[] = newParent
      ? [newParent.id, ...newParent.ancestorIds]
      : [];
    const reparented = (page.parentPageId ?? null) !== (input.targetParentId ?? null);

    let rank: string;
    let rebalancedCount: number | null = null;

    const siblings = await loadPageSiblings(tx, spaceId, input.targetParentId, input.pageId);
    try {
      rank = between(
        rankOfNeighbour(siblings, input.beforePageId),
        rankOfNeighbour(siblings, input.afterPageId),
      );
    } catch (error) {
      if (!(error instanceof InvalidRankError)) throw error;

      rebalancedCount = await rebalancePageSiblings(tx, spaceId, input.targetParentId);

      const repaired = await loadPageSiblings(tx, spaceId, input.targetParentId, input.pageId);
      rank = between(
        rankOfNeighbour(repaired, input.beforePageId),
        rankOfNeighbour(repaired, input.afterPageId),
      );
    }

    if (reparented) {
      // Rewrite every descendant's materialized path BEFORE the page's own
      // row changes, using the OLD ancestor prefix — `@>` finds them
      // regardless of where in the array the id sits. §3.5's own words: "a
      // single row missed in that rewrite is a silent privilege bug ... that
      // nothing detects until someone notices."
      const descendants = await tx
        .select({ id: schema.pages.id, ancestorIds: schema.pages.ancestorIds })
        .from(schema.pages)
        .where(
          and(
            eq(schema.pages.spaceId, spaceId),
            uuidArrayContains(schema.pages.ancestorIds, page.id),
          ),
        );

      for (const descendant of descendants) {
        const cutIndex = descendant.ancestorIds.indexOf(page.id);
        if (cutIndex === -1) continue;
        const rewritten = [
          ...descendant.ancestorIds.slice(0, cutIndex),
          page.id,
          ...newAncestorIds,
        ];
        await tx
          .update(schema.pages)
          .set({ ancestorIds: rewritten, updatedAt: new Date() })
          .where(eq(schema.pages.id, descendant.id));
      }
    }

    await tx
      .update(schema.pages)
      .set({
        parentPageId: input.targetParentId,
        rank,
        ancestorIds: [...newAncestorIds],
        updatedAt: new Date(),
      })
      .where(eq(schema.pages.id, input.pageId));

    // Typed as the general envelope rather than inferred from the first
    // element, so the conditional push below is not a type error — mirrors
    // `moveCard`'s identical `const events: DomainEvent[]` in card.service.ts.
    const events: DomainEvent[] = [
      createEvent(
        pageMoved,
        {
          pageId: input.pageId,
          spaceId,
          fromParentPageId: page.parentPageId,
          toParentPageId: input.targetParentId,
          rank,
        },
        envelopeOf(actor),
      ),
    ];
    if (rebalancedCount !== null) {
      events.push(
        createEvent(
          pageSiblingsRebalanced,
          { spaceId, parentPageId: input.targetParentId, count: rebalancedCount },
          envelopeOf(actor),
        ),
      );
    }
    await outboxWriter.append(tx, events);

    return { rank, rebalanced: rebalancedCount !== null };
  });
}

interface Sibling {
  readonly pageId: string;
  readonly rank: string;
}

/** Every other live page under the same parent, in order. */
async function loadPageSiblings(
  tx: Parameters<Parameters<typeof withOrgScope>[1]>[0],
  spaceId: SpaceId,
  parentPageId: PageId | null,
  excluding: PageId | null,
): Promise<readonly Sibling[]> {
  const parentCondition =
    parentPageId === null
      ? isNull(schema.pages.parentPageId)
      : eq(schema.pages.parentPageId, parentPageId);

  return tx
    .select({ pageId: schema.pages.id, rank: schema.pages.rank })
    .from(schema.pages)
    .where(
      and(
        eq(schema.pages.spaceId, spaceId),
        parentCondition,
        isNull(schema.pages.archivedAt),
        excluding === null ? undefined : ne(schema.pages.id, excluding),
      ),
    )
    .orderBy(asc(schema.pages.rank), asc(schema.pages.id));
}

/**
 * The rank of a named neighbour. A neighbour that is not among the true
 * siblings is a stale client — the page was moved or archived between the
 * tree being rendered and the drag finishing. 404 rather than a guess, for
 * the identical reason `rankOfNeighbour` in `card.service.ts` gives.
 */
function rankOfNeighbour(siblings: readonly Sibling[], pageId: PageId | null): string | null {
  if (pageId === null) return null;
  const sibling = siblings.find((row) => row.pageId === pageId);
  if (!sibling) throw errors.notFound();
  return sibling.rank;
}
