import type { Wire } from '@taskflow/client';
import type { MobileTRPCClient } from './trpc-client.js';

/**
 * Docs (Phase 6) — spaces and the page tree, ported as STRUCTURE only.
 * Types, query keys, and the one genuinely testable piece of logic
 * (`buildPageTree`) — no `react-native` import anywhere in this file, the
 * same split every other feature's lib file establishes.
 *
 * **What this pass does NOT port: reading or writing a page's actual
 * content, publishing, comments, suggestions, backlinks, templates, or PDF
 * export.** Every one of those needs the SAME thing underneath: a live Yjs
 * document, synced over `apps/collab`'s Hocuspocus WebSocket protocol
 * (`onAuthenticate`, snapshot-plus-tail replay on load) — there is no
 * `pages.getContent`-style REST route to fall back on. `pages.list`
 * returns tree metadata only (`pageId`, `parentPageId`, `title`, `rank`,
 * `archivedAt`, `publishedAt`) and `pageVersions.list` returns version
 * METADATA only (`versionId`, `kind`, `createdBy`, `createdAt`) — neither
 * carries the document body. Building a real Yjs client for React Native
 * (the `yjs` package itself is pure JS and would run, but the WebSocket
 * handshake, snapshot replay, and converting a `Y.XmlFragment` into
 * something this app can render are all genuinely new, substantial
 * infrastructure) is real, dedicated work — the Phase 8 TQL/filter-builder
 * kind of gap, not a corner cut from this pass. Publish is deliberately
 * left out too, even though it is just a metadata flip with no content
 * dependency: publishing something you cannot read on this device to
 * check first is the wrong order to ship those two capabilities in.
 *
 * What ships instead is a complete, honest slice on its own terms:
 * organize a Docs space from a phone — create spaces, create pages, see
 * the tree, rename, move, archive/restore — the same way `automation.ts`'s
 * own header draws its line at "view, toggle, delete" rather than
 * pretending at a builder it cannot fully back.
 */

export type Space = Wire<
  Awaited<ReturnType<MobileTRPCClient['docs']['spaces']['list']['query']>>
>[number];

export type Page = Wire<
  Awaited<ReturnType<MobileTRPCClient['docs']['pages']['list']['query']>>
>[number];

export const SPACES_QUERY_KEY = ['docs.spaces.list'] as const;

export function pagesQueryKey(spaceId: string): readonly ['docs.pages.list', string] {
  return ['docs.pages.list', spaceId];
}

/** One page, positioned in the tree — `depth` is how deeply nested it is
 *  (0 = top level), which is what a flat `FlatList` needs to render
 *  indentation without recursion. */
export interface PageTreeRow {
  readonly page: Page;
  readonly depth: number;
}

/**
 * Flattens `docs.pages.list`'s flat, parent-pointer rows into a
 * depth-annotated, rank-ordered list a `FlatList` can render directly —
 * the mobile equivalent of the recursive tree component web's page-tree
 * sidebar renders, since a `FlatList` has no native concept of nested
 * children.
 *
 * Ordering is `rank` — the same base62 scheme `packages/contracts/rank.ts`
 * uses for Work cards, lexicographically comparable as plain strings — so
 * siblings sort correctly without any numeric parsing.
 */
export function buildPageTree(pages: readonly Page[]): readonly PageTreeRow[] {
  const byParent = new Map<string | null, Page[]>();
  for (const page of pages) {
    const bucket = byParent.get(page.parentPageId);
    if (bucket) {
      bucket.push(page);
    } else {
      byParent.set(page.parentPageId, [page]);
    }
  }
  for (const bucket of byParent.values()) {
    bucket.sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0));
  }

  const rows: PageTreeRow[] = [];
  const visit = (parentId: string | null, depth: number): void => {
    for (const page of byParent.get(parentId) ?? []) {
      rows.push({ page, depth });
      visit(page.pageId, depth + 1);
    }
  };
  visit(null, 0);
  return rows;
}

/** This page and every one of its descendants, by id — what a "move"
 *  picker must exclude from its target list, since setting a page's own
 *  descendant as its new parent would create a cycle. The server would
 *  refuse this anyway, but a picker that never offers it is a better
 *  experience than one that offers it and then explains why not. */
export function descendantIdsOf(pages: readonly Page[], pageId: string): ReadonlySet<string> {
  const children = new Map<string | null, string[]>();
  for (const page of pages) {
    const bucket = children.get(page.parentPageId);
    if (bucket) {
      bucket.push(page.pageId);
    } else {
      children.set(page.parentPageId, [page.pageId]);
    }
  }

  const found = new Set<string>([pageId]);
  const stack = [pageId];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) continue;
    for (const childId of children.get(current) ?? []) {
      if (found.has(childId)) continue;
      found.add(childId);
      stack.push(childId);
    }
  }
  found.delete(pageId);
  return found;
}
