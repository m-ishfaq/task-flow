import {
  and,
  countRows,
  desc,
  eq,
  insertAuditEntry,
  lt,
  or,
  schema,
  withAuditScope,
  withPlatformAdminScope,
} from '@taskflow/db';
import {
  AppError,
  errors,
  type OrgId,
  type RequestId,
  type SubaccountStatus,
  type UserId,
} from '@taskflow/contracts';
import { createEvent, type EventBus } from '@taskflow/events';
import { newId } from '@taskflow/security';
import { setSubaccountStatus, type SubaccountDeps } from '../telephony/subaccount.service.js';
import { orgReactivated, orgSuspended } from './events.js';
import { recordOperatorAction } from './audit.js';
import { encodeCreatedCursor, parseCreatedCursor } from './pagination.js';

/**
 * The org directory — the platform console's cross-tenant view of
 * `identity.orgs` (ai/phase-12-admin.md §3.6, §3.7).
 *
 * ⚠ HUMAN REVIEW SURFACE (§2.2): every read here runs as
 * `taskflow_platform_admin`, the role that bypasses tenant isolation on the
 * control-plane tables. The role is NOBYPASSRLS and reaches across orgs ONLY
 * through the policies migration 0035 adds — never through a superuser
 * shortcut, and never onto a product table. The writes in this file are the
 * whole wave's enforcement story: an operator can change `identity.orgs.status`
 * and nothing else, and §6's tests prove that is the only column the service
 * ever sets through this connection.
 */

/** Who is acting, and the request that is acting. */
export interface PlatformOperator {
  readonly userId: UserId;
  readonly requestId: RequestId;
}

export interface OrgDirectoryRow {
  readonly orgId: string;
  readonly name: string;
  readonly slug: string;
  readonly status: string;
  readonly createdAt: Date;
  /** Active memberships only — counting a suspended or former member inflates the directory. */
  readonly memberCount: number;
}

/**
 * Every org, newest first, keyset-paginated.
 *
 * Read as `taskflow_platform_admin` — NOT `withGlobalScope`, which is exactly
 * the failure §3.7 exists to prevent: `identity.orgs` has FORCE RLS keyed on
 * `app.org_id`, and a scope that clears both session variables makes every
 * policy evaluate to false, so the read would silently return an empty list
 * that a smoke test could misread as "no orgs exist yet". The dedicated role's
 * permissive policies are what make this query mean anything.
 */
export async function listOrgs(
  operator: PlatformOperator,
  input: { readonly cursor: string | null; readonly limit: number },
): Promise<{ readonly orgs: readonly OrgDirectoryRow[]; readonly nextCursor: string | null }> {
  const cursor = parseCreatedCursor(input.cursor);

  const rows = await withPlatformAdminScope(async (tx) => {
    const query = tx
      .select({
        orgId: schema.orgs.id,
        name: schema.orgs.name,
        slug: schema.orgs.slug,
        status: schema.orgs.status,
        createdAt: schema.orgs.createdAt,
        memberCount: countRows(schema.memberships.id),
      })
      .from(schema.orgs)
      .leftJoin(
        schema.memberships,
        and(eq(schema.memberships.orgId, schema.orgs.id), eq(schema.memberships.status, 'active')),
      )
      .groupBy(schema.orgs.id)
      .orderBy(desc(schema.orgs.createdAt), desc(schema.orgs.id))
      .limit(input.limit + 1);

    if (cursor !== null) {
      /* The tuple comparison (created_at, id) < (cursorDate, cursorId), per
         pagination.ts. Ordering must match the ORDER BY exactly, or a page
         boundary repeats or drops a row. */
      query.where(
        or(
          lt(schema.orgs.createdAt, cursor.createdAt),
          and(eq(schema.orgs.createdAt, cursor.createdAt), lt(schema.orgs.id, cursor.rowId)),
        ),
      );
    }
    return query;
  });

  /* Every operator action lands in the global chain — including a read
     (§5's acceptance criterion). Done AFTER the read succeeds, so a failed
     read leaves no row claiming it happened. */
  await recordOperatorAction(operator.userId, 'orgs.list', null);

  const hasMore = rows.length > input.limit;
  const page = hasMore ? rows.slice(0, input.limit) : rows;
  const last = page[page.length - 1];

  return {
    orgs: page.map((row) => ({
      orgId: row.orgId,
      name: row.name,
      slug: row.slug,
      status: row.status,
      createdAt: row.createdAt,
      memberCount: Number(row.memberCount),
    })),
    nextCursor:
      hasMore && last !== undefined ? encodeCreatedCursor(last.createdAt, last.orgId) : null,
  };
}

/**
 * Suspends an org: `identity.orgs.status` -> 'suspended' (§3.3, §3.7).
 *
 * Enforcement is free from the moment this lands, because the check that
 * matters lives in `resolveOrgMembership` — the function every org-scoped
 * tRPC route, every realtime room join, and every collab page authorization
 * run through. This function only flips the column.
 *
 * TWO audit destinations, per §4 decision 2 option (c): the target org's own
 * hash-chained `audit.audit_log` (an Owner sees "a platform operator
 * suspended this org" with no operator access required) AND the global
 * operator chain. The org-scoped write and these two records cannot be one
 * transaction — the mutation runs as `taskflow_platform_admin` and the audit
 * entry as `taskflow_audit`, on different pools — so the ordering below is
 * deliberate: write, then record, and a failure after the write leaves the
 * org suspended but the records written on the retry, never a record without
 * the write.
 *
 * When a carrier is configured (§9), the org's Twilio subaccount is frozen
 * too, LAST and best-effort — see `syncSubaccountStatus`.
 */
export async function suspendOrg(
  deps: { readonly events: EventBus; readonly subaccounts?: SubaccountDeps },
  operator: PlatformOperator,
  orgId: OrgId,
): Promise<{ readonly orgId: OrgId; readonly status: 'suspended' }> {
  const now = new Date();

  await withPlatformAdminScope(async (tx) => {
    const existing = await tx
      .select({ id: schema.orgs.id, status: schema.orgs.status })
      .from(schema.orgs)
      .where(eq(schema.orgs.id, orgId))
      .limit(1);

    const org = existing[0];
    /* A missing org, and a deleted org, answer the same NOT_FOUND: the
       console confirming "that org used to exist" leaks a fact the
       cross-tenant-privacy rule keeps covered. */
    if (!org || org.status === 'deleted') throw errors.notFound();

    await tx
      .update(schema.orgs)
      .set({ status: 'suspended', updatedAt: now })
      .where(eq(schema.orgs.id, orgId));
  });

  /* The org's own chain. `insertAuditEntry` omits seq/prev_hash/hash — the
     trigger assigns all three under the per-org chain-head lock, the same
     exactly-once machinery the projection uses. */
  await withAuditScope(async (tx) => {
    await insertAuditEntry(tx, {
      id: newId<'EventId'>(),
      orgId,
      occurredAt: now,
      actorId: operator.userId,
      action: 'platform.org_suspended',
      resourceType: 'org',
      resourceId: orgId,
      changes: { orgId, operatorUserId: operator.userId },
      requestId: operator.requestId,
    });
  });

  await recordOperatorAction(operator.userId, 'orgs.suspend', { orgId });

  /* The typed event — guardrail 11, and Phase 7's org-freeze subscription
     point (§9). Published on the bus, not the outbox: the platform-admin
     role holds nothing on platform.outbox (see events.ts's header). */
  await deps.events.publish([
    createEvent(
      orgSuspended,
      { orgId, operatorUserId: operator.userId },
      { orgId, actorId: operator.userId, requestId: operator.requestId, occurredAt: now },
    ),
  ]);

  /* §9, the carrier half. After the write, the audits, and the event — the
     freeze is the follow-through, never the gate. */
  if (deps.subaccounts !== undefined) {
    await syncSubaccountStatus(deps.subaccounts, orgId, operator, 'suspended');
  }

  return { orgId, status: 'suspended' as const };
}

/** The inverse of `suspendOrg` — status back to 'active', same two chains. */
export async function reactivateOrg(
  deps: { readonly events: EventBus; readonly subaccounts?: SubaccountDeps },
  operator: PlatformOperator,
  orgId: OrgId,
): Promise<{ readonly orgId: OrgId; readonly status: 'active' }> {
  const now = new Date();

  await withPlatformAdminScope(async (tx) => {
    const existing = await tx
      .select({ id: schema.orgs.id, status: schema.orgs.status })
      .from(schema.orgs)
      .where(eq(schema.orgs.id, orgId))
      .limit(1);

    const org = existing[0];
    if (!org || org.status === 'deleted') throw errors.notFound();

    await tx
      .update(schema.orgs)
      .set({ status: 'active', updatedAt: now })
      .where(eq(schema.orgs.id, orgId));
  });

  await withAuditScope(async (tx) => {
    await insertAuditEntry(tx, {
      id: newId<'EventId'>(),
      orgId,
      occurredAt: now,
      actorId: operator.userId,
      action: 'platform.org_reactivated',
      resourceType: 'org',
      resourceId: orgId,
      changes: { orgId, operatorUserId: operator.userId },
      requestId: operator.requestId,
    });
  });

  await recordOperatorAction(operator.userId, 'orgs.reactivate', { orgId });

  await deps.events.publish([
    createEvent(
      orgReactivated,
      { orgId, operatorUserId: operator.userId },
      { orgId, actorId: operator.userId, requestId: operator.requestId, occurredAt: now },
    ),
  ]);

  if (deps.subaccounts !== undefined) {
    await syncSubaccountStatus(deps.subaccounts, orgId, operator, 'active');
  }

  return { orgId, status: 'active' as const };
}

/**
 * Freezes or unfreezes the org's carrier subaccount (ai/phase-12-admin.md
 * §9) — the half of a suspension that holds OUTSIDE the application.
 *
 * Refusing outbound actions in `checkOutboundAllowed` stops THIS application
 * from spending; it does nothing about a leaked subaccount credential used
 * directly against Twilio, which answers to whoever holds the token. So the
 * carrier is updated too, through the telephony module's own
 * `setSubaccountStatus` (reused, never reimplemented — its carrier-failure
 * half already records `carrierUpdated: false` rather than throwing).
 *
 * Deliberately BEST EFFORT and deliberately LAST: the org is already
 * suspended (or reactivated) and fully audited when this runs, so a missing
 * subaccount — NOT_FOUND, the normal case for most orgs — or a database blip
 * must never turn a completed operator action into an error. The
 * `TelephonyActor`'s role and tuples are inert on this path: the service
 * consumes only `subject.orgId` and `subject.userId` (for the event
 * envelope); this is an internal system-to-system call, not an authorization
 * check.
 */
async function syncSubaccountStatus(
  deps: SubaccountDeps,
  orgId: OrgId,
  operator: PlatformOperator,
  status: SubaccountStatus,
): Promise<void> {
  try {
    await setSubaccountStatus(
      {
        subject: { orgId, userId: operator.userId, role: 'owner', tuples: [] },
        requestId: operator.requestId,
      },
      deps,
      status,
    );
  } catch (error) {
    if (error instanceof AppError && error.code === 'NOT_FOUND') return;
    /* Best effort by design — see the doc above. A real failure here (the
       freeze recorded as `carrierUpdated: false`, or a database blip) is
       swallowed rather than failing the suspension; the org-status write is
       the enforcement, and coupling it to the carrier would turn a Twilio
       outage into an operator console outage. */
  }
}
