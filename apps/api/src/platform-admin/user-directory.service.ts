import {
  and,
  coalesceColumns,
  countRows,
  desc,
  eq,
  isNull,
  lt,
  or,
  schema,
  withGlobalScope,
  withPlatformAdminScope,
} from '@taskflow/db';
import { errors } from '@taskflow/contracts';
import { createEvent, type EventBus } from '@taskflow/events';
import { recordOperatorAction } from './audit.js';
import { encodeCreatedCursor, parseCreatedCursor } from './pagination.js';
import { userReactivated, userSuspended } from './events.js';
import { SYSTEM_ORG } from '../identity/identity.service.js';
import type { PlatformOperator } from './org-directory.service.js';

/**
 * The user directory, and account suspension.
 *
 * Wave 1 shipped this file read-only on purpose (ai/phase-12-admin.md §3.6;
 * §7 decision 5 deferred user suspension), and Wave 2 §3.1 is where that
 * deferral is taken back up — `suspendUser`/`reactivateUser` at the bottom of
 * this file are the direct extension of Wave 1's org suspension.
 *
 * ## Two scopes in one file, and why that is correct rather than sloppy
 *
 * `identity.users` carries NO RLS at all — the same property that lets login
 * resolve any email to an account before any org is known — so the users read
 * runs in `withGlobalScope`, the one legitimately non-tenant read in this
 * module. But `orgCount` needs `identity.memberships`, which IS tenant-scoped
 * under FORCE RLS, and the only connection that can see it across every org
 * is `taskflow_platform_admin` (migration 0035's `memberships_platform_admin_read`
 * policy). So the count runs in its own `withPlatformAdminScope` query and the
 * two are merged in JavaScript. The alternative — reading users through the
 * platform-admin connection too — would work, but it is the wrong tool for a
 * table RLS was never applied to, and mixing the two tools in one file with
 * each used where it belongs is exactly what a later reader can trust.
 */
export interface UserDirectoryRow {
  readonly userId: string;
  readonly email: string;
  /**
   * From `people.profiles`, NOT `identity.users.display_name`.
   *
   * That column still exists and is explicitly stale — Phase 11.5 moved the
   * canonical profile record to `people.profiles` and retired
   * `auth.updateProfile`, so nothing has written the identity column since
   * (see `identity/router.ts`'s comment on `me`). Reading it here would show
   * an operator a name the owner changed months ago and cannot change again.
   *
   * `people.profiles` is a non-tenant table — no `org_id`, no RLS (migration
   * 0030's header) — which is what lets it join inside the same
   * `withGlobalScope` query as the users read rather than needing the
   * platform-admin connection the org-count aggregate below does.
   *
   * Null for an account that has never set one; the console falls back to the
   * email it already shows.
   */
  readonly name: string | null;
  readonly emailVerifiedAt: Date | null;
  readonly status: string;
  readonly orgCount: number;
  readonly createdAt: Date;
}

/** Every account, newest first, keyset-paginated. */
export async function listUsers(
  operator: PlatformOperator,
  input: { readonly cursor: string | null; readonly limit: number },
): Promise<{ readonly users: readonly UserDirectoryRow[]; readonly nextCursor: string | null }> {
  const cursor = parseCreatedCursor(input.cursor);

  const rows = await withGlobalScope(async (tx) => {
    const query = tx
      .select({
        userId: schema.users.id,
        email: schema.users.email,
        /* LEFT, not INNER: a profile row is created lazily, so an account
           that has never opened the account page has none — and an inner
           join would silently drop exactly those users from the operator's
           directory, which is the population most worth seeing. */
        name: coalesceColumns(schema.profiles.displayName, schema.users.displayName),
        emailVerifiedAt: schema.users.emailVerifiedAt,
        status: schema.users.status,
        createdAt: schema.users.createdAt,
      })
      .from(schema.users)
      .leftJoin(schema.profiles, eq(schema.profiles.userId, schema.users.id))
      .orderBy(desc(schema.users.createdAt), desc(schema.users.id))
      .limit(input.limit + 1);

    if (cursor !== null) {
      /* The same (created_at, id) < (cursorDate, cursorId) tuple comparison
         org-directory uses, expressed as a disjunction. */
      query.where(
        or(
          lt(schema.users.createdAt, cursor.createdAt),
          and(eq(schema.users.createdAt, cursor.createdAt), lt(schema.users.id, cursor.rowId)),
        ),
      );
    }
    return query;
  });

  /* The count query: one aggregate per user over ACTIVE memberships, as the
     platform-admin role (see the file header for why it cannot run in the
     same scope as the users read). */
  const counts = await withPlatformAdminScope(async (tx) =>
    tx
      .select({
        userId: schema.memberships.userId,
        count: countRows(schema.memberships.id),
      })
      .from(schema.memberships)
      .where(eq(schema.memberships.status, 'active'))
      .groupBy(schema.memberships.userId),
  );
  const countByUser = new Map(counts.map((row) => [row.userId, Number(row.count)]));

  await recordOperatorAction(operator.userId, 'users.list', null);

  const hasMore = rows.length > input.limit;
  const page = hasMore ? rows.slice(0, input.limit) : rows;
  const last = page[page.length - 1];

  return {
    users: page.map((row) => ({
      userId: row.userId,
      email: row.email,
      name: row.name,
      emailVerifiedAt: row.emailVerifiedAt,
      status: row.status,
      orgCount: countByUser.get(row.userId) ?? 0,
      createdAt: row.createdAt,
    })),
    nextCursor:
      hasMore && last !== undefined ? encodeCreatedCursor(last.createdAt, last.userId) : null,
  };
}

/**
 * Account suspension (Phase 12 Wave 2 §3.1) — the direct extension of Wave 1's
 * org suspension, and deliberately simpler than it in one way and stricter in
 * another.
 *
 * Simpler: `identity.users` carries NO RLS at all (this file's own header),
 * so this is an ordinary `withGlobalScope` write — the same connection
 * `listUsers` above already reads through. `suspendOrg` needs
 * `withPlatformAdminScope` only because `identity.orgs` has FORCE ROW LEVEL
 * SECURITY; there is nothing here for that role to get past.
 *
 * Stricter: suspending someone REVOKES THEIR LIVE SESSIONS rather than
 * waiting for them to expire. `login` and the passkey ceremony already refuse
 * any status but `'active'`, so read-side enforcement alone would still leave
 * an already-signed-in tab working for up to its natural lifetime — which is
 * precisely the window that matters when an account is being frozen for
 * cause.
 *
 * `fromStatus` in the WHERE clause is the same "turn a silent no-op into an
 * honest CONFLICT" reasoning `org-directory.service.ts` gives: not a
 * race-safety net, just the difference between a caller's mistake surfacing
 * and appearing to succeed.
 *
 * Unlike `suspendOrg`, there is NO target-org audit write — see
 * `events.ts`'s comment on `userSuspended` for why a person has no single
 * chain to belong to. The operator chain is the durable record.
 */
export async function suspendUser(
  deps: { readonly events: EventBus },
  operator: PlatformOperator,
  userId: string,
): Promise<{ readonly userId: string; readonly status: 'suspended' }> {
  const now = new Date();

  const updated = await withGlobalScope(async (tx) =>
    tx
      .update(schema.users)
      .set({ status: 'suspended', updatedAt: now })
      .where(and(eq(schema.users.id, userId), eq(schema.users.status, 'active')))
      .returning({ id: schema.users.id }),
  );

  if (updated.length === 0) {
    throw errors.conflict('This account is already suspended, or does not exist.');
  }

  /* `identity.sessions` carries no RLS either, so the revocation runs on the
     same connection. Unconditional on the live rows rather than per-session:
     the point is that nothing survives the suspension. */
  await withGlobalScope(async (tx) =>
    tx
      .update(schema.sessions)
      .set({ revokedAt: now, revokedReason: 'account_suspended' })
      .where(and(eq(schema.sessions.userId, userId), isNull(schema.sessions.revokedAt))),
  );

  await recordOperatorAction(operator.userId, 'users.suspend', { userId });

  await deps.events.publish([
    createEvent(
      userSuspended,
      { userId, operatorUserId: operator.userId },
      {
        orgId: SYSTEM_ORG,
        actorId: operator.userId,
        requestId: operator.requestId,
        occurredAt: now,
      },
    ),
  ]);

  return { userId, status: 'suspended' as const };
}

/**
 * The inverse of `suspendUser`.
 *
 * Deliberately does NOT un-revoke the sessions `suspendUser` killed: a
 * revoked session is a terminal state everywhere else in identity, and
 * resurrecting one would mean a token that was refused for a period starts
 * being accepted again. Reactivation restores the ability to sign in, not the
 * sessions that existed before.
 */
export async function reactivateUser(
  deps: { readonly events: EventBus },
  operator: PlatformOperator,
  userId: string,
): Promise<{ readonly userId: string; readonly status: 'active' }> {
  const now = new Date();

  const updated = await withGlobalScope(async (tx) =>
    tx
      .update(schema.users)
      .set({ status: 'active', updatedAt: now })
      .where(and(eq(schema.users.id, userId), eq(schema.users.status, 'suspended')))
      .returning({ id: schema.users.id }),
  );

  if (updated.length === 0) {
    throw errors.conflict('This account is not suspended, or does not exist.');
  }

  await recordOperatorAction(operator.userId, 'users.reactivate', { userId });

  await deps.events.publish([
    createEvent(
      userReactivated,
      { userId, operatorUserId: operator.userId },
      {
        orgId: SYSTEM_ORG,
        actorId: operator.userId,
        requestId: operator.requestId,
        occurredAt: now,
      },
    ),
  ]);

  return { userId, status: 'active' as const };
}
