import { queryOptions, type QueryClient } from '@tanstack/react-query';
import type {
  CommentId,
  OrgId,
  PageId,
  PageTemplateId,
  SpaceId,
  SuggestionId,
} from '@taskflow/contracts';
import { api } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { wire, type Wire } from '../../lib/wire.js';
import type { DocumentNode } from '../work/detail/rich-text.js';

/**
 * Docs reads and writes (ai/phase-6-docs.md §5). Same shape as `work/api.ts`
 * and `chat/api.ts`: `queryOptions` rather than hooks, `wire()` on every
 * result because several of these return `Date` fields the wire carries as
 * strings (`lib/wire.ts`).
 *
 * Wave 1 shipped `spaces`/`pages` only, on the stated principle of not
 * building a route ahead of the surface that calls it. This file now also
 * covers Wave 2 (`pageVersions`), Wave 3 (`comments`, `suggestions`,
 * `backlinks`), and Wave 4 (`publish`/`unpublish`, `exportPdf`,
 * `templates`, the public read path) — the UI waves that actually render
 * them.
 */

interface Outputs {
  spaces: Awaited<ReturnType<typeof api.docs.spaces.list.query>>;
  pages: Awaited<ReturnType<typeof api.docs.pages.list.query>>;
  pageVersions: Awaited<ReturnType<typeof api.docs.pageVersions.list.query>>;
  comments: Awaited<ReturnType<typeof api.docs.comments.list.query>>;
  suggestions: Awaited<ReturnType<typeof api.docs.suggestions.list.query>>;
  templates: Awaited<ReturnType<typeof api.docs.templates.list.query>>;
  backlinks: Awaited<ReturnType<typeof api.docs.backlinks.list.query>>;
  publicPage: Awaited<ReturnType<typeof api.docs.public.getPage.query>>;
}

export type SpaceSummary = Wire<Outputs['spaces']>[number];
export type PageSummary = Wire<Outputs['pages']>[number];
export type PageVersionSummary = Wire<Outputs['pageVersions']>[number];
export type CommentSummary = Wire<Outputs['comments']>[number];
export type SuggestionSummary = Wire<Outputs['suggestions']>[number];
export type TemplateSummary = Wire<Outputs['templates']>[number];
export type BacklinkSummary = Wire<Outputs['backlinks']>[number];
export type PublicPage = Wire<Outputs['publicPage']>;

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
 * Page versions (Wave 2, §3.7)
 * -------------------------------------------------------------------------- */

export function pageVersionsQuery(orgId: string, pageId: PageId) {
  return queryOptions({
    queryKey: keys.pageVersions(orgId, pageId),
    queryFn: async () => wire(await api.docs.pageVersions.list.query({ pageId })),
  });
}

export function saveVersion(input: { pageId: PageId }) {
  return api.docs.pageVersions.save.mutate(input);
}

export function restoreVersion(input: { pageId: PageId; versionId: string }) {
  return api.docs.pageVersions.restore.mutate(input);
}

/* -------------------------------------------------------------------------- *
 * Comments (Wave 3, §3.6)
 * -------------------------------------------------------------------------- */

export function pageCommentsQuery(orgId: string, pageId: PageId) {
  return queryOptions({
    queryKey: keys.pageComments(orgId, pageId),
    queryFn: async () => wire(await api.docs.comments.list.query({ pageId })),
  });
}

export function createComment(input: {
  pageId: PageId;
  anchorFrom: string;
  anchorTo: string;
  body: DocumentNode;
}) {
  return api.docs.comments.create.mutate(input);
}

export function updateComment(input: { commentId: CommentId; body: DocumentNode }) {
  return api.docs.comments.update.mutate(input);
}

export function resolveComment(input: { commentId: CommentId; resolved: boolean }) {
  return api.docs.comments.resolve.mutate(input);
}

export function deleteComment(input: { commentId: CommentId }) {
  return api.docs.comments.delete.mutate(input);
}

/* -------------------------------------------------------------------------- *
 * Suggestions (Wave 3, §3.6)
 * -------------------------------------------------------------------------- */

export function pageSuggestionsQuery(orgId: string, pageId: PageId) {
  return queryOptions({
    queryKey: keys.pageSuggestions(orgId, pageId),
    queryFn: async () => wire(await api.docs.suggestions.list.query({ pageId })),
  });
}

export function createSuggestion(input: {
  pageId: PageId;
  anchorFrom: string;
  anchorTo: string;
  kind: 'insert' | 'delete' | 'replace';
  /** Required for 'insert'/'replace', omitted for 'delete' — see `suggestion.service.ts`'s own CHECK. */
  proposedContent?: DocumentNode | null;
}) {
  return api.docs.suggestions.create.mutate(input);
}

export function decideSuggestion(input: {
  suggestionId: SuggestionId;
  status: 'accepted' | 'rejected';
}) {
  return api.docs.suggestions.decide.mutate(input);
}

/* -------------------------------------------------------------------------- *
 * Backlinks (Wave 3, §3.10) — read-only, "what links here"
 * -------------------------------------------------------------------------- */

export function pageBacklinksQuery(orgId: string, pageId: PageId) {
  return queryOptions({
    queryKey: keys.pageBacklinks(orgId, pageId),
    queryFn: async () => wire(await api.docs.backlinks.list.query({ pageId })),
  });
}

/* -------------------------------------------------------------------------- *
 * Publish / unpublish / PDF export (Wave 4, §3.9)
 * -------------------------------------------------------------------------- */

export function publishPage(input: { pageId: PageId }) {
  return api.docs.pages.publish.mutate(input);
}

export function unpublishPage(input: { pageId: PageId }) {
  return api.docs.pages.unpublish.mutate(input);
}

/** `versionId: null` means "the latest saved version" — see `pdf-export.service.ts`'s own header. */
export function exportPagePdf(input: { pageId: PageId; versionId: string | null }) {
  return api.docs.pages.exportPdf.mutate(input);
}

/** The public, no-session read path (§3.9). Same `api` client — `authHeaders()` already degrades gracefully with no session (`lib/session.ts`). */
export function publicPageQuery(orgId: OrgId, pageId: PageId) {
  return queryOptions({
    queryKey: ['public', 'docs', orgId, pageId] as const,
    queryFn: async () => wire(await api.docs.public.getPage.query({ orgId, pageId })),
    retry: false,
  });
}

/* -------------------------------------------------------------------------- *
 * Templates (Wave 4, §5)
 * -------------------------------------------------------------------------- */

export function pageTemplatesQuery(orgId: string, spaceId: SpaceId) {
  return queryOptions({
    queryKey: keys.pageTemplates(orgId, spaceId),
    queryFn: async () => wire(await api.docs.templates.list.query({ spaceId })),
  });
}

export function createTemplate(input: { pageId: PageId; name: string }) {
  return api.docs.templates.create.mutate(input);
}

export function deleteTemplate(input: { templateId: PageTemplateId }) {
  return api.docs.templates.delete.mutate(input);
}

export function createPageFromTemplate(input: {
  spaceId: SpaceId;
  parentPageId: PageId | null;
  title: string;
  templateId: PageTemplateId;
}) {
  return api.docs.templates.createPage.mutate(input);
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

export function invalidatePageVersions(client: QueryClient, orgId: string, pageId: string): void {
  void client.invalidateQueries({ queryKey: keys.pageVersions(orgId, pageId) });
}

export function invalidatePageComments(client: QueryClient, orgId: string, pageId: string): void {
  void client.invalidateQueries({ queryKey: keys.pageComments(orgId, pageId) });
}

export function invalidatePageSuggestions(
  client: QueryClient,
  orgId: string,
  pageId: string,
): void {
  void client.invalidateQueries({ queryKey: keys.pageSuggestions(orgId, pageId) });
}

export function invalidatePageTemplates(client: QueryClient, orgId: string, spaceId: string): void {
  void client.invalidateQueries({ queryKey: keys.pageTemplates(orgId, spaceId) });
}

export function invalidatePageBacklinks(client: QueryClient, orgId: string, pageId: string): void {
  void client.invalidateQueries({ queryKey: keys.pageBacklinks(orgId, pageId) });
}
