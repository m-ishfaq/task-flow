import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useSession } from '../../lib/session.js';
import { api } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { wire } from '@taskflow/client';
import { displayName, oooStatus } from '../../lib/format.js';
import { Users } from 'lucide-react';
import { Avatar, Badge, Button, Empty, SkeletonRows } from '../../components/primitives.js';
import { ErrorView } from '../../components/error-view.js';
import type { DirectoryMember } from './api.js';

/**
 * The org directory (Phase 11.5 Wave 1, ai/phase-11.5-people.md §3.5).
 *
 * Cursor-paginated by design (§7 decision: paginate from Wave 1 — the cursor
 * is a user id, a total order with no ties, so `user_id > cursor` cannot
 * skip or repeat a row). `useInfiniteQuery` is the framework's own shape for
 * this: pages accumulate in the cache keyed by cursor, "Load more" appends
 * without refetching what is shown, and a re-mount does not lose the pages
 * already fetched.
 *
 * Nothing here checks a role — `member:read` is the server's answer to who
 * sees the list, and a caller without it gets an empty page, not an error
 * (§8.2: the UI never re-derives authorization).
 */
export function PeoplePage() {
  const orgId = useSession((state) => state.orgId) ?? '';

  const directory = useInfiniteQuery({
    queryKey: keys.directoryAll(orgId),
    queryFn: async ({ pageParam }) =>
      wire(await api.people.directory.list.query({ cursor: pageParam ?? undefined, limit: 50 })),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled: orgId !== '',
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-line/50 px-6 pt-6 pb-4">
        <h1 className="font-display text-2xl font-bold tracking-tight text-ink">People</h1>
        <p className="mt-1.5 max-w-2xl text-[15px] leading-relaxed text-ink-muted">
          Everyone in this organization, with their profile, role, and who they report to.
        </p>
      </header>

      <div className="flex-1 overflow-y-auto p-6">
        {directory.isPending && <SkeletonRows rows={6} />}
        {directory.isError && (
          <ErrorView error={directory.error} title="Could not load the directory" />
        )}

        {directory.data !== undefined && (
          <>
            {directory.data.pages[0]?.members.length === 0 ? (
              <Empty
                icon={<Users aria-hidden="true" className="size-5" strokeWidth={1.75} />}
                title="No one here yet"
                description="Members appear here as soon as they join the organization."
              />
            ) : (
              <DirectoryGrid rows={directory.data.pages.flatMap((page) => page.members)} />
            )}

            {directory.hasNextPage && (
              <div className="flex justify-center pt-6">
                <Button
                  size="sm"
                  disabled={directory.isFetchingNextPage}
                  onClick={() => {
                    void directory.fetchNextPage();
                  }}
                >
                  {directory.isFetchingNextPage ? 'Loading…' : 'Load more'}
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function DirectoryGrid({ rows }: { readonly rows: readonly DirectoryMember[] }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {rows.map((member) => {
        const label = displayName({ name: member.displayName, email: member.email });
        return (
          <Link
            key={member.userId}
            to="/people/$userId"
            params={{ userId: member.userId }}
            className="group flex flex-col items-center gap-3 rounded-xl border border-line/50 bg-surface-raised/50 p-5 text-center transition-all duration-[var(--motion-fast)] hover:border-line hover:bg-surface-hover/50 hover:shadow-sm"
          >
            <Avatar userId={member.userId} label={label} className="size-12" />

            <div className="min-w-0 w-full">
              <p className="truncate text-sm font-medium text-ink group-hover:text-accent">
                {label}
              </p>
              <p className="mt-0.5 truncate text-xs text-ink-faint">
                {member.jobTitle !== null || member.department !== null
                  ? [member.jobTitle, member.department].filter(Boolean).join(' · ')
                  : member.email}
              </p>
            </div>

            <div className="flex items-center gap-1.5">
              <OooBadge member={member} />
              <Badge className="text-xs">{member.role}</Badge>
            </div>
          </Link>
        );
      })}
    </div>
  );
}

/** "Out of office" as a badge, only when the person is OOO right now. */
function OooBadge({ member }: { readonly member: DirectoryMember }) {
  if (!oooStatus(member.oooFrom, member.oooUntil)) return null;

  return (
    <Badge
      className="bg-surface-hover text-warning"
      {...(member.oooMessage === null ? {} : { title: member.oooMessage })}
    >
      OOO
    </Badge>
  );
}
