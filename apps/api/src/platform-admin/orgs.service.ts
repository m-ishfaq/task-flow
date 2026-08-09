import {
  and,
  count,
  desc,
  eq,
  ilike,
  inArray,
  lt,
  or,
  outboxWriter,
  schema,
  withOrgScope,
  withPlatformAdminScope,
} from '@taskflow/db';
import { errors, type OrgId, type RequestId, type UserId } from '@taskflow/contracts';
import { createEvent } from '@taskflow/events';
import { orgReactivated, orgSuspended } from './events.js';

/**
 * The org directory and suspend/reactivate (Phase 12 §3.6, §3.7).
 *
 * ⚠ HUMAN REVIEW SURFACE (§2.2), same as everything else in this module.
 *
 * ## Two roles, two transactions, and that is a structural fact, not a shortcut
 *
 * `identity.orgs.status` can only be written as `taskflow_platform_admin`
 * (§3.7's own grant). `platform.outbox` can only be written as `taskflow_app`,
 * scoped to the target org — `withPlatformAdminScope` clears BOTH session
 * variables, so the outbox's `WITH CHECK (org_id = app.org_id)` would refuse
 * a write from that connection even if it were granted one, which it is not.
 * These are two different Postgres roles on two different connection pools;
 * there is no single transaction that could span both. So `suspendOrg`/
 * `reactivateOrg` below are two transactions, in a fixed order: the STATUS
 * write (the actual effect) happens first, the EVENT write (the audit
 * record) second. A crash between them leaves the org correctly suspended
 * with an incomplete trail, never the reverse — an org that looks suspended
 * in the audit log while still answering requests. The operator-log entry
 * (§4, "every call is audited") is written by the router wrapper regardless
 * of which of these two succeeded, for the identical reason.
 */

export interface OperatorActor {
  readonly userId: UserId;
  readonly requestId: RequestId;
}

export interface OrgDirectoryRow {
  readonly orgId: string;
  readonly name: string;
  readonly slug: string;
  readonly status: string;
  readonly memberCount: number;
  readonly createdAt: Date;
}

export interface ListOrgsInput {
  readonly limit: number;
  /** Keyset cursor: return orgs strictly older than this id. Null starts at the newest. */
  readonly before: string | null;
  /** Case-insensitive match against name or slug. Null/empty lists everything. */
  readonly search: string | null;
}

export interface ListOrgsResult {
  readonly orgs: readonly OrgDirectoryRow[];
  /** Present when another page exists. */
  readonly nextCursor: string | null;
}

/**
 * The platform-wide org directory. Ids are UUIDv7 (§7.1) — lexicographically
 * sortable by creation time — so `ORDER BY id DESC` is "newest first" and a
 * plain `id <` comparison is a valid keyset cursor, the identical trick
 * `readAuditEntries` uses on `seq`.
 */
export async function listOrgs(input: ListOrgsInput): Promise<ListOrgsResult> {
  return withPlatformAdminScope(async (tx) => {
    const search = input.search?.trim();
    const searchClause =
      search === undefined || search === ''
        ? undefined
        : or(ilike(schema.orgs.name, `%${search}%`), ilike(schema.orgs.slug, `%${search}%`));

    const rows = await tx
      .select({
        orgId: schema.orgs.id,
        name: schema.orgs.name,
        slug: schema.orgs.slug,
        status: schema.orgs.status,
        createdAt: schema.orgs.createdAt,
      })
      .from(schema.orgs)
      .where(
        and(
          input.before === null ? undefined : lt(schema.orgs.id, input.before),
          searchClause,
        ),
      )
      .orderBy(desc(schema.orgs.id))
      // One extra row, never returned, only to answer "is there a next page"
      // without a second round trip.
      .limit(input.limit + 1);

    const page = rows.slice(0, input.limit);
    const nextCursor = rows.length > input.limit ? (page.at(-1)?.orgId ?? null) : null;

    if (page.length === 0) return { orgs: [], nextCursor: null };

    /* Batched, not N+1: one grouped count for every org on this page. */
    const counts = await tx
      .select({ orgId: schema.memberships.orgId, count: count() })
      .from(schema.memberships)
      .where(
        and(
          inArray(
            schema.memberships.orgId,
            page.map((row) => row.orgId),
          ),
          eq(schema.memberships.status, 'active'),
        ),
      )
      .groupBy(schema.memberships.orgId);

    const countByOrg = new Map(counts.map((row) => [row.orgId, row.count]));

    return {
      orgs: page.map((row) => ({
        ...row,
        memberCount: countByOrg.get(row.orgId) ?? 0,
      })),
      nextCursor,
    };
  });
}

/**
 * `fromStatus` in the WHERE clause is not a race-safety net — a single
 * UPDATE is already atomic — it is what turns "suspend an
 * already-suspended org" from a silent no-op into an honest CONFLICT, the
 * same reasoning `changeRole`'s `sameRole` short-circuit documents for a
 * no-op role change, except here a no-op is a caller mistake worth
 * surfacing rather than a legitimate idempotent retry.
 *
 * Inlined into both `suspendOrg` and `reactivateOrg` below rather than
 * factored into a shared helper: guardrail 11's lint rule treats each
 * top-level function as its own unit, and a helper doing the `tx.update`
 * with the emit left in the caller reads, to that rule, as a mutation with
 * no event — correctly, since nothing STRUCTURALLY ties the two together
 * for a caller who only calls the helper. Two call sites, ten lines each;
 * not worth a shared function that the guardrail would have to be taught to
 * see through.
 */
export async function suspendOrg(
  orgId: OrgId,
  operator: OperatorActor,
): Promise<{ status: 'suspended' }> {
  const updated = await withPlatformAdminScope(async (tx) =>
    tx
      .update(schema.orgs)
      .set({ status: 'suspended', updatedAt: new Date() })
      .where(and(eq(schema.orgs.id, orgId), eq(schema.orgs.status, 'active')))
      .returning({ id: schema.orgs.id }),
  );

  if (updated.length === 0) {
    throw errors.conflict('This organization is already suspended, or does not exist.');
  }

  await withOrgScope(orgId, async (tx) => {
    await outboxWriter.append(tx, [
      createEvent(
        orgSuspended,
        { orgId, operatorUserId: operator.userId },
        { orgId, actorId: operator.userId, requestId: operator.requestId },
      ),
    ]);
  });

  return { status: 'suspended' };
}

export async function reactivateOrg(
  orgId: OrgId,
  operator: OperatorActor,
): Promise<{ status: 'active' }> {
  const updated = await withPlatformAdminScope(async (tx) =>
    tx
      .update(schema.orgs)
      .set({ status: 'active', updatedAt: new Date() })
      .where(and(eq(schema.orgs.id, orgId), eq(schema.orgs.status, 'suspended')))
      .returning({ id: schema.orgs.id }),
  );

  if (updated.length === 0) {
    throw errors.conflict('This organization is not suspended, or does not exist.');
  }

  await withOrgScope(orgId, async (tx) => {
    await outboxWriter.append(tx, [
      createEvent(
        orgReactivated,
        { orgId, operatorUserId: operator.userId },
        { orgId, actorId: operator.userId, requestId: operator.requestId },
      ),
    ]);
  });

  return { status: 'active' };
}
