import {
  and,
  countRows,
  desc,
  eq,
  insertAuditEntry,
  alias,
  lt,
  minCoalesced,
  minText,
  minUuid,
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
import { renderOrgDeleted, renderOrgSuspended } from '@taskflow/mail';
import type { BillingMailDeps } from '../billing/billing-mail.js';
import { setSubaccountStatus, type SubaccountDeps } from '../telephony/subaccount.service.js';
import { SYSTEM_ORG } from '../identity/identity.service.js';
import { orgDeleted, orgReactivated, orgSuspended } from './events.js';
import { recordOperatorAction } from './audit.js';
import { encodeCreatedCursor, parseCreatedCursor } from './pagination.js';
import { fetchLastInvoices, type LastInvoiceRow } from './invoices.js';
import { getResolvedBranding } from './branding-cache.js';

/**
 * The owner membership, joined a SECOND time under its own name.
 *
 * The directory query already joins memberships to COUNT them; reusing that
 * join to also find the owner would either filter the member count down to one
 * or multiply it by the owner row — both wrong in a way that looks plausible
 * in the UI. Two joins, two purposes.
 */
const ownerMembership = alias(schema.memberships, 'owner_membership');

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
  /* ---------------------------------------------------------------------- *
   * Phase 12 Wave 4: the three questions the directory could not answer.
   *
   * "Which plan is this org on", "are they paying", and "who do I contact"
   * were each a separate lookup — plan and billing state lived only on the
   * Billing tab, and the owner's address was not exposed anywhere at all. An
   * operator triaging a support ticket had to cross-reference two tabs and
   * still could not find a human to email.
   *
   * Joined here rather than fetched per row: this is one page of at most a
   * hundred orgs, and an N+1 in a console list is how a page that was fine
   * with three tenants becomes unusable at three hundred.
   * ---------------------------------------------------------------------- */
  /** Null means not on a plan — the state a trialing org is in. */
  readonly planId: string | null;
  /** `trialing` | `active` | `past_due` | `canceled` — independent of `status`. */
  readonly billingStatus: string;
  /** When the trial runs out, or when the past-due grace period does. */
  readonly trialEndsAt: Date | null;
  readonly billingGraceEndsAt: Date | null;
  /** When the current billing period renews. Null outside an active subscription. */
  readonly currentPeriodEnd: Date | null;
  /** The most recent recorded invoice, or null — see `invoices.ts`'s own header. */
  readonly lastInvoice: LastInvoiceRow | null;
  /**
   * The org's owner, for a support contact.
   *
   * `LIMIT 1` semantics via `min()`: an org has exactly one owner by the role
   * model (`transferOwnership` is one atomic swap with no observable
   * zero-owner or two-owner moment), so picking deterministically rather than
   * aggregating an array is honest here — and if that invariant ever broke,
   * a stable pick beats a random one.
   */
  readonly ownerEmail: string | null;
  /**
   * The owner's display name, when they have set one.
   *
   * LEFT-joined from people.profiles, which is created LAZILY — an account
   * that has never opened the account page has no row, so this is null far
   * more often than an email is. The console renders the name when present
   * and the address always: an operator needs something to type into a
   * support ticket, and a name alone is not that.
   */
  readonly ownerName: string | null;
  /** The owner's user id — for linking to the People console. */
  readonly ownerUserId: string | null;
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
        planId: schema.orgs.planId,
        billingStatus: schema.orgs.billingStatus,
        trialEndsAt: schema.orgs.trialEndsAt,
        billingGraceEndsAt: schema.orgs.billingGraceEndsAt,
        currentPeriodEnd: schema.orgs.currentPeriodEnd,
        /* MIN over the joined owner rows rather than a second query. The join
           below is filtered to role = 'owner', so every non-null value in the
           group is the same address; MIN just collapses the group without
           adding it to GROUP BY. */
        ownerEmail: minText(schema.users.email),
        /* Profile first, signup value second — see coalesceColumns. */
        ownerName: minCoalesced(schema.profiles.displayName, schema.users.displayName),
        ownerUserId: minUuid(ownerMembership.userId),
      })
      .from(schema.orgs)
      .leftJoin(
        schema.memberships,
        and(eq(schema.memberships.orgId, schema.orgs.id), eq(schema.memberships.status, 'active')),
      )
      /* A SECOND membership join, aliased, restricted to the owner — reusing
         the counting join would either filter the member count down to one or
         multiply it by the owner row, and both are wrong in a way that looks
         plausible in the UI. */
      .leftJoin(
        ownerMembership,
        and(
          eq(ownerMembership.orgId, schema.orgs.id),
          eq(ownerMembership.role, 'owner'),
          eq(ownerMembership.status, 'active'),
        ),
      )
      .leftJoin(schema.users, eq(schema.users.id, ownerMembership.userId))
      /* LEFT again — a profile row is lazy, and an inner join here would drop
         the owner (and therefore their email) for anyone who has never opened
         the account page. */
      .leftJoin(schema.profiles, eq(schema.profiles.userId, ownerMembership.userId))
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

  /* ONE query for the whole page rather than one per row — see
     `invoices.ts`'s own header on why this is shared with the Billing tab
     rather than reimplemented here. */
  const invoiceByOrg = await fetchLastInvoices(page.map((row) => row.orgId as OrgId));

  return {
    orgs: page.map((row) => ({
      orgId: row.orgId,
      name: row.name,
      slug: row.slug,
      status: row.status,
      createdAt: row.createdAt,
      planId: row.planId,
      billingStatus: row.billingStatus,
      trialEndsAt: row.trialEndsAt,
      billingGraceEndsAt: row.billingGraceEndsAt,
      currentPeriodEnd: row.currentPeriodEnd,
      lastInvoice: invoiceByOrg.get(row.orgId) ?? null,
      ownerEmail: row.ownerEmail,
      ownerName: row.ownerName,
      ownerUserId: row.ownerUserId,
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
  deps: {
    readonly events: EventBus;
    readonly subaccounts?: SubaccountDeps;
    /** Optional, like `subaccounts` — with none, the org is still suspended, nobody is emailed. */
    readonly mail?: BillingMailDeps;
  },
  operator: PlatformOperator,
  orgId: OrgId,
): Promise<{ readonly orgId: OrgId; readonly status: 'suspended' }> {
  const now = new Date();

  const owner = await withPlatformAdminScope(async (tx) => {
    const existing = await tx
      .select({ id: schema.orgs.id, status: schema.orgs.status, name: schema.orgs.name })
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

    /* Read INSIDE the same transaction the status write is in — an owner who
       was removed a moment earlier must not be emailed about an org they no
       longer have anything to do with. Null is a real answer, not an error:
       an org whose owner account was deleted is still suspendable, and
       failing the operator's action over an unreachable mailbox would be
       backwards. */
    const ownerRows = await tx
      .select({ email: schema.users.email })
      .from(schema.memberships)
      .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
      .where(
        and(
          eq(schema.memberships.orgId, orgId),
          eq(schema.memberships.role, 'owner'),
          eq(schema.memberships.status, 'active'),
        ),
      )
      .limit(1);

    return { orgName: org.name, email: ownerRows[0]?.email ?? null };
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

  /* The owner, told directly — not through the notification projection,
     which has no outbox access for this role to write into (see the file
     header on `orgSuspended`'s event bus publish above) and would batch it
     into a digest regardless. Queued, not awaited: a dead SMTP relay must
     not turn a successful suspension into an error response to the
     operator who just performed it. */
  if (deps.mail !== undefined && owner.email !== null) {
    const { productName } = await getResolvedBranding();
    const rendered = renderOrgSuspended({ orgName: owner.orgName, productName });
    deps.mail.queue.enqueue({ to: owner.email, ...rendered });
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
 * Deletes an org and everything it ever owned (Phase 12 Wave 2 §3.5) — the
 * one operator action in this entire system with no undo.
 *
 * Two gates, in order: the org must already be `'suspended'` (deletion is a
 * two-step operation — suspend, then confirm, then delete — never a single
 * action from `'active'`, giving a real visible waiting period between
 * "this org should go" and "this org is gone forever"), and the operator
 * must type the org's actual slug into the confirmation field (a single
 * confirm-button click is too cheap an action to gate irreversible
 * deletion with).
 *
 * The delete itself is ONE statement: `DELETE FROM identity.orgs`. Every
 * org_id foreign key in the schema cascades — verified by migration 0040
 * through 0039 and re-verified for RTC's 0041/0042 here — and migration
 * 0044 extends the cascade to the org's own audit chain via a SECURITY
 * DEFINER trigger, because `audit.audit_log` (partitioned BY RANGE) can
 * carry no org_id foreign key at all. Postgres fans the delete out across
 * Work, Chat, Docs, People, outbox and audit with no maintained table list
 * to fall out of sync with the schema.
 *
 * Where the records land: the org's own chain is deleted with it (that is
 * the point — a deleted tenant's history must not linger as unreadable
 * rows), so the final accountability record is the `orgs.delete` entry in
 * the GLOBAL operator chain, written AFTER the delete succeeds and carrying
 * the org id, slug, member count, and the confirmation slug the operator
 * typed — a failure here is a missing log row, never a wrong one, and the
 * row is the record of an action that did happen. The typed event
 * (`platform.org_deleted`) publishes with the SYSTEM_ORG envelope for the
 * same reason the operator row is global: there is no org left to name.
 *
 * One residual named rather than fixed: if the org had provisioned a carrier
 * subaccount, a preceding `suspendOrg` froze it at Twilio (§9) but this
 * deletion never RELEASES it — the `comms.subaccounts` row cascades away
 * with the org, so no later code can even reach the SID, and the carrier
 * still holds a frozen, orphaned subaccount. Releasing needs a
 * carrier-delete capability the telephony module does not yet have; named
 * here so it is a known follow-up rather than a surprise.
 */
export async function deleteOrg(
  deps: { readonly events: EventBus; readonly mail?: BillingMailDeps },
  operator: PlatformOperator,
  input: { readonly orgId: OrgId; readonly confirmSlug: string },
): Promise<{ readonly orgId: OrgId; readonly slug: string }> {
  const now = new Date();

  const { slug, memberCount, orgName, ownerEmail } = await withPlatformAdminScope(async (tx) => {
    const existing = await tx
      .select({
        id: schema.orgs.id,
        slug: schema.orgs.slug,
        name: schema.orgs.name,
        status: schema.orgs.status,
        memberCount: countRows(schema.memberships.id),
      })
      .from(schema.orgs)
      .leftJoin(
        schema.memberships,
        and(eq(schema.memberships.orgId, schema.orgs.id), eq(schema.memberships.status, 'active')),
      )
      .groupBy(schema.orgs.id)
      .where(eq(schema.orgs.id, input.orgId))
      .limit(1);

    const org = existing[0];
    /* A missing org, and a deleted org, answer the same NOT_FOUND: the
       console confirming "that org used to exist" leaks a fact the
       cross-tenant-privacy rule keeps covered. */
    if (!org || org.status === 'deleted') throw errors.notFound();

    /* The two-step gate — see the doc above. A distinct error rather than a
       silent no-op so the console can tell the operator what to do. */
    if (org.status !== 'suspended') {
      throw errors.validation({
        confirmSlug: 'An organization must be suspended before it can be deleted.',
      });
    }

    /* Type-the-slug confirmation. Compared against the org's slug, not its
       name — the slug is the stable, URL-safe identifier the operator sees
       in the directory row itself. */
    if (input.confirmSlug !== org.slug) {
      throw errors.validation({
        confirmSlug: 'The confirmation does not match this organization\u2019s slug.',
      });
    }

    /* Read BEFORE the delete below — every membership row is about to
       cascade away, and there is no owner left to find on the far side of
       it. */
    const ownerRows = await tx
      .select({ email: schema.users.email })
      .from(schema.memberships)
      .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
      .where(
        and(
          eq(schema.memberships.orgId, input.orgId),
          eq(schema.memberships.role, 'owner'),
          eq(schema.memberships.status, 'active'),
        ),
      )
      .limit(1);

    /* The one statement. 0044's trigger removes the org's audit chain in
       the same transaction; every other row cascades by foreign key. */
    await tx.delete(schema.orgs).where(eq(schema.orgs.id, input.orgId));

    return {
      slug: org.slug,
      memberCount: Number(org.memberCount),
      orgName: org.name,
      ownerEmail: ownerRows[0]?.email ?? null,
    };
  });

  /* The final accountability record — global, so it survives the org. The
     confirmation slug is part of the record: "the operator typed this" is
     what makes a contested deletion attributable to a human decision. */
  await recordOperatorAction(operator.userId, 'orgs.delete', {
    orgId: input.orgId,
    slug,
    memberCount,
    confirmSlug: input.confirmSlug,
  });

  await deps.events.publish([
    createEvent(
      orgDeleted,
      { orgId: input.orgId, slug, operatorUserId: operator.userId, memberCount },
      {
        orgId: SYSTEM_ORG,
        actorId: operator.userId,
        requestId: operator.requestId,
        occurredAt: now,
      },
    ),
  ]);

  /* The owner, told directly, for the identical reason `suspendOrg` tells
     them — no outbox access for this role, and there is now no org left for
     a notification row to even reference. `ownerEmail` was captured before
     the delete cascaded the membership away. */
  if (deps.mail !== undefined && ownerEmail !== null) {
    const { productName } = await getResolvedBranding();
    const rendered = renderOrgDeleted({ orgName, productName });
    deps.mail.queue.enqueue({ to: ownerEmail, ...rendered });
  }

  return { orgId: input.orgId, slug };
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
