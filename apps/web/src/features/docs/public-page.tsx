import { useQuery } from '@tanstack/react-query';
import type { OrgId, PageId } from '@taskflow/contracts';
import { formatDateTime } from '../../lib/format.js';
import { BrandMark } from '../../components/brand-mark.js';
import { Skeleton } from '../../components/primitives.js';
import { ErrorView } from '../../components/error-view.js';
import { useBranding } from '../../lib/branding-context.js';
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
 *
 * The warm-dark rebuild's own Docs-module pass (`ai/design-rebuild-warm-
 * dark.md` §5) gave this page real editorial treatment — a masthead-style
 * title, a rule under the meta line, and a wider, more generous reading
 * measure — rather than leaving it as the same compact layout every other
 * `RichTextView` caller (a card description, a comment, a chat message)
 * uses. Those callers are read in passing; a page reached from a shared
 * link is read start to finish, the one place in this whole app that is
 * actually shaped like a landing page rather than a tool, which is why
 * that build guide names it as the one surface `taste-skill`'s own
 * guidance genuinely applies to.
 */

export function PublicPageView({
  orgId,
  pageId,
}: {
  readonly orgId: OrgId;
  readonly pageId: PageId;
}) {
  const page = useQuery(publicPageQuery(orgId, pageId));
  const { productName } = useBranding();

  if (page.isPending) {
    return (
      <div className="mx-auto max-w-2xl space-y-3 px-8 py-14">
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    );
  }

  if (page.isError) {
    return (
      <div className="mx-auto max-w-2xl px-8 py-14">
        <ErrorView error={page.error} title="This page is not available" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl px-8 py-14">
      <header className="mb-10 border-b border-line pb-6">
        <h1 className="font-display text-[2rem] font-semibold tracking-tight text-ink">
          {page.data.title}
        </h1>
        <p className="mt-2 text-[13px] text-ink-faint">
          Published {formatDateTime(page.data.publishedAt)}
        </p>
      </header>

      <div className="docs-article">
        <RichTextView value={page.data.content} />
      </div>

      {/* The one piece of chrome an anonymous, shell-less page gets: who
          published it. `useBranding()` already resolves app-wide via
          `BrandingProvider` in app.tsx, which wraps the router — including
          this bare route — so nothing extra needs fetching here. */}
      <div className="mt-14 flex items-center gap-2 border-t border-line pt-6 text-xs text-ink-faint">
        <BrandMark size={16} className="text-ink-faint" />
        <span>Published with {productName}</span>
      </div>
    </div>
  );
}
