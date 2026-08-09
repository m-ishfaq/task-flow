import {
  and,
  count,
  desc,
  eq,
  ilike,
  inArray,
  lt,
  schema,
  withGlobalScope,
  withPlatformAdminScope,
} from '@taskflow/db';

/**
 * The platform-wide user directory — read-only in this wave (§2, §7
 * decision 5: user suspension is a later Phase 12 wave).
 *
 * ⚠ HUMAN REVIEW SURFACE (§2.2).
 *
 * `identity.users` carries no RLS at all (verified: no `ENABLE ROW LEVEL
 * SECURITY` on it anywhere in the migration history) — the same property
 * that lets login resolve any email to an account before any org is known.
 * So this is `withGlobalScope`, correctly this time (§3.6's own correction
 * of the first draft, which proposed reading `identity.orgs` — real tenant
 * data — the same way).
 *
 * `orgCount` needs `identity.memberships`, which is real tenant data
 * `withGlobalScope`'s role (`taskflow_app`) cannot see across tenants —
 * clearing `app.org_id` makes every one of its rows invisible under RLS.
 * `taskflow_platform_admin` can (§3.7's grant), but holds nothing on
 * `identity.users`. Two roles, two reads, joined in memory — the identical
 * shape `orgs.service.ts`'s `listOrgs` uses for `memberCount`, just split
 * across a role boundary instead of a table boundary.
 */

export interface UserDirectoryRow {
  readonly userId: string;
  readonly email: string;
  readonly emailVerifiedAt: Date | null;
  readonly status: string;
  readonly orgCount: number;
  readonly createdAt: Date;
}

export interface ListUsersInput {
  readonly limit: number;
  /** Keyset cursor: return users strictly older than this id. Null starts at the newest. */
  readonly before: string | null;
  /** Case-insensitive match against email. Null/empty lists everything. */
  readonly search: string | null;
}

export interface ListUsersResult {
  readonly users: readonly UserDirectoryRow[];
  readonly nextCursor: string | null;
}

export async function listUsers(input: ListUsersInput): Promise<ListUsersResult> {
  const search = input.search?.trim();

  const rows = await withGlobalScope(async (tx) =>
    tx
      .select({
        userId: schema.users.id,
        email: schema.users.email,
        emailVerifiedAt: schema.users.emailVerifiedAt,
        status: schema.users.status,
        createdAt: schema.users.createdAt,
      })
      .from(schema.users)
      .where(
        and(
          input.before === null ? undefined : lt(schema.users.id, input.before),
          search === undefined || search === '' ? undefined : ilike(schema.users.email, `%${search}%`),
        ),
      )
      .orderBy(desc(schema.users.id))
      .limit(input.limit + 1),
  );

  const page = rows.slice(0, input.limit);
  const nextCursor = rows.length > input.limit ? (page.at(-1)?.userId ?? null) : null;

  if (page.length === 0) return { users: [], nextCursor: null };

  const counts = await withPlatformAdminScope(async (tx) =>
    tx
      .select({ userId: schema.memberships.userId, count: count() })
      .from(schema.memberships)
      .where(
        and(
          inArray(
            schema.memberships.userId,
            page.map((row) => row.userId),
          ),
          // `active` in the org-MEMBERSHIP sense, not the user-account status
          // above — a person can hold a suspended membership in one org and
          // an active one in another; only active memberships count toward
          // "how many organizations is this person really in right now".
          eq(schema.memberships.status, 'active'),
        ),
      )
      .groupBy(schema.memberships.userId),
  );

  const countByUser = new Map(counts.map((row) => [row.userId, row.count]));

  return {
    users: page.map((row) => ({
      ...row,
      orgCount: countByUser.get(row.userId) ?? 0,
    })),
    nextCursor,
  };
}
