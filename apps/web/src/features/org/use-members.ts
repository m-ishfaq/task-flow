import { useQuery } from '@tanstack/react-query';
import { useSession } from '../../lib/session.js';
import { membersQuery, type Member } from './api.js';

/**
 * Resolving a user id to a person.
 *
 * Cards carry `assigneeIds` — bare uuids — and comments carry an author id, so
 * every surface that wants to show WHO needs the same lookup. Without it the
 * board renders uuids, which is the state Phase 3 shipped in.
 *
 * ## Why this is a hook over the query cache and not a store
 *
 * The member list is server state, so §10.5 puts it in TanStack Query and
 * nowhere else. Copying it into Zustand to make a synchronous `memberById` would
 * give it a second lifetime with no invalidation story: a member removed in
 * Settings would keep resolving on the board until a reload. The Map below is
 * derived per render from the cached array, which costs nothing at org size and
 * cannot go stale independently.
 *
 * ## Why a missing id resolves to the id
 *
 * `member:read` is a permission, and a role that lacks it gets an empty list
 * rather than an error. An assignee who has since left the org also resolves to
 * nothing. Neither is exceptional, so both fall back to the raw id — an avatar
 * with two hex characters in it is worse than useless, but it is not a crash,
 * and the alternative (hiding the assignee) would silently misreport a card as
 * unassigned.
 */

export interface Person {
  readonly userId: string;
  /** Email today. Becomes a display name when there is a profile surface. */
  readonly label: string;
}

export interface MemberLookup {
  readonly people: readonly Member[];
  readonly personOf: (userId: string) => Person;
  readonly peopleOf: (userIds: readonly string[]) => readonly Person[];
  readonly isPending: boolean;
}

export function useMembers(): MemberLookup {
  const orgId = useSession((state) => state.orgId) ?? '';
  const members = useQuery({
    ...membersQuery(orgId),
    /* Members change far less often than cards and are read by every avatar on
       the board. A minute of staleness here saves a refetch per navigation and
       costs a minute of a renamed address. */
    staleTime: 60_000,
    enabled: orgId !== '',
  });

  const byId = new Map((members.data ?? []).map((member) => [member.userId, member]));

  const personOf = (userId: string): Person => ({
    userId,
    label: byId.get(userId)?.email ?? userId,
  });

  return {
    people: members.data ?? [],
    personOf,
    peopleOf: (userIds) => userIds.map(personOf),
    isPending: members.isPending,
  };
}
