import type { Wire } from '@taskflow/client';
import type { MobileTRPCClient } from './trpc-client.js';

/**
 * Docs suggestions (Phase 6 Wave 3, ported). Types and the one query key.
 *
 * `decide` (accept/reject/withdraw) is a PURE server-side status flip, even
 * on web — `apps/api/src/docs/suggestion.service.ts`'s own header and the
 * web toast copy ("Marked accepted — apply the change in the document
 * yourself.") both say so explicitly: accepting a suggestion never touches
 * the live Yjs document, on either platform. That is what makes this app's
 * whole suggestions feature portable with no editor at all — listing and
 * deciding need nothing this app lacks.
 *
 * Creating a NEW suggestion needs an anchor, the identical constraint
 * `docs-comments.ts` documents — `docs-collab.ts`'s `pageStartAnchor`
 * covers it the same way, at the cost of every mobile-created suggestion
 * being page-level (`kind: 'insert'` at the page's start) rather than a
 * true text-range proposal.
 */
export type DocSuggestion = Wire<
  Awaited<ReturnType<MobileTRPCClient['docs']['suggestions']['list']['query']>>
>[number];

export function suggestionsQueryKey(pageId: string): readonly ['docs.suggestions.list', string] {
  return ['docs.suggestions.list', pageId];
}
