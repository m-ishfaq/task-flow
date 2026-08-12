import { eq, schema, withOrgScope } from '@taskflow/db';
import { errors, type OrgId, type UserId } from '@taskflow/contracts';
import type { BillingDeps } from './deps.js';
import { ensureCustomerId } from './customer-link.js';

/**
 * The owner-facing half of billing (Phase 12 Wave 3 §3.1, §3.6) — "what does
 * MY org pay, and can I change it." Every function here is scoped to exactly
 * one org (`withOrgScope`), reached only through `org:billing`
 * (`packages/policy`'s ORG_LEVEL, owner-only permission with no resource
 * tuple that can ever satisfy it — see that file's own comment). Distinct
 * from `platform-admin/billing.ts`'s operator-facing, cross-org half, which
 * this module never imports and never calls.
 */

export interface BillingStatusView {
  readonly billingStatus: string;
  readonly planId: string | null;
  readonly trialEndsAt: Date | null;
  readonly billingGraceEndsAt: Date | null;
}

export async function getStatus(orgId: OrgId): Promise<BillingStatusView> {
  return withOrgScope(orgId, async (tx) => {
    const rows = await tx
      .select({
        billingStatus: schema.orgs.billingStatus,
        planId: schema.orgs.planId,
        trialEndsAt: schema.orgs.trialEndsAt,
        billingGraceEndsAt: schema.orgs.billingGraceEndsAt,
      })
      .from(schema.orgs)
      .where(eq(schema.orgs.id, orgId))
      .limit(1);

    const org = rows[0];
    if (!org) throw errors.notFound();
    return org;
  });
}

export interface CreateCheckoutSessionInput {
  readonly planId: 'pro';
}

export async function createCheckoutSession(
  deps: BillingDeps,
  orgId: OrgId,
  actor: { readonly userId: UserId; readonly email: string },
  input: CreateCheckoutSessionInput,
): Promise<{ readonly url: string }> {
  const priceId = deps.planPriceIds.get(input.planId);
  if (priceId === undefined) {
    throw errors.validation(
      { planId: `No Stripe price is configured for plan "${input.planId}".` },
      'This plan is not available.',
    );
  }

  const customerId = await ensureCustomerId(deps, orgId, actor.email);

  return deps.payments.createCheckoutSession({
    customerId,
    planId: priceId,
    successUrl: `${deps.webOrigin}/settings/billing?checkout=success`,
    cancelUrl: `${deps.webOrigin}/settings/billing?checkout=canceled`,
  });
}

export async function createPortalSession(
  deps: BillingDeps,
  orgId: OrgId,
  actor: { readonly userId: UserId; readonly email: string },
): Promise<{ readonly url: string }> {
  const customerId = await ensureCustomerId(deps, orgId, actor.email);

  return deps.payments.createPortalSession({
    customerId,
    returnUrl: `${deps.webOrigin}/settings/billing`,
  });
}
