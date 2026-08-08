import { useQuery } from '@tanstack/react-query';
import type { PageId, SpaceId } from '@taskflow/contracts';
import { Empty, Skeleton } from '../../components/primitives.js';
import { ErrorView } from '../../components/error-view.js';
import { pageBacklinksQuery } from './api.js';

/**
 * "What links here" (ai/phase-6-docs.md §3.10, Wave 3 backend / Wave 4 UI).
 *
 * Read-only, and there is nothing to authorize per row here beyond the
 * `page:read` the route itself already requires — `backlinks.ts`'s own
 * header on `listBacklinks` explains why a source page's title is exactly
 * as visible here as it is in the ordinary tree. There is no "reveal in
 * text" control on a backlink row: unlike a comment/suggestion anchor, a
 * backlink names another PAGE, not a position inside this one — following
 * one is `onNavigate`, an ordinary tree navigation.
 */

export function BacklinksPanel({
  orgId,
  pageId,
  onNavigate,
}: {
  readonly orgId: string;
  readonly pageId: PageId;
  readonly onNavigate: (spaceId: SpaceId, pageId: PageId) => void;
}) {
  const backlinks = useQuery(pageBacklinksQuery(orgId, pageId));

  return (
    <div className="space-y-2">
      <h3 className="text-xs font-semibold tracking-wide text-ink-muted uppercase">
        What links here
      </h3>

      {backlinks.isPending ? (
        <div aria-busy="true" className="space-y-1.5">
          <Skeleton className="h-5 w-3/4" />
        </div>
      ) : backlinks.isError ? (
        <ErrorView error={backlinks.error} title="Could not load backlinks" />
      ) : backlinks.data.length === 0 ? (
        <Empty
          title="No pages link here yet"
          description="Use a page link inside another page's content."
        />
      ) : (
        <ul className="space-y-1">
          {backlinks.data.map((backlink) => (
            <li key={backlink.sourcePageId}>
              <button
                type="button"
                onClick={() => {
                  onNavigate(backlink.sourceSpaceId as SpaceId, backlink.sourcePageId as PageId);
                }}
                className="w-full truncate rounded px-1.5 py-1 text-left text-xs text-ink-muted hover:bg-surface-hover hover:text-ink"
                title={backlink.sourceTitle}
              >
                {backlink.sourceTitle}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
