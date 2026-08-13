import { eq } from 'drizzle-orm';
import { withGlobalScope } from './client.js';
import type { OrgId } from './client.js';
import { customerOrgs } from './schema/billing.js';

/**
 * The Stripe-customer-id → org lookup an inbound webhook needs before it has
 * a scope (ai/phase-12-wave3.md §3.5; migration 0059's own header). The
 * identical shape and reasoning as `resolveOrgBySubaccountSid` — lives here
 * rather than in `apps/api/src/billing` because `withGlobalScope` is
 * lint-restricted to `packages/db` and the identity module, and rather than
 * widen that guardrail for one query, the query lives where it can be read
 * in one sitting.
 *
 * `billing.customer_orgs` carries a Stripe customer id and an org id and
 * nothing else, with no RLS by design — which is why a global-scope read of
 * it works, and why it is safe that it does.
 *
 * The org this returns is derived from an UNVERIFIED webhook payload. It
 * selects WHICH ORG's webhook secret... except Stripe signs with one
 * account-level secret, not a per-org one (unlike Twilio) — so unlike its
 * telephony sibling, this lookup's answer is never itself part of the
 * signature check. It still must not be trusted before the signature passes:
 * `webhook.ts` uses it only to know which org's row to update, and applies
 * nothing until `parseWebhookEvent` has verified the body against the
 * account-level secret.
 */
export async function resolveOrgByStripeCustomerId(customerId: string): Promise<OrgId | undefined> {
  if (customerId.length === 0) return undefined;

  return withGlobalScope(async (tx) => {
    const rows = await tx
      .select({ orgId: customerOrgs.orgId })
      .from(customerOrgs)
      .where(eq(customerOrgs.stripeCustomerId, customerId))
      .limit(1);

    const row = rows[0];
    return row === undefined ? undefined : (row.orgId as OrgId);
  });
}
