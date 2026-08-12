import { and, eq, outboxWriter, schema, withOrgScope } from '@taskflow/db';
import { unsafeAsId, type OrgId } from '@taskflow/contracts';
import { createEvent } from '@taskflow/events';
import { orgSuspendedForNonpayment, paymentFailed } from './events.js';

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
export async function expireTrial(
  orgId: OrgId,
  deps: { readonly pastDueGraceDays: number },
): Promise<boolean> {
  return withOrgScope(orgId, async (tx) => {
    const graceEndsAt = new Date(Date.now() + deps.pastDueGraceDays * DAY_MS);
    const result = await tx
      .update(schema.orgs)
      .set({ billingStatus: 'past_due', billingGraceEndsAt: graceEndsAt })
      .where(and(eq(schema.orgs.id, orgId), eq(schema.orgs.billingStatus, 'trialing')));

    if (result.rowCount === 0) return false;

    await outboxWriter.append(tx, [
      createEvent(
        paymentFailed,
        { orgId },
        { orgId, actorId: null, requestId: unsafeAsId<'RequestId'>(SWEEP_REQUEST_ID) },
      ),
    ]);
    return true;
  });
}

/**
 * `past_due` -> `canceled`, the sweep's own write — the one write in this
 * whole wave that actually LOCKS a org out (`resolveOrgMembership` refuses
 * on `billing_status = 'canceled'`). Deliberately distinct from
 * `platform.org_suspended` (Wave 1) — different cause, different column,
 * different audience reading the audit log later trying to understand why
 * access stopped.
 */
export async function expireGracePeriod(orgId: OrgId): Promise<boolean> {
  return withOrgScope(orgId, async (tx) => {
    const result = await tx
      .update(schema.orgs)
      .set({ billingStatus: 'canceled', billingGraceEndsAt: null })
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

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A fixed, recognizable request id for every event this sweep publishes —
 * there is no real HTTP request behind a scheduled tick, and a random one
 * per event would make "which of these came from the sweep" a string to
 * grep for instead of a constant to recognize.
 */
const SWEEP_REQUEST_ID = '00000000-0000-0000-0000-000000005ee9';
