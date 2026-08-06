import * as Y from 'yjs';
import { isValidId, unsafeAsId, type PageId } from '@taskflow/contracts';

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
export function extractInternalLinks(fragment: Y.XmlFragment, sourcePageId: PageId): readonly PageId[] {
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
