import {
  and,
  desc,
  eq,
  inArray,
  insertAuditEntry,
  lt,
  or,
  schema,
  withAuditScope,
  withPlatformAdminScope,
} from '@taskflow/db';
import { errors, type OrgId } from '@taskflow/contracts';
import { createEvent, type EventBus } from '@taskflow/events';
import { newId } from '@taskflow/security';
import type { PlatformOperator } from './org-directory.service.js';
import { graceExtended } from '../billing/events.js';
import { recordOperatorAction } from './audit.js';
import { encodeCreatedCursor, parseCreatedCursor } from './pagination.js';

/**
 * The platform console's billing view (Phase 12 Wave 3 §3.6,
 * ai/phase-12-wave3.md) — "show me every org's billing state," the
 * operator-facing half deliberately kept in its own namespace from
 * `billing/org-billing.service.ts`'s owner-facing "what does MY org pay".
 *
 * ⚠ Adjacent to a human-review surface: every read/write here runs as
 * `taskflow_platform_admin`. No NEW grant was needed for this file —
 * migration 0035 already gave that role `SELECT, UPDATE ON identity.orgs`
 * with no column list, for the org-status console, and that grant covers
 * every column any later migration adds, including this wave's. What keeps
 * this role from casually rewriting `billing_status` is application
 * discipline, not a narrower SQL grant — the identical shape Wave 1's own
 * comment already states for why the `status`-write policy is wide ("the
 * application code is what keeps it to status"). `grantExtension` below is
 * the ONE write this file performs, and it touches `billing_grace_ends_at`
 * alone, never `billing_status` — extending a deadline is not the same
 * action as deciding an org is paid up, and this file must never blur them.
 */

export interface BillingDirectoryRow {
  readonly orgId: OrgId;
  readonly name: string;
  readonly slug: string;
  readonly billingStatus: string;
  readonly planId: string | null;
  readonly trialEndsAt: Date | null;
  readonly billingGraceEndsAt: Date | null;
  readonly stripeCustomerId: string | null;

  /* Wave 4. The tab could say which plan ID and two dates that are usually
     empty; it could not say what they PAY, when it renews, or whether the
     last invoice was actually paid — which is the only question an operator
     opens a billing tab with. */
  readonly planName: string | null;
  readonly currentPeriodEnd: Date | null;
  readonly currentPriceCents: number | null;
  readonly currentPriceInterval: string | null;
  readonly pendingPlanId: string | null;
  readonly pendingPlanEffectiveAt: Date | null;
  /**
   * The most recent recorded invoice, or null.
   *
   * Read through the operator role, which 0065 grants SELECT and a permissive
   * read policy — "did this customer actually pay" should not require opening
   * a tenant scope.
   */
  readonly lastInvoice: {
    readonly status: string;
    readonly amountDueCents: number;
    readonly currency: string;
    readonly issuedAt: Date;
    readonly hostedInvoiceUrl: string | null;
  } | null;
}

export async function listBilling(
  operator: PlatformOperator,
  input: { readonly cursor: string | null; readonly limit: number },
): Promise<{ readonly orgs: readonly BillingDirectoryRow[]; readonly nextCursor: string | null }> {
  const cursor = parseCreatedCursor(input.cursor);

  const rows = await withPlatformAdminScope(async (tx) => {
    const query = tx
      .select({
        orgId: schema.orgs.id,
        name: schema.orgs.name,
        slug: schema.orgs.slug,
        billingStatus: schema.orgs.billingStatus,
        planId: schema.orgs.planId,
        trialEndsAt: schema.orgs.trialEndsAt,
        billingGraceEndsAt: schema.orgs.billingGraceEndsAt,
        stripeCustomerId: schema.orgs.stripeCustomerId,
        /* What the tab exists to answer, and could not: which plan by NAME,
           what they pay, when it renews, and whether the last invoice was
           actually paid. A plan id and two usually-empty dates were not it. */
        planName: schema.plans.name,
        currentPeriodEnd: schema.orgs.currentPeriodEnd,
        currentPriceCents: schema.orgs.currentPriceCents,
        currentPriceInterval: schema.orgs.currentPriceInterval,
        pendingPlanId: schema.orgs.pendingPlanId,
        pendingPlanEffectiveAt: schema.orgs.pendingPlanEffectiveAt,
        createdAt: schema.orgs.createdAt,
      })
      .from(schema.orgs)
      /* LEFT — plan_id is nullable (a trialing org has none), and an inner
         join would drop exactly the orgs an operator most wants to see. */
      .leftJoin(schema.plans, eq(schema.plans.id, schema.orgs.planId))
      .orderBy(desc(schema.orgs.createdAt), desc(schema.orgs.id))
      .limit(input.limit + 1);

    if (cursor !== null) {
      query.where(
        or(
          lt(schema.orgs.createdAt, cursor.createdAt),
          and(eq(schema.orgs.createdAt, cursor.createdAt), lt(schema.orgs.id, cursor.rowId)),
        ),
      );
    }
    return query;
  });

  await recordOperatorAction(operator.userId, 'billing.list', null);

  const hasMore = rows.length > input.limit;
  const page = hasMore ? rows.slice(0, input.limit) : rows;
  const last = page[page.length - 1];

  /* ONE query for the whole page rather than one per row. DISTINCT ON is
     Postgres picking the newest invoice per org in a single pass — the
     alternative, a query per org, turns a 25-row page into 26 round trips. */
  const orgIds = page.map((row) => row.orgId);
  const lastInvoices =
    orgIds.length === 0
      ? []
      : await withPlatformAdminScope(async (tx) =>
          tx
            .selectDistinctOn([schema.invoices.orgId], {
              orgId: schema.invoices.orgId,
              status: schema.invoices.status,
              amountDueCents: schema.invoices.amountDueCents,
              currency: schema.invoices.currency,
              issuedAt: schema.invoices.issuedAt,
              hostedInvoiceUrl: schema.invoices.hostedInvoiceUrl,
            })
            .from(schema.invoices)
            .where(inArray(schema.invoices.orgId, orgIds))
            .orderBy(schema.invoices.orgId, desc(schema.invoices.issuedAt)),
        );

  const invoiceByOrg = new Map(lastInvoices.map((invoice) => [invoice.orgId, invoice]));

  return {
    orgs: page.map((row) => ({
      orgId: row.orgId as OrgId,
      name: row.name,
      slug: row.slug,
      billingStatus: row.billingStatus,
      planId: row.planId,
      trialEndsAt: row.trialEndsAt,
      billingGraceEndsAt: row.billingGraceEndsAt,
      stripeCustomerId: row.stripeCustomerId,
      planName: row.planName,
      currentPeriodEnd: row.currentPeriodEnd,
      currentPriceCents: row.currentPriceCents,
      currentPriceInterval: row.currentPriceInterval,
      pendingPlanId: row.pendingPlanId,
      pendingPlanEffectiveAt: row.pendingPlanEffectiveAt,
      lastInvoice: invoiceByOrg.get(row.orgId) ?? null,
    })),
    nextCursor:
      hasMore && last !== undefined ? encodeCreatedCursor(last.createdAt, last.orgId) : null,
  };
}

/**
 * The support-ticket override (§3.6) — pushes `billingGraceEndsAt` out by
 * `extendByDays`. Deliberately NOT a way to flip `billingStatus` directly:
 * an operator marking an unpaid org 'active' by hand is exactly the kind of
 * action that belongs in Stripe's own record, not a button in this console.
 * Refuses an org that is not currently `past_due` — extending a deadline
 * that is not running yet is not a real action.
 */
export async function grantExtension(
  deps: { readonly events: EventBus },
  operator: PlatformOperator,
  input: { readonly orgId: OrgId; readonly extendByDays: number },
): Promise<{ readonly orgId: OrgId; readonly billingGraceEndsAt: Date }> {
  const now = new Date();

  const newGraceEndsAt = await withPlatformAdminScope(async (tx) => {
    const existing = await tx
      .select({
        billingStatus: schema.orgs.billingStatus,
        billingGraceEndsAt: schema.orgs.billingGraceEndsAt,
      })
      .from(schema.orgs)
      .where(eq(schema.orgs.id, input.orgId))
      .limit(1);

    const org = existing[0];
    if (!org) throw errors.notFound();
    if (org.billingStatus !== 'past_due') {
      throw errors.validation(
        { billingStatus: 'This org is not currently past due.' },
        'This org has no grace period running to extend.',
      );
    }

    /* Extends from the LATER of "now" and the current deadline — extending
       an already-future deadline should add days to IT, not reset the clock
       to "now plus N", which would silently shorten a longer grace period an
       operator (or the default) already granted. */
    const base =
      org.billingGraceEndsAt !== null && org.billingGraceEndsAt > now
        ? org.billingGraceEndsAt
        : now;
    const graceEndsAt = new Date(base.getTime() + input.extendByDays * DAY_MS);

    await tx
      .update(schema.orgs)
      .set({ billingGraceEndsAt: graceEndsAt })
      .where(eq(schema.orgs.id, input.orgId));

    return graceEndsAt;
  });

  /* Dual write, the Wave 1 pattern (§4): the org's own audit chain — an
     Owner sees "an operator gave you more time" with no operator access
     required — AND the global operator log, unconditionally. */
  await withAuditScope(async (tx) => {
    await insertAuditEntry(tx, {
      id: newId<'EventId'>(),
      orgId: input.orgId,
      occurredAt: now,
      actorId: operator.userId,
      action: 'billing.grace_extended',
      resourceType: 'org',
      resourceId: input.orgId,
      changes: {
        orgId: input.orgId,
        operatorUserId: operator.userId,
        extendedToDate: newGraceEndsAt.toISOString(),
      },
      requestId: operator.requestId,
    });
  });

  await recordOperatorAction(operator.userId, 'billing.grantExtension', {
    orgId: input.orgId,
    extendByDays: input.extendByDays,
  });

  /* The typed event — guardrail 11. Published on the bus, not the outbox:
     the platform-admin role holds nothing on platform.outbox (see
     platform-admin/events.ts's own header on why). */
  await deps.events.publish([
    createEvent(
      graceExtended,
      {
        orgId: input.orgId,
        operatorUserId: operator.userId,
        extendedToDate: newGraceEndsAt.toISOString(),
      },
      {
        orgId: input.orgId,
        actorId: operator.userId,
        requestId: operator.requestId,
        occurredAt: now,
      },
    ),
  ]);

  return { orgId: input.orgId, billingGraceEndsAt: newGraceEndsAt };
}

const DAY_MS = 24 * 60 * 60 * 1000;
