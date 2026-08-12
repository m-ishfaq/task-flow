import type { BillingWebhookEvent, OrgId, PaymentProvider } from '@taskflow/contracts';

/**
 * In-memory `PaymentProvider` — every billing route must work end-to-end
 * against this with zero Stripe account, the identical non-negotiable
 * `FakeTelephonyProvider` already sets: a developer cloning this repo must
 * not need a Stripe account to run `pnpm verify`.
 *
 * `parseWebhookEvent` does not verify a real signature — there is no real
 * signature scheme to verify against a fake customer. It accepts the
 * `payload` as a pre-built `BillingWebhookEvent` (JSON-encoded), which is
 * what `webhook.service.test.ts` constructs directly, since the WHOLE point
 * of that test is asserting apps/api/src/billing's own logic, not re-testing
 * Stripe's signing scheme (`StripePaymentProvider`'s own test covers that,
 * against Stripe's published fixtures).
 */
export class FakePaymentProvider implements PaymentProvider {
  readonly isLive = false;

  private customers = new Map<OrgId, string>();
  private nextCustomerId = 1;

  ensureCustomer(options: { readonly orgId: OrgId; readonly email: string }): Promise<{
    readonly customerId: string;
  }> {
    const existing = this.customers.get(options.orgId);
    if (existing !== undefined) return Promise.resolve({ customerId: existing });

    const customerId = `cus_fake_${String(this.nextCustomerId)}`;
    this.nextCustomerId += 1;
    this.customers.set(options.orgId, customerId);
    return Promise.resolve({ customerId });
  }

  createCheckoutSession(options: {
    readonly customerId: string;
    readonly planId: string;
    readonly successUrl: string;
    readonly cancelUrl: string;
  }): Promise<{ readonly url: string }> {
    return Promise.resolve({
      url: `https://checkout.fake.test/session?customer=${options.customerId}&plan=${options.planId}`,
    });
  }

  createPortalSession(options: {
    readonly customerId: string;
    readonly returnUrl: string;
  }): Promise<{ readonly url: string }> {
    return Promise.resolve({
      url: `https://portal.fake.test/session?customer=${options.customerId}`,
    });
  }

  /**
   * No signature scheme to verify — `webhookSecret` is compared literally
   * against a fixed test value, so a suite driving this path can still
   * assert a WRONG secret is refused (the property that matters: refusal on
   * a bad secret, not a specific algorithm).
   */
  parseWebhookEvent(options: {
    readonly payload: string;
    readonly signature: string;
    readonly webhookSecret: string;
  }): BillingWebhookEvent {
    if (options.signature !== `fake_signed:${options.webhookSecret}`) {
      throw new Error('Invalid webhook signature.');
    }
    return JSON.parse(options.payload) as BillingWebhookEvent;
  }
}
