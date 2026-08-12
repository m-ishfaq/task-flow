import type { OrgId } from '../ids.js';

/**
 * PaymentProvider — the org subscription/billing carrier (Phase 12 Wave 3,
 * ai/phase-12-wave3.md §3.3).
 *
 * Same seam as `TelephonyProvider`: the interface pins behavior, and every
 * call site in `apps/api/src/billing` is written against these four members
 * only — never against `stripe` (or any other SDK) directly, the identical
 * discipline that keeps `pg` out of everywhere but `packages/db`. Swapping
 * processors later is a new implementation of this interface plus one env
 * value (`PAYMENTS_PROVIDER`), never a call-site change.
 *
 * ## No card data, ever, in any implementation this interface accepts
 *
 * `createCheckoutSession`/`createPortalSession` both return a URL to
 * redirect the browser to — the provider's own hosted page collects payment
 * details. An implementation that could only be integrated by collecting a
 * card number directly is not a provider this interface is written for; that
 * is what keeps this deployment out of PCI scope entirely, unconditionally,
 * regardless of which processor is configured.
 *
 * ## `parseWebhookEvent` translates DOWN to a closed vocabulary
 *
 * Stripe alone has dozens of webhook event types. Translating them to the
 * four-member `BillingWebhookEvent` union happens INSIDE the implementation,
 * not in `apps/api/src/billing/webhook.ts` — so nothing in the caller ever
 * pattern-matches on a processor-specific string, and a second implementation
 * cannot silently support a narrower or wider set of transitions than this
 * type says it can. Like `TelephonyProvider.verifyWebhookSignature`, this is
 * the one method here that is a security control rather than an action, and
 * the one an implementation must not "improve" — it must reject anything it
 * cannot verify rather than guess.
 */

export type BillingWebhookEventKind =
  'subscription_activated' | 'payment_failed' | 'payment_recovered' | 'subscription_canceled';

export interface BillingWebhookEvent {
  readonly kind: BillingWebhookEventKind;
  /** The provider's own idempotency key for this event — `billing.webhook_events` dedupes on it. */
  readonly providerEventId: string;
  /** The provider's customer id — the lookup key `webhook.ts` resolves to an `OrgId` BEFORE trusting anything else in the payload. */
  readonly customerId: string;
  /** Present on `subscription_activated`; absent otherwise. */
  readonly subscriptionId?: string;
}

export interface PaymentProvider {
  /**
   * Whether this instance is wired to credentials that move real money —
   * the same reasoning `TelephonyProvider.isLive` gives: a test asserting
   * "no real charge occurred" needs to prove it was talking to a fake, not
   * trust that it was.
   */
  readonly isLive: boolean;

  /**
   * Idempotent: returns the existing customer if `orgId` already has one.
   * Never called a second time for the same org in the normal flow — the
   * id is persisted on `identity.orgs.stripeCustomerId` — but the provider,
   * not the caller, is what makes a duplicate call safe.
   */
  ensureCustomer(options: { readonly orgId: OrgId; readonly email: string }): Promise<{
    readonly customerId: string;
  }>;

  /** Returns a URL to redirect the browser to. The provider's own hosted page collects payment details. */
  createCheckoutSession(options: {
    readonly customerId: string;
    readonly planId: string;
    readonly successUrl: string;
    readonly cancelUrl: string;
  }): Promise<{ readonly url: string }>;

  /** Returns a URL to the provider's own customer portal — manage or cancel a subscription, no application code in the path. */
  createPortalSession(options: {
    readonly customerId: string;
    readonly returnUrl: string;
  }): Promise<{ readonly url: string }>;

  /**
   * Verifies and parses an inbound webhook body against the provider's own
   * signature scheme, THEN translates it to `BillingWebhookEvent`. Throws
   * if the signature does not verify — never returns a best-guess parse of
   * an unverified body.
   */
  parseWebhookEvent(options: {
    readonly payload: string;
    readonly signature: string;
    readonly webhookSecret: string;
  }): BillingWebhookEvent;
}
