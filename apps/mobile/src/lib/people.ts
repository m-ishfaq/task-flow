import { isAfter, isPast } from 'date-fns';
import { parseNullableInstant, type Wire } from '@taskflow/client';
import type { MobileTRPCClient } from './trpc-client.js';

/**
 * People (Phase 11.5) — the org directory and one member's detail, the
 * mobile counterpart of `apps/web/src/features/people/api.ts`. Types,
 * query keys, and the one genuinely testable piece of logic
 * (`oooStatus`) only — no `react-native` import anywhere in this file,
 * the same split `work.ts`/`billing.ts`/`telephony.ts` already establish.
 *
 * `people.profile.*` (the caller's OWN profile — display name, timezone,
 * working hours, OOO, the self-serve DSAR export) is NOT here: it already
 * shipped as `profile-section.tsx`/`working-hours-section.tsx`/
 * `export-data-section.tsx` on the Account tab, well before this file
 * existed. What was missing, and what this closes, is `people.directory.*`
 * (`member:read`) and the admin-edit routes (`member:manage`) — a real,
 * separate slice the server itself splits the same way (`people/
 * router.ts`'s own comment on why `profile.*` is a `selfRoute` and
 * `directory.*` needs an org).
 */

export type DirectoryMember = Wire<
  Awaited<ReturnType<MobileTRPCClient['people']['directory']['list']['query']>>
>['members'][number];

export type DirectoryDetail = Wire<
  Awaited<ReturnType<MobileTRPCClient['people']['directory']['get']['query']>>
>;

/** One row of `DirectoryDetail`'s `manager`/`directReports` — a name and id only. */
export type ResolvedMember = NonNullable<DirectoryDetail['manager']>;

export const DIRECTORY_QUERY_KEY = ['people.directory.list'] as const;

/** A plain, single-page read of the directory — the manager picker's own
 *  candidate list (`person/[userId].tsx`'s `AdminSection`), a DIFFERENT
 *  query shape from `DIRECTORY_QUERY_KEY`'s `useInfiniteQuery` pages, so it
 *  needs its own key rather than colliding cache shapes under one. */
export const DIRECTORY_PICKER_QUERY_KEY = ['people.directory.list', 'picker'] as const;

export function directoryMemberQueryKey(userId: string): readonly ['people.directory.get', string] {
  return ['people.directory.get', userId];
}

/**
 * Whether a member is out of office RIGHT NOW — ported verbatim from
 * `apps/web/src/lib/format.ts`'s own `oooStatus`, same clock library
 * (`date-fns`'s `isAfter`/`isPast`), same two-step reasoning: `oooUntil`
 * must still be ahead (a return date already in the past is not an active
 * OOO, just a stale field nobody cleared), and a scheduled `oooFrom` that
 * has not begun yet is a FUTURE absence, not a current one.
 */
export function oooStatus(oooFrom: string | null, oooUntil: string | null): boolean {
  const until = parseNullableInstant(oooUntil);
  if (until === null) return false;

  if (!isAfter(until, new Date())) return false;

  const from = parseNullableInstant(oooFrom);
  return from === null || isPast(from);
}

/** The display name a row/header should show — the same "name, or the
 *  email when nobody set one" rule `use-members.ts`'s `personOf` already
 *  applies elsewhere on this app, restated here for a `DirectoryMember`/
 *  `ResolvedMember`/`DirectoryDetail` row rather than a bare `Member`. */
export function directoryLabel(person: { displayName: string | null; email: string }): string {
  return person.displayName ?? person.email;
}
