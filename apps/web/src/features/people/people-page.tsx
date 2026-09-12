import { useEffect, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useSession } from '../../lib/session.js';
import { api } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { wire } from '@taskflow/client';
import { displayName, oooStatus } from '../../lib/format.js';
import { Users } from 'lucide-react';
import {
  Avatar,
  Badge,
  Button,
  Empty,
  PageContainer,
  PageHeader,
  SearchInput,
  SkeletonRows,
} from '../../components/primitives.js';
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
 *
 * ## A real search box, not just pagination
 *
 * Prompted directly against the "long lists" pattern this app already holds
 * itself to elsewhere (channel-details.tsx's member roster, settings-page.tsx's
 * member list) — this was the one screen literally named "People" with NO
 * way to search for one, just a "Load more" button and a scroll. `people.
 * directory.list` has no server-side name/email filter at all (checked
 * directly) — cursor pagination answers "how do we page through everyone
 * without skipping or repeating a row," not "how do we find one person," and
 * building a real server-side search is separate, larger work than this
 * pass's scope.
 *
 * So the fix is honest about that limit rather than pretending a client
 * filter over 50 loaded rows searches the whole org: typing anything
 * non-empty triggers `fetchNextPage` on a loop (the effect below) until
 * either every page is loaded or the query is cleared, so a search always
 * ends up checked against the FULL directory, never just whatever happened
 * to be paged in first. This trades a bigger one-time fetch for a search
 * that cannot silently miss someone near the end of a large org — the
 * honest trade given no server-side filter exists to ask for a narrower
 * one instead.
 */
export function PeoplePage() {
  const orgId = useSession((state) => state.orgId) ?? '';
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();

  const directory = useInfiniteQuery({
    queryKey: keys.directoryAll(orgId),
    queryFn: async ({ pageParam }) =>
      wire(await api.people.directory.list.query({ cursor: pageParam ?? undefined, limit: 50 })),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled: orgId !== '',
  });

  const loaded = directory.data?.pages.flatMap((page) => page.members) ?? [];

  useEffect(() => {
    if (needle === '' || !directory.hasNextPage || directory.isFetchingNextPage) return;
    void directory.fetchNextPage();
    // `directory` is a fresh object every render; only the three fields read
    // above decide whether this fires, so those are the real dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needle, directory.hasNextPage, directory.isFetchingNextPage]);

  const filtered =
    needle === ''
      ? loaded
      : loaded.filter((member) => {
          const label = displayName({ name: member.displayName, email: member.email });
          return (
            label.toLowerCase().includes(needle) ||
            member.email.toLowerCase().includes(needle) ||
            (member.jobTitle?.toLowerCase().includes(needle) ?? false) ||
            (member.department?.toLowerCase().includes(needle) ?? false)
          );
        });

  return (
    <PageContainer maxWidth="xl" className="flex flex-col gap-5">
      <PageHeader
        title="People"
        description="Everyone in this organization, with their profile, role, and who they report to."
        icon={<Users aria-hidden="true" className="size-4" strokeWidth={2.25} />}
      />

      {directory.isPending && <SkeletonRows rows={6} />}
      {directory.isError && (
        <ErrorView error={directory.error} title="Could not load the directory" />
      )}

      {directory.data !== undefined && (
        <>
          {loaded.length === 0 ? (
            <Empty
              icon={<Users aria-hidden="true" className="size-5" strokeWidth={1.75} />}
              title="No one here yet"
              description="Members appear here as soon as they join the organization."
            />
          ) : (
            <>
              <div className="flex items-center gap-3">
                <SearchInput
                  value={query}
                  onChange={setQuery}
                  placeholder="Search by name, email, title, or department…"
                  className="max-w-sm"
                />
                {needle !== '' && directory.isFetchingNextPage && (
                  <p className="text-xs text-ink-faint">Searching the rest of the directory…</p>
                )}
              </div>

              {filtered.length === 0 ? (
                <Empty title="No one matches your search" />
              ) : (
                <DirectoryRows rows={filtered} />
              )}
            </>
          )}

          {needle === '' && directory.hasNextPage && (
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
    </PageContainer>
  );
}

/**
 * The directory grid — Design Bible §11's own `.pc` profile card, replacing
 * the earlier list-of-rows layout.
 *
 * Every field this card shows (name, role/title, department, the OOO line)
 * was already on the wire before this pass — `DirectoryMemberSchema`
 * (`apps/api/src/people/router.ts`) has carried `jobTitle`/`department`
 * since Wave 2, this page simply never rendered them. The one thing the
 * bible's own card shows that genuinely is NOT available is a live
 * "Available" / "In a meeting" presence line: that needs an org-wide
 * "who's online" broadcast this codebase does not have (the identical gap
 * `chat-sidebar.tsx`'s own `DirectoryMessageRow` comment names for DM
 * presence) — a real, separate follow-up, not something to fabricate here.
 * The OOO line is the one genuinely LIVE status this directory can show
 * honestly today, so it takes the bible's `.pc .st` slot instead.
 */
function DirectoryRows({ rows }: { readonly rows: readonly DirectoryMember[] }) {
  return (
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3">
      {rows.map((member) => {
        const label = displayName({ name: member.displayName, email: member.email });
        return (
          <li key={member.userId}>
            <Link
              to="/people/$userId"
              params={{ userId: member.userId }}
              className="flex flex-col items-center gap-1 rounded-card border border-line/50 bg-surface-raised p-4 text-center transition-colors hover:border-line-strong hover:bg-surface-hover/50"
            >
              <Avatar userId={member.userId} label={label} size="lg" className="mb-1" />
              <span className="truncate text-sm font-semibold text-ink">{label}</span>
              {member.jobTitle !== null && (
                <span className="truncate text-xs text-ink-muted">{member.jobTitle}</span>
              )}
              {member.department !== null && (
                <span className="truncate text-[11px] text-ink-faint">{member.department}</span>
              )}
              <Badge className="mt-1 text-[11px]">{member.role}</Badge>
              <OooStatus member={member} />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/** The one live status this directory can show honestly — see the grid's own header. */
function OooStatus({ member }: { readonly member: DirectoryMember }) {
  if (!oooStatus(member.oooFrom, member.oooUntil)) return null;

  return (
    <span
      className="mt-1.5 inline-flex items-center gap-1.5 text-[10.5px] font-medium text-warning"
      {...(member.oooMessage === null ? {} : { title: member.oooMessage })}
    >
      <span aria-hidden="true" className="size-1.5 rounded-full bg-warning" />
      Out of office
    </span>
  );
}
