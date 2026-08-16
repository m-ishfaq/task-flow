import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useSession } from '../../lib/session.js';
import { api } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { wire } from '../../lib/wire.js';
import { displayName, oooStatus } from '../../lib/format.js';
import { Users } from 'lucide-react';
import { Avatar, Badge, Button, Empty, PageHeader, SkeletonRows } from '../../components/primitives.js';
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
    <div className="mx-auto flex max-w-3xl flex-col gap-7 p-8">
      <PageHeader
        title="People"
        description="Everyone in this organization, with their profile, role, and who they report to."
      />

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
            <DirectoryRows rows={directory.data.pages.flatMap((page) => page.members)} />
          )}

          {directory.hasNextPage && (
            <div className="flex justify-center">
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
  );
}

function DirectoryRows({ rows }: { readonly rows: readonly DirectoryMember[] }) {
  return (
    <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line">
      {rows.map((member) => {
        const label = displayName({ name: member.displayName, email: member.email });
        return (
          <li key={member.userId} className="flex items-center gap-3 px-3 py-2.5">
            <Avatar userId={member.userId} label={label} />

            <div className="min-w-0 flex-1">
              <Link
                to="/people/$userId"
                params={{ userId: member.userId }}
                className="block truncate text-sm text-ink hover:text-accent"
              >
                {label}
              </Link>
              <p className="truncate text-[11px] text-ink-faint">{member.email}</p>
            </div>

            <OooBadge member={member} />

            <Badge>{member.role}</Badge>
          </li>
        );
      })}
    </ul>
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
