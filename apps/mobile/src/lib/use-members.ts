import { useQuery } from '@tanstack/react-query';
import { wire, type Wire } from '@taskflow/client';
import { apiClient } from './app-session.js';
import { useSession } from './use-session.js';
import type { MobileTRPCClient } from './trpc-client.js';

/**
 * Resolving a user id to a person — ported from `apps/web/src/features/org/
 * use-members.ts` (that file's own header explains the design in full; this
 * restates only what differs on native). Chat's author ids, a channel's
 * `participantIds`, and a card comment's `authorId` are all bare uuids, and
 * every one of those screens was rendering the raw fallback ("You"/"Member")
 * rather than a real name — found from a real device video review that named
 * it explicitly. One lookup, reused everywhere a userId needs a name.
 *
 * `people` comes from `tenancy.members.list` (`member:read`), the same
 * org-wide roster web's picker/mention/DM-naming surfaces all read from.
 * `personOf` falls back to the raw id when the roster has nothing for that
 * id — a caller without `member:read`, or someone who has since left the
 * org — deliberately: hiding the author would silently misreport a message
 * as having no one behind it.
 */

export type Member = Wire<
  Awaited<ReturnType<MobileTRPCClient['tenancy']['members']['list']['query']>>
>[number];

export interface Person {
  readonly userId: string;
  /** The display name when there is one, the email otherwise — never a raw uuid unless both are unknown. */
  readonly label: string;
  readonly named: boolean;
}

export interface MemberLookup {
  readonly people: readonly Member[];
  readonly personOf: (userId: string) => Person;
  readonly peopleOf: (userIds: readonly string[]) => readonly Person[];
  readonly isPending: boolean;
}

export const MEMBERS_QUERY_KEY = ['tenancy.members.list'] as const;

export function useMembers(): MemberLookup {
  const orgId = useSession((state) => state.orgId);
  const members = useQuery({
    queryKey: MEMBERS_QUERY_KEY,
    queryFn: async () => wire(await apiClient.tenancy.members.list.query()),
    // Members change far less often than messages/cards and are read by
    // every author line and avatar; a minute of staleness saves a refetch
    // per screen for the cost of a minute-stale renamed display name.
    staleTime: 60_000,
    enabled: orgId !== null,
  });

  const byId = new Map((members.data ?? []).map((member) => [member.userId, member]));

  function personOf(userId: string): Person {
    const member = byId.get(userId);
    const name = member?.displayName ?? null;
    return {
      userId,
      label: name ?? member?.email ?? userId,
      named: name !== null,
    };
  }

  return {
    people: members.data ?? [],
    personOf,
    peopleOf: (userIds) => userIds.map(personOf),
    isPending: members.isPending,
  };
}
