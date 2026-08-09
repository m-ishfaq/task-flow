import {
  and,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  lt,
  schema,
  withGlobalScope,
  withPlatformAdminScope,
} from '@taskflow/db';
import { errors, type RequestId, type UserId } from '@taskflow/contracts';
import { createEvent, type EventBus } from '@taskflow/events';
import { SYSTEM_ORG } from '../identity/identity.service.js';
import { userReactivated, userSuspended } from './events.js';

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
          search === undefined || search === ''
            ? undefined
            : ilike(schema.users.email, `%${search}%`),
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

/**
 * User suspension (Phase 12 Wave 2 §3.1, ai/phase-12-wave2.md) — the direct
 * extension of Wave 1's org suspension.
 *
 * `identity.users` carries no RLS at all (this file's own header, above),
 * so — unlike `orgs.service.ts`'s `suspendOrg`/`reactivateOrg`, which needs
 * `withPlatformAdminScope` to get past `identity.orgs`' `FORCE ROW LEVEL
 * SECURITY` — this is an ordinary `withGlobalScope` write, the same
 * connection `listUsers` above already reads through.
 *
 * `fromStatus` in the `WHERE` clause is the identical "turn a no-op into an
 * honest CONFLICT" reasoning `orgs.service.ts`'s own comment gives — not a
 * race-safety net, just the difference between a caller mistake surfacing
 * and silently doing nothing.
 */

export interface OperatorActor {
  readonly userId: UserId;
  readonly requestId: RequestId;
}

export async function suspendUser(
  userId: string,
  operator: OperatorActor,
  events: EventBus,
): Promise<{ status: 'suspended' }> {
  const updated = await withGlobalScope(async (tx) =>
    tx
      .update(schema.users)
      .set({ status: 'suspended', updatedAt: new Date() })
      .where(and(eq(schema.users.id, userId), eq(schema.users.status, 'active')))
      .returning({ id: schema.users.id }),
  );

  if (updated.length === 0) {
    throw errors.conflict('This account is already suspended, or does not exist.');
  }

  /* Suspending someone means their existing sessions stop working
     immediately, not eventually — the read-side check alone (login/passkey
     already refuse anything but `'active'`) leaves an already-signed-in
     session usable until it naturally expires. `identity.sessions` carries
     no RLS either, so this is the same `withGlobalScope` connection. */
  await withGlobalScope(async (tx) =>
    tx
      .update(schema.sessions)
      .set({ revokedAt: new Date(), revokedReason: 'account_suspended' })
      .where(and(eq(schema.sessions.userId, userId), isNull(schema.sessions.revokedAt))),
  );

  await events.publish([
    createEvent(
      userSuspended,
      { userId, operatorUserId: operator.userId },
      { orgId: SYSTEM_ORG, actorId: operator.userId, occurredAt: new Date() },
    ),
  ]);

  return { status: 'suspended' };
}

export async function reactivateUser(
  userId: string,
  operator: OperatorActor,
  events: EventBus,
): Promise<{ status: 'active' }> {
  const updated = await withGlobalScope(async (tx) =>
    tx
      .update(schema.users)
      .set({ status: 'active', updatedAt: new Date() })
      .where(and(eq(schema.users.id, userId), eq(schema.users.status, 'suspended')))
      .returning({ id: schema.users.id }),
  );

  if (updated.length === 0) {
    throw errors.conflict('This account is not suspended, or does not exist.');
  }

  await events.publish([
    createEvent(
      userReactivated,
      { userId, operatorUserId: operator.userId },
      { orgId: SYSTEM_ORG, actorId: operator.userId, occurredAt: new Date() },
    ),
  ]);

  return { status: 'active' };
}
