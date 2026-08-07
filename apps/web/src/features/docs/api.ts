import { queryOptions, type QueryClient } from '@tanstack/react-query';
import type { PageId, SpaceId } from '@taskflow/contracts';
import { api } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { wire, type Wire } from '../../lib/wire.js';

/**
 * Docs reads and writes (ai/phase-6-docs.md §5, Wave 1 of the UI — tree and
 * metadata only, no page body content). Same shape as `work/api.ts` and
 * `chat/api.ts`: `queryOptions` rather than hooks, `wire()` on every result
 * because `spaces.list`/`pages.list` both return `Date` fields the wire
 * carries as strings (`lib/wire.ts`).
 *
 * Deliberately thin for Wave 1 — no `pageVersions`/`comments`/`suggestions`/
 * `publish`/`templates` functions yet, even though the API already has all
 * of them (ai/phase-6-docs.md's backend is fully shipped). Those land with
 * the UI waves that actually render them (§5's own Wave 2/3/4 split),
 * mirroring the backend's own precedent of not building a route ahead of
 * the surface that calls it.
 */

interface Outputs {
  spaces: Awaited<ReturnType<typeof api.docs.spaces.list.query>>;
  pages: Awaited<ReturnType<typeof api.docs.pages.list.query>>;
}

export type SpaceSummary = Wire<Outputs['spaces']>[number];
export type PageSummary = Wire<Outputs['pages']>[number];

/* -------------------------------------------------------------------------- *
 * Reads
 * -------------------------------------------------------------------------- */

export function spacesQuery(orgId: string) {
  return queryOptions({
    queryKey: keys.spaces(orgId),
    queryFn: async () => wire(await api.docs.spaces.list.query()),
  });
}

/** Flat, not a tree — the panel groups by `parentPageId` client-side, the same convention `docs.service.ts`'s own `listPages` documents server-side. */
export function pagesQuery(orgId: string, spaceId: SpaceId) {
  return queryOptions({
    queryKey: keys.pages(orgId, spaceId),
    queryFn: async () => wire(await api.docs.pages.list.query({ spaceId })),
  });
}

/* -------------------------------------------------------------------------- *
 * Mutations
 * -------------------------------------------------------------------------- */

export function createSpace(input: { name: string }) {
  return api.docs.spaces.create.mutate(input);
}

/** Archive or restore. `space:manage`, so a member without it sees an honest FORBIDDEN. */
export function archiveSpace(input: { spaceId: SpaceId; restore: boolean }) {
  return api.docs.spaces.archive.mutate(input);
}

export function createPage(input: {
  spaceId: SpaceId;
  parentPageId: PageId | null;
  title: string;
}) {
  return api.docs.pages.create.mutate(input);
}

export function renamePage(input: { pageId: PageId; title: string }) {
  return api.docs.pages.update.mutate(input);
}

/**
 * Reparent and/or reorder. `beforePageId`/`afterPageId` name the new
 * NEIGHBOURS, never a position — the server derives the rank, the identical
 * contract `cards.move` and `lists.reorder` already use (CLAUDE.md: "a
 * client-computed rank is computed from a board read some time ago").
 */
export function movePage(input: {
  pageId: PageId;
  targetParentId: PageId | null;
  beforePageId: PageId | null;
  afterPageId: PageId | null;
}) {
  return api.docs.pages.move.mutate(input);
}

export function archivePage(input: { pageId: PageId; restore: boolean }) {
  return api.docs.pages.archive.mutate(input);
}

/* -------------------------------------------------------------------------- *
 * Cache edits — invalidate rather than patch, matching chat/work's own default
 * -------------------------------------------------------------------------- */

export function invalidateSpaces(client: QueryClient, orgId: string): void {
  void client.invalidateQueries({ queryKey: keys.spaces(orgId) });
}

export function invalidatePages(client: QueryClient, orgId: string, spaceId: string): void {
  void client.invalidateQueries({ queryKey: keys.pages(orgId, spaceId) });
}
