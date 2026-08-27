import type { Wire } from '@taskflow/client';
import type { MobileTRPCClient } from './trpc-client.js';

/**
 * Page version history (Phase 6 Wave 2 backend / Wave 4 web UI), ported to
 * native — the gap the mobile-vs-web audit named: "no editor dependency,
 * same shape as publish/unpublish which already ported cleanly." Types and
 * the one query key; `docs-page/[pageId].tsx`'s `VersionHistorySection`
 * carries the actual UI, the same split every other Docs lib file in this
 * app draws.
 *
 * `docs.pageVersions.save`/`.restore` never send or receive rich text —
 * `save` snapshots whatever the server's own live Yjs document currently
 * holds, `restore` copies a stored snapshot back over it, both entirely
 * server-side. That is what makes this fully portable with no editor, the
 * identical argument `docs.ts`'s own header already makes for backlinks,
 * publish/unpublish, PDF export, and templates.
 */
export type PageVersionSummary = Wire<
  Awaited<ReturnType<MobileTRPCClient['docs']['pageVersions']['list']['query']>>
>[number];

export function pageVersionsQueryKey(pageId: string): readonly ['docs.pageVersions.list', string] {
  return ['docs.pageVersions.list', pageId];
}
