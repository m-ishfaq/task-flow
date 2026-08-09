import { queryOptions } from '@tanstack/react-query';
import { api } from '../../lib/trpc.js';
import { keys } from '../../lib/query.js';
import { wire, type Wire } from '../../lib/wire.js';

/**
 * People (Phase 11.5) — the profile surface: the org directory, one member's
 * detail, and the caller's own profile.
 *
 * Two shapes of route live behind these hooks:
 *
 *   - `people.profile.get/update` are SELF routes — they answer with no org
 *     selected (the `/account` page), so they are keyed like `keys.me()`,
 *     not under `['org', orgId]`.
 *   - `people.directory.*` / `people.membershipProfile.update` /
 *     `people.reportingLine.set` are org routes (`member:read` / `member:manage`),
 *     keyed under the org like every other tenant query.
 */

interface Outputs {
  profile: Awaited<ReturnType<typeof api.people.profile.get.query>>;
  directory: Awaited<ReturnType<typeof api.people.directory.list.query>>;
  member: Awaited<ReturnType<typeof api.people.directory.get.query>>;
}

export type ProfileView = Wire<Outputs['profile']>;
export type DirectoryMember = Wire<Outputs['directory']>['members'][number];
export type DirectoryPage = Wire<Outputs['directory']>;
export type DirectoryDetail = Wire<Outputs['member']>;

/** The caller's own merged profile — self-route, org-independent. */
export function profileQuery() {
  return queryOptions({
    /* Own key, not `keys.me()` — see that key's comment in lib/query.ts: the
       full merged view and the four-field identity shape must not race for
       one cache entry. */
    queryKey: keys.profile(),
    queryFn: async () => wire(await api.people.profile.get.query()),
  });
}

export interface ProfilePatchInput {
  readonly displayName?: string | null;
  readonly timezone?: string | null;
  readonly workingHoursStart?: string | null;
  readonly workingHoursEnd?: string | null;
  readonly workingDays?: readonly number[] | null;
  readonly oooFrom?: string | null;
  readonly oooUntil?: string | null;
  readonly oooMessage?: string | null;
  readonly jobTitle?: string | null;
  readonly department?: string | null;
}

export async function updateProfile(input: ProfilePatchInput) {
  return wire(await api.people.profile.update.mutate(input));
}

/** One page of the directory. The cursor is a user id; null cursor = first page. */
export function directoryQuery(orgId: string, cursor: string | null, limit = 50) {
  return queryOptions({
    queryKey: keys.directory(orgId, cursor),
    queryFn: async () =>
      wire(await api.people.directory.list.query({ cursor: cursor ?? undefined, limit })),
  });
}

export function directoryMemberQuery(orgId: string, userId: string) {
  return queryOptions({
    queryKey: keys.member(orgId, userId),
    queryFn: async () => wire(await api.people.directory.get.query({ userId })),
  });
}

export interface MembershipPatchInput {
  readonly userId: string;
  readonly jobTitle?: string | null;
  readonly department?: string | null;
  /** E.164, or null to clear. Validated server-side (migration 0039). */
  readonly workPhone?: string | null;
}

export async function updateMembershipProfile(input: MembershipPatchInput) {
  return wire(await api.people.membershipProfile.update.mutate(input));
}

export interface ReportingLineInput {
  readonly userId: string;
  readonly managerUserId: string | null;
}

export async function setReportingLine(input: ReportingLineInput) {
  return wire(await api.people.reportingLine.set.mutate(input));
}
