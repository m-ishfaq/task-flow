import { uuidv7 } from '@taskflow/security';
import type {
  BillingWebhookEvent,
  OrgId,
  PaymentProvider,
  PlanInterval,
} from '@taskflow/contracts';

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

  /**
   * Derived from `orgId`, not a per-instance counter.
   *
   * A sequential counter (`cus_fake_1`, `cus_fake_2`, …) is unique only
   * within ONE provider instance — and every caller constructs a fresh one
   * (`deps()` in each test file, each `it()` block). Persisted against real
   * Postgres's `identity.orgs.stripe_customer_id UNIQUE` constraint, two
   * different tests' first checkout both landing on `cus_fake_1` is a
   * genuine collision, not a coincidence: this test suite never actually ran
   * against real Postgres until CI did, so nothing had caught it. `orgId` is
   * already a UUID assigned once per org, so keying on it directly is
   * unique for free and still idempotent per org.
   */
  ensureCustomer(options: { readonly orgId: OrgId; readonly email: string }): Promise<{
    readonly customerId: string;
  }> {
    const existing = this.customers.get(options.orgId);
    if (existing !== undefined) return Promise.resolve({ customerId: existing });

    const customerId = `cus_fake_${options.orgId}`;
    this.customers.set(options.orgId, customerId);
    return Promise.resolve({ customerId });
  }

  createCheckoutSession(options: {
    readonly customerId: string;
    readonly priceId: string;
    readonly successUrl: string;
    readonly cancelUrl: string;
  }): Promise<{ readonly url: string }> {
    return Promise.resolve({
      url: `https://checkout.fake.test/session?customer=${options.customerId}&price=${options.priceId}`,
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

  /* ---------------------------------------------------------------------- *
   * The catalog half (Phase 12 Wave 4, ai/phase-12-wave4-plans.md §3.9)
   *
   * These enforce the two ORDERING rules the real processor enforces, rather
   * than accepting anything and returning an id. A fake that permits what
   * Stripe refuses is worse than no fake: the console would pass every test
   * and fail the first time it ran live, which is the exact shape of the four
   * Phase 7 defects a green suite could not see.
   * ---------------------------------------------------------------------- */

  private products = new Map<string, { readonly name: string; archived: boolean }>();

  private prices = new Map<string, { readonly productId: string; archived: boolean }>();

  /**
   * `uuidv7` rather than a per-instance counter, and the reason is written out
   * in `ensureCustomer` above: a counter is unique only within ONE provider
   * instance, every test file constructs its own, and
   * `plan_prices.stripe_price_id` carries a UNIQUE index in real Postgres. Two
   * suites' first price both landing on `price_fake_1` is a genuine collision
   * that only appears once something persists them.
   */
  createProduct(options: {
    readonly name: string;
    readonly description?: string | undefined;
  }): Promise<{ readonly productId: string }> {
    const productId = `prod_fake_${uuidv7()}`;
    this.products.set(productId, { name: options.name, archived: false });
    return Promise.resolve({ productId });
  }

  createPrice(options: {
    readonly productId: string;
    readonly amountCents: number;
    readonly currency: string;
    readonly interval: PlanInterval;
  }): Promise<{ readonly priceId: string }> {
    const product = this.products.get(options.productId);
    if (product === undefined) {
      throw new Error(`No such product: ${options.productId}`);
    }
    if (product.archived) {
      throw new Error(`Cannot add a price to archived product ${options.productId}.`);
    }

    const priceId = `price_fake_${uuidv7()}`;
    this.prices.set(priceId, { productId: options.productId, archived: false });
    return Promise.resolve({ priceId });
  }

  archivePrice(priceId: string): Promise<void> {
    const price = this.prices.get(priceId);
    if (price === undefined) {
      throw new Error(`No such price: ${priceId}`);
    }
    price.archived = true;
    return Promise.resolve();
  }

  /**
   * Refuses while any price under the product is still active — Stripe's own
   * behaviour, reproduced deliberately. Archiving a product out from under a
   * live price is the ordering mistake this catches, and catching it here is
   * the difference between a failing unit test and a half-retired plan in
   * production.
   */
  archiveProduct(productId: string): Promise<void> {
    const product = this.products.get(productId);
    if (product === undefined) {
      throw new Error(`No such product: ${productId}`);
    }

    for (const [priceId, price] of this.prices) {
      if (price.productId === productId && !price.archived) {
        throw new Error(
          `Cannot archive product ${productId}: price ${priceId} is still active. ` +
            'Archive every price under a product before the product itself.',
        );
      }
    }

    product.archived = true;
    return Promise.resolve();
  }

  /**
   * `null` — there is no console for an in-memory map, and inventing a
   * plausible-looking URL would be worse than admitting there is none: an
   * operator on a `fake` deployment would click it, land nowhere, and
   * reasonably conclude the plan had failed to create. The console renders
   * the raw id instead.
   */
  dashboardUrl(): string | null {
    return null;
  }

  /**
   * Always null — the fake has no subscriptions, only checkout URLs.
   *
   * That makes reconciliation a NO-OP against the fake rather than a lie:
   * a deployment running `PAYMENTS_PROVIDER=fake` has no processor to
   * reconcile with, and inventing a subscription here would silently activate
   * orgs that never paid anything.
   */
  /* No subscriptions exist in the fake, so these are no-ops rather than
     throws: a deployment on PAYMENTS_PROVIDER=fake should be able to drive
     the whole plan-change flow without a processor, and the CALLER's own
     database writes are what the flow is actually testing. */
  changeSubscriptionPrice(): Promise<void> {
    return Promise.resolve();
  }

  cancelSubscription(): Promise<void> {
    return Promise.resolve();
  }

  resumeSubscription(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Records the charge instead of sending it, and honours the idempotency key.
   *
   * Honouring it matters more here than anywhere else in this fake: the
   * interface says a repeated key returns the ORIGINAL result rather than
   * creating a second item, and a fake that ignored that would let a test
   * asserting "the retry did not double-bill" pass against an implementation
   * that would. `items` is public so a test can assert how many charges were
   * actually created, the same way the telephony fake exposes what it was
   * asked to send.
   */
  readonly invoiceItems: {
    readonly invoiceItemId: string;
    readonly customerId: string;
    readonly amountCents: number;
    readonly currency: string;
    readonly description: string;
    readonly idempotencyKey: string;
  }[] = [];

  createInvoiceItem(options: {
    readonly customerId: string;
    readonly amountCents: number;
    readonly currency: string;
    readonly description: string;
    readonly idempotencyKey: string;
  }): Promise<{ readonly invoiceItemId: string }> {
    const replayed = this.invoiceItems.find(
      (item) => item.idempotencyKey === options.idempotencyKey,
    );
    if (replayed !== undefined) {
      return Promise.resolve({ invoiceItemId: replayed.invoiceItemId });
    }

    const invoiceItemId = `ii_fake_${uuidv7()}`;
    this.invoiceItems.push({ invoiceItemId, ...options });
    return Promise.resolve({ invoiceItemId });
  }

  getActiveSubscription(): Promise<{
    readonly subscriptionId: string;
    readonly priceId: string | undefined;
    readonly currentPeriodEnd: Date | undefined;
    readonly cancelAtPeriodEnd: boolean;
    readonly amountCents: number | undefined;
    readonly interval: PlanInterval | undefined;
  } | null> {
    return Promise.resolve(null);
  }
}
