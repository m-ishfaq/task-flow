import type { Wire } from '@taskflow/client';
import type { MobileTRPCClient } from './trpc-client.js';

/**
 * Docs comments (Phase 6 Wave 3, ported). Types and the one query key — no
 * `react-native` import, matching every other lib file's split.
 *
 * Unlike Work's card comments, a Docs comment has NO `parentCommentId` —
 * `docs.comments.list`'s own output schema (`apps/api/src/docs/router.ts`)
 * has no such field, and there is no reply-threading UI on web either
 * (`comments-suggestions.tsx`'s `CommentsTab` renders one flat list). So
 * this is simpler than `card/[cardId].tsx`'s own `CommentsSection`, not a
 * corner cut from it.
 *
 * `anchorFrom`/`anchorTo` are always the SAME value here — `docs-collab.ts`'s
 * `pageStartAnchor` builds a collapsed anchor at the page's start, since this
 * app has no editor to select a text range from. See that function's own
 * header for why the server accepts this as a perfectly valid anchor.
 */
export type DocComment = Wire<
  Awaited<ReturnType<MobileTRPCClient['docs']['comments']['list']['query']>>
>[number];

export function commentsQueryKey(pageId: string): readonly ['docs.comments.list', string] {
  return ['docs.comments.list', pageId];
}
