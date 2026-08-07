import { useQuery } from '@tanstack/react-query';
import type { OrgId, PageId } from '@taskflow/contracts';
import { formatDateTime } from '../../lib/format.js';
import { Skeleton } from '../../components/primitives.js';
import { ErrorView } from '../../components/error-view.js';
import { RichTextView } from '../work/detail/rich-text-editor.js';
import { publicPageQuery } from './api.js';

/**
 * The anonymous, no-session view of a published page (ai/phase-6-docs.md
 * §3.9, Wave 4). Reached at `/public/docs/$orgId/$pageId` — registered
 * unauthenticated in `router.tsx`, and rendered without the app shell
 * because `components/shell.tsx`'s `bare` rendering already covers any
 * route hit with no active session, which is the common case here.
 *
 * `docs.public.getPage` is `publicRoute` on the server (`router.ts`'s own
 * comment): it takes a plain `orgId`, re-checks `published_version_id IS
 * NOT NULL` on every call, and answers NOT_FOUND for anything else —
 * unpublished, wrong org, or a page that never existed all look identical
 * from here, which is the point (§3.9: no separate capability token to leak
 * "this used to be published").
 */

export function PublicPageView({
  orgId,
  pageId,
}: {
  readonly orgId: OrgId;
  readonly pageId: PageId;
}) {
  const page = useQuery(publicPageQuery(orgId, pageId));

  if (page.isPending) {
    return (
      <div className="mx-auto max-w-2xl space-y-3 p-8">
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    );
  }

  if (page.isError) {
    return (
      <div className="mx-auto max-w-2xl p-8">
        <ErrorView error={page.error} title="This page is not available" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-8">
      <div>
        <h1 className="text-2xl font-semibold text-ink">{page.data.title}</h1>
        <p className="text-xs text-ink-faint">Published {formatDateTime(page.data.publishedAt)}</p>
      </div>
      <RichTextView value={page.data.content} />
    </div>
  );
}
