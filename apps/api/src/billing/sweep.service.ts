import { and, eq, isNotNull, lte, outboxWriter, schema, withOrgScope } from '@taskflow/db';
import { unsafeAsId, type OrgId } from '@taskflow/contracts';
import { createEvent } from '@taskflow/events';
import { orgSuspendedForNonpayment, planChanged } from './events.js';
import { invalidateEntitlements } from './entitlement-resolver.js';

/**
 * The two write-side transitions of the trial/grace-expiry sweep (Phase 12
 * Wave 3 §3.4). `apps/worker`'s `billing/sweep.ts` does the CROSS-TENANT
 * scan (as `taskflow_billing_sweep`, read-only) and calls one of these
 * PER MATCHED ORG, over the ordinary `withOrgScope` connection — the same
 * "claim via a narrow role, act via the ordinary one" split every consumer
 * role in this codebase uses. A `*.service.ts` file, deliberately, unlike
 * `customer-link.ts`: both transitions here are real product facts worth an
 * audit event, not plumbing.
 *
 * Both are CONDITIONAL `UPDATE ... WHERE billingStatus = <fromStatus>` — the
 * `claimForScanning`/`suspendOrg` shape — so a sweep tick racing a webhook
 * (or a second worker instance, since this loop has no SKIP-LOCKED claim of
 * its own) cannot double-apply a transition: a row already moved on by
 * something else simply matches zero rows here.
 */

/**
 * `trialing` -> `past_due`, because the trial simply ended with no
 * subscription on file. Reuses `billing.payment_failed` rather than a
 * seventh event: from a consumer's perspective ("this org needs a valid
 * payment method and does not have one") a lapsed trial and a declined card
 * call for the identical remediation, and the distinction — trial vs. a real
 * charge attempt — is already recoverable from `billing.trial_started`'s own
 * `trialEndsAt` for anything that needs it.
 */
/**
 * The plan an expiring trial or a lapsed subscription lands on.
 *
 * Read from the CATALOG, never from configuration. `billing.plans.is_default`
 * carries a partial unique index (migration 0062) so at most one row can hold
 * it, and the console's "Make default" button is what moves it — the database
 * already guarantees the invariant, and an env var naming the same plan would
 * be a second source of truth that can silently disagree with the first.
 *
 * The failure that duplication produces is quiet: set the variable to `free`,
 * mark `business` default in the console, and expiring trials land somewhere
 * every screen says they should not.
 *
 * Null when no plan is marked default — a catalog nobody has finished setting
 * up. The callers treat that as "leave the plan alone", which is the honest
 * outcome: moving an org to a plan that does not exist is worse than leaving
 * it where it is, and the org keeps working either way because no billing
 * state blocks access any more.
 */
export async function defaultPlanId(orgId: OrgId): Promise<string | null> {
  return withOrgScope(orgId, async (tx) => {
    const rows = await tx
      .select({ id: schema.plans.id })
      .from(schema.plans)
      .where(and(eq(schema.plans.isDefault, true), eq(schema.plans.isActive, true)))
      .limit(1);
    return rows[0]?.id ?? null;
  });
}

export async function expireTrial(orgId: OrgId): Promise<boolean> {
  /* Resolved per org rather than passed in: the catalog is the source, and a
     caller threading a stale value through would reintroduce exactly the
     second-source-of-truth problem the env var had. */
  const landOn = await defaultPlanId(orgId);

  const moved = await withOrgScope(orgId, async (tx) => {
    /* Wave 4: a trial that runs out lands on the DEFAULT PLAN, not in
       `past_due`. Nobody is locked out and nothing is deleted — they keep
       every project, message and document, and lose only the features the
       free plan does not include.

       `past_due` was the Wave 3 behaviour and meant something different: a
       real charge was attempted and declined. Reusing it for "a trial ended"
       conflated a payment problem with never having had a payment method,
       and put a grace countdown on someone who owed nothing. */
    const result = await tx
      .update(schema.orgs)
      .set({
        billingStatus: 'active',
        planId: landOn,
        trialEndsAt: null,
        billingGraceEndsAt: null,
      })
      .where(and(eq(schema.orgs.id, orgId), eq(schema.orgs.billingStatus, 'trialing')));

    if (result.rowCount === 0) return false;

    await outboxWriter.append(tx, [
      createEvent(
        planChanged,
        {
          orgId,
          from: null,
          to: landOn ?? '',
          effective: 'now',
          effectiveAt: null,
        },
        { orgId, actorId: null, requestId: unsafeAsId<'RequestId'>(SWEEP_REQUEST_ID) },
      ),
    ]);
    return true;
  });

  /* The features they just lost must stop resolving immediately — a customer
     told they are on the free plan should not keep the paid ones for a TTL. */
  if (moved) invalidateEntitlements(orgId);
  return moved;
}



/**
 * `past_due` -> `canceled`, the sweep's own write — the one write in this
 * whole wave that actually LOCKS a org out (`resolveOrgMembership` refuses
 * on `billing_status = 'canceled'`). Deliberately distinct from
 * `platform.org_suspended` (Wave 1) — different cause, different column,
 * different audience reading the audit log later trying to understand why
 * access stopped.
 */
/**
 * Applies a DOWNGRADE that was parked until the paid period ended.
 *
 * `changePlan` reprices at the processor immediately but leaves `plan_id`
 * alone, because removing features someone has already paid for is a refund
 * conversation. The change waits in `pending_plan_id` with the date it
 * becomes true, and this is what makes it true.
 *
 * A CONDITIONAL update on the date, like every other transition in this file:
 * two sweep ticks racing must not both apply it and emit two events. The
 * `<= now` in the WHERE is what makes the second one a no-op rather than a
 * duplicate.
 */
export async function applyPendingPlanChange(orgId: OrgId): Promise<string | null> {
  const applied = await withOrgScope(orgId, async (tx) => {
    const rows = await tx
      .select({
        pendingPlanId: schema.orgs.pendingPlanId,
        planId: schema.orgs.planId,
      })
      .from(schema.orgs)
      .where(
        and(
          eq(schema.orgs.id, orgId),
          isNotNull(schema.orgs.pendingPlanEffectiveAt),
          lte(schema.orgs.pendingPlanEffectiveAt, new Date()),
        ),
      )
      .limit(1);

    const row = rows[0];
    if (row?.pendingPlanId == null) return null;

    const result = await tx
      .update(schema.orgs)
      .set({
        planId: row.pendingPlanId,
        pendingPlanId: null,
        pendingPlanEffectiveAt: null,
      })
      .where(
        and(
          eq(schema.orgs.id, orgId),
          /* Re-checked in the WHERE, not trusted from the read above: between
             the SELECT and this UPDATE another tick may have applied it. */
          isNotNull(schema.orgs.pendingPlanEffectiveAt),
          lte(schema.orgs.pendingPlanEffectiveAt, new Date()),
        ),
      );

    if (result.rowCount === 0) return null;

    await outboxWriter.append(tx, [
      createEvent(
        planChanged,
        {
          orgId,
          from: row.planId,
          to: row.pendingPlanId,
          /* 'now' from the CONSUMER's point of view: the parked change has
             just become the org's actual plan. `effectiveAt` null says the
             same thing — there is nothing further to wait for. */
          effective: 'now',
          effectiveAt: null,
        },
        { orgId, actorId: null, requestId: unsafeAsId<'RequestId'>(SWEEP_REQUEST_ID) },
      ),
    ]);

    return row.pendingPlanId;
  });

  /* The entitlement resolver caches per org; a downgrade that has landed must
     not keep serving the old plan's features for a further TTL. */
  if (applied !== null) invalidateEntitlements(orgId);
  return applied;
}

export async function expireGracePeriod(orgId: OrgId): Promise<boolean> {
  const landOn = await defaultPlanId(orgId);

  return withOrgScope(orgId, async (tx) => {
    /* Wave 4: the grace period ending also lands on the DEFAULT PLAN rather
       than on a `canceled` status that locked the org out. The org stops
       paying and stops having paid features; it does not stop existing. */
    const result = await tx
      .update(schema.orgs)
      .set({ billingStatus: 'active', planId: landOn, billingGraceEndsAt: null })
      .where(and(eq(schema.orgs.id, orgId), eq(schema.orgs.billingStatus, 'past_due')));

    if (result.rowCount === 0) return false;

    await outboxWriter.append(tx, [
      createEvent(
        orgSuspendedForNonpayment,
        { orgId },
        { orgId, actorId: null, requestId: unsafeAsId<'RequestId'>(SWEEP_REQUEST_ID) },
      ),
    ]);
    return true;
  });
}


/**
 * A fixed, recognizable request id for every event this sweep publishes —
 * there is no real HTTP request behind a scheduled tick, and a random one
 * per event would make "which of these came from the sweep" a string to
 * grep for instead of a constant to recognize.
 */
const SWEEP_REQUEST_ID = '00000000-0000-0000-0000-000000005ee9';
