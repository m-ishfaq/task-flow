import type { OrgId } from '../ids.js';

/**
 * PaymentProvider — the org subscription/billing carrier (Phase 12 Wave 3,
 * ai/phase-12-wave3.md §3.3).
 *
 * Same seam as `TelephonyProvider`: the interface pins behavior, and every
 * call site in `apps/api/src/billing` is written against these members only —
 * never against `stripe` (or any other SDK) directly, the identical
 * discipline that keeps `pg` out of everywhere but `packages/db`. Swapping
 * processors later is a new implementation of this interface plus one env
 * value (`PAYMENTS_PROVIDER`), never a call-site change.
 *
 * ## The catalog half (Phase 12 Wave 4, ai/phase-12-wave4-plans.md §3.9)
 *
 * Wave 3 assumed Products and Prices already existed, made by hand in the
 * processor's dashboard. `createProduct`/`createPrice`/`archivePrice`/
 * `archiveProduct` remove that assumption: the operator console is the only
 * place a plan is ever defined, and the dashboard is never opened to add or
 * reprice one.
 *
 * **There is no `updatePrice`, and its absence is the design.** Stripe Prices
 * are immutable — amount, currency and interval cannot be edited after
 * creation — so an interface offering an update would either be a lie or
 * would hide an archive-and-recreate behind a name that says otherwise. The
 * caller does both steps explicitly, which is also what makes grandfathering
 * visible at the call site rather than a side effect somewhere below it.
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

/**
 * One invoice, as the processor reported it.
 *
 * Translated inside the implementation like everything else here, so
 * `apps/api/src/billing` never pattern-matches a Stripe field name. Recorded
 * into `billing.invoices` (migration 0065) — a MIRROR, with
 * `hostedInvoiceUrl` as the path back to the processor's authoritative copy.
 */
export interface BillingInvoice {
  readonly providerInvoiceId: string;
  /** The printed number. Absent on a draft, which can arrive before finalization. */
  readonly number?: string | undefined;
  readonly status: 'draft' | 'open' | 'paid' | 'uncollectible' | 'void';
  /** Integer minor units. Never a float, never a formatted string. */
  readonly amountDueCents: number;
  readonly amountPaidCents: number;
  readonly currency: string;
  readonly periodStart?: Date | undefined;
  readonly periodEnd?: Date | undefined;
  readonly hostedInvoiceUrl?: string | undefined;
  readonly invoicePdfUrl?: string | undefined;
  /** When the PROCESSOR issued it — never our own clock; a retry can arrive late. */
  readonly issuedAt: Date;
}

export interface BillingWebhookEvent {
  readonly kind: BillingWebhookEventKind;
  /** The provider's own idempotency key for this event — `billing.webhook_events` dedupes on it. */
  readonly providerEventId: string;
  /** The provider's customer id — the lookup key `webhook.ts` resolves to an `OrgId` BEFORE trusting anything else in the payload. */
  readonly customerId: string;
  /** Present on `subscription_activated`; absent otherwise. */
  readonly subscriptionId?: string;
  /**
   * The PRICE the customer actually subscribed to, when the event carries one.
   *
   * Added in Phase 12 Wave 4 to close a real bug: `applyBillingWebhookEvent`
   * hardcoded `planId: 'pro'` on every activation, which was harmless while
   * `pro` was the only plan that could exist and silently wrong the moment a
   * catalog with several tiers did. The handler resolves this id back to a
   * plan through `billing.plan_prices` — including a RETIRED price, so a
   * grandfathered customer renewing still lands on the right plan.
   */
  readonly priceId?: string | undefined;
  /** Present on the invoice events; absent on subscription lifecycle ones. */
  readonly invoice?: BillingInvoice | undefined;
}

/**
 * Billing cadence. A closed union rather than a string, for the reason
 * `BillingWebhookEventKind` is one: a second implementation must not be able
 * to quietly support a wider set than this type declares.
 */
export type PlanInterval = 'month' | 'year';

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

  /**
   * Returns a URL to redirect the browser to. The provider's own hosted page
   * collects payment details.
   *
   * `priceId` — the processor's own price identifier, resolved by the caller
   * from `billing.plan_prices`. Named for what it holds: this parameter was
   * `planId` in Wave 3, when there was one hardcoded plan and no catalog, and
   * `org-billing.service.ts` was already passing a Stripe Price id into it. A
   * field named for a plan holding a price is harmless while there is exactly
   * one of each, and is a checkout against the wrong object the moment a
   * catalog exists with both kinds of id in scope.
   */
  createCheckoutSession(options: {
    readonly customerId: string;
    readonly priceId: string;
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

  /* ---------------------------------------------------------------------- *
   * The catalog half — see this file's header on why there is no update.
   * ---------------------------------------------------------------------- */

  /**
   * The billable THING a plan is. One per plan, holding no price of its own.
   *
   * Called before the catalog row is written, never after: an orphaned
   * product at the processor is inert — nothing references it and nothing
   * charges anyone for it — where a catalog row with no product is an Upgrade
   * button that cannot produce a checkout. Fail in the direction that is
   * inert (§3.9).
   */
  createProduct(options: {
    readonly name: string;
    readonly description?: string | undefined;
  }): Promise<{ readonly productId: string }>;

  /**
   * An immutable amount at a cadence, attached to a product.
   *
   * Repricing is `createPrice` for the new amount followed by `archivePrice`
   * for the old — in that order, so there is never a window with no current
   * price to check out against. Archiving does NOT stop existing
   * subscriptions billing against it, which is exactly what makes
   * grandfathering work.
   */
  createPrice(options: {
    readonly productId: string;
    readonly amountCents: number;
    readonly currency: string;
    readonly interval: PlanInterval;
  }): Promise<{ readonly priceId: string }>;

  /**
   * Retires a price from new checkouts. Existing subscriptions on it are
   * untouched and keep billing at that amount indefinitely — the processor's
   * own behaviour, relied on deliberately rather than worked around.
   */
  archivePrice(priceId: string): Promise<void>;

  /** Retires a product. Prices under it must be archived first. */
  archiveProduct(productId: string): Promise<void>;

  /**
   * A URL where an operator can see this object in the processor's own
   * console, or `null` when the processor has none.
   *
   * Exists because "the catalog says this plan has a product id" and "that
   * product actually exists at the processor" are different claims, and the
   * console could previously only make the first one. A stored id that was
   * written before a failed call, or that belongs to a different Stripe
   * account than the one currently configured, reads identically to a good
   * one — the only way to settle it is to go and look.
   *
   * Built by the IMPLEMENTATION rather than the caller because the correct URL
   * depends on credentials the caller must never see: Stripe's test and live
   * modes are different dashboard paths, and which one applies is decided by
   * the secret key's own prefix. A caller assembling this string would have to
   * be told the mode, which means being told something about the key.
   *
   * `null` from `FakePaymentProvider` is not a degraded answer — there is no
   * console for an in-memory map, and the UI renders the raw id instead.
   */
  dashboardUrl(ref: { readonly kind: 'product' | 'price'; readonly id: string }): string | null;

  /**
   * Moves an EXISTING subscription onto a different price.
   *
   * Not checkout. Checkout starts a subscription and would create a second
   * one — the double-charge `createCheckoutSession`'s caller now refuses.
   *
   * `prorate` is the upgrade/downgrade distinction expressed as money rather
   * than as a word: true charges the difference immediately (an upgrade — they
   * asked for more and get it now), false leaves the current period alone and
   * bills the new amount at the next renewal (a downgrade — they already paid
   * for this month, and taking it back is a refund conversation).
   *
   * The processor's price changes either way; what differs is whether anyone
   * is charged today. Feature access for a downgrade is held by the CALLER
   * until the period ends — see `identity.orgs.pending_plan_id`.
   */
  changeSubscriptionPrice(options: {
    readonly subscriptionId: string;
    readonly priceId: string;
    readonly prorate: boolean;
  }): Promise<void>;

  /**
   * Cancels at the end of the paid period, never immediately.
   *
   * The customer keeps what they bought until it runs out; the processor
   * simply does not renew. Immediate cancellation would owe them a refund for
   * the unused remainder, which is a support conversation this product does
   * not need to start.
   */
  cancelSubscription(subscriptionId: string): Promise<void>;

  /** Clears a pending cancellation, so the subscription renews as normal. */
  resumeSubscription(subscriptionId: string): Promise<void>;

  /**
   * Adds a one-off charge to the customer's NEXT invoice (§3.8's overage).
   *
   * Not a payment. It attaches an amount to whatever invoice the subscription
   * generates at its next renewal, so overage arrives on the same document as
   * the subscription fee rather than as a separate surprise charge — and it
   * settles through the payment method already on file, with no new
   * authorization step and no card data anywhere near this deployment.
   *
   * `idempotencyKey` is REQUIRED, unlike everywhere else in this interface,
   * and it is the second half of a two-layer guard rather than the only one.
   * The first is `billing.usage_charges`' primary key, which stops us calling
   * at all for a period already claimed. This one covers the window that
   * remains: a call the processor ACCEPTED whose response we never saw, where
   * our own row still says nothing was charged. Only the processor can settle
   * that, and only if it was told the two attempts were the same attempt.
   *
   * An implementation that ignored this parameter would compile, pass every
   * test that mocks it, and double-bill a customer the first time a network
   * timed out — so a provider that has no idempotency mechanism of its own
   * must refuse rather than proceed.
   */
  createInvoiceItem(options: {
    readonly customerId: string;
    readonly amountCents: number;
    readonly currency: string;
    readonly description: string;
    readonly idempotencyKey: string;
  }): Promise<{ readonly invoiceItemId: string }>;

  /**
   * This customer's CURRENT subscription, read directly from the processor.
   *
   * The webhook is the primary path and stays so — this is the reconciliation
   * one, and it exists because a webhook is a message that can be late, lost,
   * or (in development) never deliverable at all.
   *
   * The concrete failure it closes: an owner completes checkout, the browser
   * returns to the app, and the org's state has not changed because the
   * webhook has not arrived yet. They see "trialing" on a page they just paid
   * on. In development against a localhost API the webhook can NEVER arrive
   * without a forwarding tunnel, so that state is permanent rather than
   * transient — which reads as "the purchase did nothing".
   *
   * Safe to call repeatedly: it reads, and the caller applies the same
   * conditional transitions the webhook handler does. Returns null when the
   * customer has no active subscription, which is a real answer (they
   * cancelled, or checkout was abandoned) and not an error.
   */
  getActiveSubscription(customerId: string): Promise<{
    readonly subscriptionId: string;
    readonly priceId: string | undefined;
    /** When the current paid period renews. Mirrored, never authoritative. */
    readonly currentPeriodEnd: Date | undefined;
    /**
     * The subscription will stop at `currentPeriodEnd` instead of renewing.
     *
     * Read from the processor rather than assumed from our own last write,
     * because this app links customers to the processor's hosted portal — a
     * cancellation performed THERE is one our own routes never saw, and
     * without this field the only way to learn of it is the subscription
     * simply failing to renew.
     */
    readonly cancelAtPeriodEnd: boolean;
    readonly amountCents: number | undefined;
    readonly interval: PlanInterval | undefined;
  } | null>;
}
