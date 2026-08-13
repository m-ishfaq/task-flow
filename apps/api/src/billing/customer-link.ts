import { eq, schema, withOrgScope } from '@taskflow/db';
import type { OrgId } from '@taskflow/contracts';
import type { BillingDeps } from './deps.js';

/**
 * Ensures a Stripe customer exists for `orgId`, persisting the id on
 * `identity.orgs` AND on `billing.customer_orgs` in the SAME transaction.
 *
 * Deliberately NOT `*.service.ts` and not under a `services/` directory —
 * guardrail 11 requires a domain event on every mutation in those files, and
 * this one genuinely should not have its own: linking a customer id is
 * plumbing with no product meaning on its own, and the event that actually
 * matters — the org paying for the first time — is `billing.
 * subscription_activated`, published by the webhook handler when Stripe
 * confirms it, not by this best-effort id assignment. The identical "the
 * event belongs to the operation the user performed" reasoning
 * `work/rebalance.ts` already gives for sitting outside this same lint rule.
 */
export async function ensureCustomerId(
  deps: BillingDeps,
  orgId: OrgId,
  ownerEmail: string,
): Promise<string> {
  return withOrgScope(orgId, async (tx) => {
    const existing = await tx
      .select({ stripeCustomerId: schema.orgs.stripeCustomerId })
      .from(schema.orgs)
      .where(eq(schema.orgs.id, orgId))
      .limit(1);

    const current = existing[0]?.stripeCustomerId;
    if (current !== null && current !== undefined) return current;

    const { customerId } = await deps.payments.ensureCustomer({ orgId, email: ownerEmail });

    await tx
      .update(schema.orgs)
      .set({ stripeCustomerId: customerId })
      .where(eq(schema.orgs.id, orgId));

    /* No RLS on this table (migration 0059's own header) — an ordinary
       insert inside this scope, not a privileged one. `onConflictDoNothing`
       rather than a plain insert: `ensureCustomer` is itself idempotent
       (§3.3's own contract), so a racing second call landing here after the
       `stripeCustomerId` read above saw null must not throw on the primary
       key it is about to duplicate. */
    await tx
      .insert(schema.customerOrgs)
      .values({ stripeCustomerId: customerId, orgId })
      .onConflictDoNothing();

    return customerId;
  });
}
