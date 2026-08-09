import { and, asc, eq, gt, schema, withOrgScope, type TenantDb } from '@taskflow/db';
import { errors, type OrgId } from '@taskflow/contracts';

/**
 * The org directory (ai/phase-11.5-people.md §3.9, Wave 1).
 *
 * Reads are ordinary tenant-scoped joins: memberships × users (identity) ×
 * profiles (personal) × membership_profiles (org-scoped), all through
 * `withOrgScope` with RLS confining membership rows to the caller's org.
 * `people.profiles` has no RLS by design (migration 0030) — a display name or
 * timezone is not secret from other people in a shared org — and the org
 * membership join is what confines the result set.
 *
 * `route({ permission: 'member:read' })` at the route is the whole
 * authorization story, exactly as `docs.space.service.ts`'s `listSpaces`
 * argues for its own listing: a member carries no per-person tuples, so there
 * is nothing a resource-level `enforce()` could add.
 *
 * ## The cursor is the membership's user id
 *
 * User ids are UUIDv7 — creation-ordered AND unique — so `user_id > cursor`
 * is a total order with no ties, unlike a `joined_at` cursor (two members
 * joining in the same instant) or an offset (which drifts when rows move
 * between pages). Same reasoning chat's read cursors give for message ids.
 */

export interface DirectoryMember {
  readonly userId: string;
  readonly email: string;
  readonly displayName: string | null;
  readonly timezone: string | null;
  readonly workingHoursStart: string | null;
  readonly workingHoursEnd: string | null;
  readonly workingDays: readonly number[] | null;
  readonly oooFrom: Date | null;
  readonly oooUntil: Date | null;
  readonly oooMessage: string | null;
  readonly jobTitle: string | null;
  readonly department: string | null;
  /** E.164 work number (migration 0039) — what click-to-call dials. */
  readonly workPhone: string | null;
  readonly managerUserId: string | null;
  readonly role: string;
}

/** Cursor-paginated directory listing (§7 decision: paginate from Wave 1). */
export async function listDirectory(
  orgId: OrgId,
  cursor: string | null,
  limit: number,
): Promise<{ readonly members: readonly DirectoryMember[]; readonly nextCursor: string | null }> {
  return withOrgScope(orgId, async (tx) => {
    const rows = await tx
      .select(MEMBER_COLUMNS)
      .from(schema.memberships)
      .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
      .leftJoin(schema.profiles, eq(schema.profiles.userId, schema.memberships.userId))
      .leftJoin(
        schema.membershipProfiles,
        and(
          eq(schema.membershipProfiles.orgId, orgId),
          eq(schema.membershipProfiles.userId, schema.memberships.userId),
        ),
      )
      .where(and(...(cursor === null ? [] : [gt(schema.memberships.userId, cursor)])))
      .orderBy(asc(schema.memberships.userId))
      .limit(limit + 1);

    // One extra row tells us "there is more" without a COUNT query.
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];

    return {
      members: page.map(toMember),
      nextCursor: hasMore && last !== undefined ? last.userId : null,
    };
  });
}

export interface ResolvedMember {
  readonly userId: string;
  readonly displayName: string | null;
  readonly email: string;
}

export interface DirectoryMemberDetail extends DirectoryMember {
  /** The manager's identity, resolved for a linked header — null when unset. */
  readonly manager: ResolvedMember | null;
  /** Everyone who reports directly to this member, ordered by user id. */
  readonly directReports: readonly ResolvedMember[];
}

/** One member's full profile, plus manager and direct reports (the org chart view). */
export async function getDirectoryMember(
  orgId: OrgId,
  userId: string,
): Promise<DirectoryMemberDetail> {
  return withOrgScope(orgId, async (tx) => {
    const rows = await tx
      .select(MEMBER_COLUMNS)
      .from(schema.memberships)
      .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
      .leftJoin(schema.profiles, eq(schema.profiles.userId, schema.memberships.userId))
      .leftJoin(
        schema.membershipProfiles,
        and(
          eq(schema.membershipProfiles.orgId, orgId),
          eq(schema.membershipProfiles.userId, schema.memberships.userId),
        ),
      )
      .where(and(eq(schema.memberships.orgId, orgId), eq(schema.memberships.userId, userId)))
      .limit(1);

    const row = rows[0];
    // NOT_FOUND rather than a message naming the person: across tenants, the
    // 404 confirms nothing about whether the account exists (§8.7).
    if (!row) throw errors.notFound();

    const member = toMember(row);
    const manager =
      member.managerUserId === null ? null : await resolveMember(tx, orgId, member.managerUserId);
    const directReports = await listDirectReports(tx, orgId, userId);

    return { ...member, manager, directReports };
  });
}

/* -------------------------------------------------------------------------- *
 * Plumbing
 * -------------------------------------------------------------------------- */

const MEMBER_COLUMNS = {
  userId: schema.memberships.userId,
  email: schema.users.email,
  displayName: schema.profiles.displayName,
  timezone: schema.profiles.timezone,
  workingHoursStart: schema.profiles.workingHoursStart,
  workingHoursEnd: schema.profiles.workingHoursEnd,
  workingDays: schema.profiles.workingDays,
  oooFrom: schema.profiles.oooFrom,
  oooUntil: schema.profiles.oooUntil,
  oooMessage: schema.profiles.oooMessage,
  jobTitle: schema.membershipProfiles.jobTitle,
  department: schema.membershipProfiles.department,
  workPhone: schema.membershipProfiles.workPhone,
  managerUserId: schema.membershipProfiles.managerUserId,
  role: schema.memberships.role,
} as const;

/**
 * A directory join row. Written out rather than derived from the column
 * objects because the LEFT JOINs make every profiles/membership_profiles
 * column nullable, and the column object's own `data` type says otherwise.
 */
interface MemberRow {
  readonly userId: string;
  readonly email: string;
  readonly displayName: string | null;
  readonly timezone: string | null;
  readonly workingHoursStart: string | null;
  readonly workingHoursEnd: string | null;
  readonly workingDays: number[] | null;
  readonly oooFrom: Date | null;
  readonly oooUntil: Date | null;
  readonly oooMessage: string | null;
  readonly jobTitle: string | null;
  readonly department: string | null;
  readonly workPhone: string | null;
  readonly managerUserId: string | null;
  readonly role: string;
}

function toMember(row: MemberRow): DirectoryMember {
  return {
    userId: row.userId,
    email: row.email,
    displayName: row.displayName,
    timezone: row.timezone,
    workingHoursStart: row.workingHoursStart,
    workingHoursEnd: row.workingHoursEnd,
    workingDays: row.workingDays,
    oooFrom: row.oooFrom,
    oooUntil: row.oooUntil,
    oooMessage: row.oooMessage,
    jobTitle: row.jobTitle,
    department: row.department,
    workPhone: row.workPhone,
    managerUserId: row.managerUserId,
    role: row.role,
  };
}

/**
 * Resolves a member's identity for the manager/direct-reports links.
 *
 * The manager FK is `ON DELETE SET NULL`, so a `managerUserId` always names a
 * membership that exists — but a resolved NAME is a join, not a promise, and
 * a display name is user-supplied text that reaches a label and nothing else.
 */
async function resolveMember(tx: TenantDb, orgId: OrgId, userId: string): Promise<ResolvedMember> {
  const rows = await tx
    .select({
      userId: schema.memberships.userId,
      displayName: schema.profiles.displayName,
      email: schema.users.email,
    })
    .from(schema.memberships)
    .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
    .leftJoin(schema.profiles, eq(schema.profiles.userId, schema.memberships.userId))
    .where(and(eq(schema.memberships.orgId, orgId), eq(schema.memberships.userId, userId)))
    .limit(1);

  const row = rows[0];
  if (!row) throw errors.notFound();
  return { userId: row.userId, displayName: row.displayName, email: row.email };
}

async function listDirectReports(
  tx: TenantDb,
  orgId: OrgId,
  managerUserId: string,
): Promise<readonly ResolvedMember[]> {
  const rows = await tx
    .select({
      userId: schema.membershipProfiles.userId,
      displayName: schema.profiles.displayName,
      email: schema.users.email,
    })
    .from(schema.membershipProfiles)
    .innerJoin(schema.users, eq(schema.users.id, schema.membershipProfiles.userId))
    .leftJoin(schema.profiles, eq(schema.profiles.userId, schema.membershipProfiles.userId))
    .where(
      and(
        eq(schema.membershipProfiles.orgId, orgId),
        eq(schema.membershipProfiles.managerUserId, managerUserId),
      ),
    )
    .orderBy(asc(schema.membershipProfiles.userId));

  return rows.map((row) => ({
    userId: row.userId,
    displayName: row.displayName,
    email: row.email,
  }));
}
