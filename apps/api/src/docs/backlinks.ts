import * as Y from 'yjs';
import { asc, eq, schema, withOrgScope } from '@taskflow/db';
import { isValidId, unsafeAsId, type PageId } from '@taskflow/contracts';
import { enforceOnPage, loadPage, orgOf, type DocsActor } from './shared.js';

/**
 * Internal-link extraction (ai/phase-6-docs.md §3.10, Wave 3).
 *
 * Walks a materialized document's content fragment for `pageLink` nodes —
 * the atomic, structured reference `work/richtext.ts` defines for exactly
 * this purpose (see that file's own note on why it is a node with a
 * validated `pageId`, not a `link` mark's `href`). `[[Page Name]]` wiki-link
 * SYNTAX — §3.10's other named form — needs name-to-id resolution against a
 * live page tree and has no editor UI to produce it yet; it is a named,
 * deliberate gap, not built speculatively ahead of the surface that would
 * create one.
 *
 * A client-submitted backlink list is never trusted, matching Phase 3's
 * `neighbours.ts` precedent (CLAUDE.md) for the identical reason: only the
 * server can see the actual, validated document, so this is the ONLY
 * function that decides what a page links to.
 */

/** Every distinct `pageId` a `pageLink` node in `fragment` names, self-references excluded. */
export function extractInternalLinks(
  fragment: Y.XmlFragment,
  sourcePageId: PageId,
): readonly PageId[] {
  const found = new Set<string>();
  walk(fragment, found);
  found.delete(sourcePageId);

  return [...found].map((id) => unsafeAsId<'PageId'>(id));
}

function walk(node: Y.XmlFragment | Y.XmlElement, found: Set<string>): void {
  for (const child of node.toArray()) {
    if (!(child instanceof Y.XmlElement)) continue;

    if (child.nodeName === 'pageLink') {
      const pageId = child.getAttribute('pageId');
      // Read back exactly as written by a client whose own content already
      // passed content-guard.ts's whitelist — but the guard runs on a
      // DEBOUNCE, so live, uncommitted state can carry something invalid for
      // as long as it takes to reach the next pass (§3.8's own named
      // limitation). Skipped rather than trusted.
      if (typeof pageId === 'string' && isValidId(pageId)) found.add(pageId);
    }

    walk(child, found);
  }
}

/* -------------------------------------------------------------------------- *
 * Reading backlinks back out — "what links here" (Wave 4 UI)
 * -------------------------------------------------------------------------- */

export interface BacklinkSummary {
  readonly sourcePageId: string;
  readonly sourceTitle: string;
  readonly sourceSpaceId: string;
}

/**
 * Every page that links TO `pageId`, by title. A plain join over
 * `docs.backlinks` (§3.10's edge list) and `docs.pages` — no per-row
 * `enforceOnPage`, the same convention `listPages` documents for itself:
 * Wave 1's baseline is org-role-open, capped by tuples rather than gated by
 * them, so a source page's title is exactly as visible here as it is in the
 * ordinary tree.
 */
export async function listBacklinks(
  actor: DocsActor,
  input: { readonly pageId: PageId },
): Promise<readonly BacklinkSummary[]> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const page = await loadPage(tx, input.pageId);
    enforceOnPage(actor, 'page:read', page);

    const rows = await tx
      .select({
        sourcePageId: schema.backlinks.sourcePageId,
        sourceTitle: schema.pages.title,
        sourceSpaceId: schema.pages.spaceId,
      })
      .from(schema.backlinks)
      .innerJoin(schema.pages, eq(schema.pages.id, schema.backlinks.sourcePageId))
      .where(eq(schema.backlinks.targetPageId, input.pageId))
      .orderBy(asc(schema.pages.title));

    return rows;
  });
}
