import Stripe from 'stripe';
import type {
  BillingInvoice,
  BillingWebhookEvent,
  OrgId,
  PaymentProvider,
  PlanInterval,
} from '@taskflow/contracts';

export interface StripeConfig {
  readonly secretKey: string;
}

/**
 * The live `PaymentProvider` (Phase 12 Wave 3 §3.3). Thin wrapper — pricing,
 * trial length, and the checkout/portal flow all live upstream of this file
 * (`apps/api/src/billing`); this only ever translates one call into one
 * Stripe SDK call, the same shape `TwilioTelephonyProvider` keeps.
 */
export class StripePaymentProvider implements PaymentProvider {
  readonly isLive = true;

  private readonly client: Stripe;

  /**
   * Whether the configured key is a TEST key, which decides the dashboard path.
   *
   * Read from the key's own prefix rather than from a separate env var, for
   * the reason `deps.ts` gives for refusing to credential-sniff elsewhere but
   * doing it here: this is not selecting behaviour, it is READING a fact the
   * credential already states unambiguously. A separate variable could
   * disagree with the key in use, and the direction it would disagree in is
   * "we linked an operator to the live dashboard for a test object", which
   * sends them looking for a product that was never supposed to be there.
   */
  private readonly isTestMode: boolean;

  constructor(config: StripeConfig) {
    this.client = new Stripe(config.secretKey);
    this.isTestMode =
      config.secretKey.startsWith('sk_test_') || config.secretKey.startsWith('rk_test_');
  }

  async ensureCustomer(options: {
    readonly orgId: OrgId;
    readonly email: string;
  }): Promise<{ readonly customerId: string }> {
    /* Searched by metadata, not by email — an org can rename its billing
       contact's email without minting a second customer, and two orgs could
       otherwise share one if their owners share an inbox. */
    const existing = await this.client.customers.search({
      query: `metadata['orgId']:'${options.orgId}'`,
      limit: 1,
    });
    const found = existing.data[0];
    if (found) return { customerId: found.id };

    const created = await this.client.customers.create({
      email: options.email,
      metadata: { orgId: options.orgId },
    });
    return { customerId: created.id };
  }

  async createCheckoutSession(options: {
    readonly customerId: string;
    readonly priceId: string;
    readonly successUrl: string;
    readonly cancelUrl: string;
  }): Promise<{ readonly url: string }> {
    const session = await this.client.checkout.sessions.create({
      customer: options.customerId,
      mode: 'subscription',
      line_items: [{ price: options.priceId, quantity: 1 }],
      success_url: options.successUrl,
      cancel_url: options.cancelUrl,
    });
    if (session.url === null) {
      throw new Error('Stripe returned a checkout session with no URL.');
    }
    return { url: session.url };
  }

  async createPortalSession(options: {
    readonly customerId: string;
    readonly returnUrl: string;
  }): Promise<{ readonly url: string }> {
    const session = await this.client.billingPortal.sessions.create({
      customer: options.customerId,
      return_url: options.returnUrl,
    });
    return { url: session.url };
  }

  /**
   * Verifies via `stripe.webhooks.constructEvent` — Stripe's own signature
   * check, never reimplemented here — and only THEN translates the result
   * to `BillingWebhookEvent`. An event type this deployment does not act on
   * (Stripe has dozens) is not an error: it returns nothing recognizable to
   * apply, and `webhook.ts` treats an unrecognized kind as a no-op, the same
   * as any other webhook consumer in this codebase ignoring event types it
   * was never built to know about.
   */
  parseWebhookEvent(options: {
    readonly payload: string;
    readonly signature: string;
    readonly webhookSecret: string;
  }): BillingWebhookEvent {
    const event = this.client.webhooks.constructEvent(
      options.payload,
      options.signature,
      options.webhookSecret,
    );

    const kind = translateEventType(event.type);
    if (kind === undefined) {
      throw new UnrecognizedBillingEvent(event.type, event.id);
    }

    const customerId = customerIdOf(event);
    if (customerId === undefined) {
      throw new Error(`Stripe event ${event.id} (${event.type}) carries no customer id.`);
    }

    const subscriptionId = kind === 'subscription_activated' ? subscriptionIdOf(event) : undefined;
    const priceId = priceIdOf(event);
    const invoice = invoiceOf(event);

    return {
      kind,
      providerEventId: event.id,
      customerId,
      ...(subscriptionId === undefined ? {} : { subscriptionId }),
      ...(priceId === undefined ? {} : { priceId }),
      ...(invoice === undefined ? {} : { invoice }),
    };
  }

  /* ---------------------------------------------------------------------- *
   * The catalog half (Phase 12 Wave 4, ai/phase-12-wave4-plans.md §3.9).
   * Still one call in, one Stripe SDK call out — the thin-wrapper discipline
   * this class keeps everywhere else. Ordering and grandfathering are the
   * caller's, in apps/api/src/billing, because they are policy.
   * ---------------------------------------------------------------------- */

  async createProduct(options: {
    readonly name: string;
    readonly description?: string | undefined;
  }): Promise<{ readonly productId: string }> {
    const product = await this.client.products.create({
      name: options.name,
      /* Stripe rejects an empty-string description where it accepts an absent
         one, and a plan with no description is ordinary. */
      ...(options.description === undefined || options.description.trim() === ''
        ? {}
        : { description: options.description }),
    });
    return { productId: product.id };
  }

  async createPrice(options: {
    readonly productId: string;
    readonly amountCents: number;
    readonly currency: string;
    readonly interval: PlanInterval;
  }): Promise<{ readonly priceId: string }> {
    const price = await this.client.prices.create({
      product: options.productId,
      /* Stripe's own name for cents. Integer minor units — never a float, and
         never a formatted string; the catalog stores the same integer, so
         nothing in this path ever does decimal arithmetic on money. */
      unit_amount: options.amountCents,
      currency: options.currency,
      recurring: { interval: options.interval },
    });
    return { priceId: price.id };
  }

  /**
   * `active: false`, which is what Stripe calls archiving.
   *
   * It removes the price from new checkouts and does NOT cancel or reprice a
   * single existing subscription on it — Stripe keeps billing them at that
   * amount indefinitely. That behaviour is not a caveat here, it IS the
   * grandfathering guarantee §3.2 rests on.
   */
  async archivePrice(priceId: string): Promise<void> {
    await this.client.prices.update(priceId, { active: false });
  }

  /**
   * The customer's current subscription, for the reconciliation path.
   *
   * `status: 'all'` then filtered in code rather than `status: 'active'`:
   * a subscription in `trialing` or `past_due` is still one the customer
   * has, and asking Stripe for actives alone would report "no subscription"
   * for someone mid-grace-period who is very much a paying customer.
   */
  async changeSubscriptionPrice(options: {
    readonly subscriptionId: string;
    readonly priceId: string;
    readonly prorate: boolean;
  }): Promise<void> {
    /* The existing item's id is required — passing only a price would ADD a
       second line rather than replace the first, which bills the customer for
       both plans at once. */
    const subscription = await this.client.subscriptions.retrieve(options.subscriptionId);
    const item = subscription.items.data[0];
    if (item === undefined) {
      throw new Error(`Subscription ${options.subscriptionId} has no items to reprice.`);
    }

    await this.client.subscriptions.update(options.subscriptionId, {
      items: [{ id: item.id, price: options.priceId }],
      proration_behavior: options.prorate ? 'create_prorations' : 'none',
    });
  }

  async cancelSubscription(subscriptionId: string): Promise<void> {
    await this.client.subscriptions.update(subscriptionId, { cancel_at_period_end: true });
  }

  async resumeSubscription(subscriptionId: string): Promise<void> {
    await this.client.subscriptions.update(subscriptionId, { cancel_at_period_end: false });
  }

  /**
   * A pending invoice item, settled on the customer's next subscription
   * invoice rather than charged on its own.
   *
   * `idempotencyKey` is passed as Stripe's own request-level key, NOT as
   * metadata: Stripe replays the ORIGINAL response for a repeated key within
   * its retention window, so a call whose response we lost returns the same
   * `invoiceItemId` on the retry instead of creating a second charge. That
   * is the failure the interface's own comment names, and metadata would not
   * close it — metadata is recorded on the object, which by then already
   * exists twice.
   */
  async createInvoiceItem(options: {
    readonly customerId: string;
    readonly amountCents: number;
    readonly currency: string;
    readonly description: string;
    readonly idempotencyKey: string;
  }): Promise<{ readonly invoiceItemId: string }> {
    const item = await this.client.invoiceItems.create(
      {
        customer: options.customerId,
        amount: options.amountCents,
        currency: options.currency,
        description: options.description,
      },
      { idempotencyKey: options.idempotencyKey },
    );

    return { invoiceItemId: item.id };
  }

  async getActiveSubscription(customerId: string): Promise<{
    readonly subscriptionId: string;
    readonly priceId: string | undefined;
    readonly currentPeriodEnd: Date | undefined;
    readonly cancelAtPeriodEnd: boolean;
    readonly amountCents: number | undefined;
    readonly interval: PlanInterval | undefined;
  } | null> {
    const subscriptions = await this.client.subscriptions.list({
      customer: customerId,
      status: 'all',
      limit: 10,
    });

    const live = subscriptions.data.find((subscription) =>
      ['active', 'trialing', 'past_due'].includes(subscription.status),
    );
    if (live === undefined) return null;

    const item = live.items.data[0];
    const price = item?.price;
    const recurring = price?.recurring?.interval;

    return {
      subscriptionId: live.id,
      /* First line item only — this deployment sells one plan per
         subscription, so a second line is proration or tax. */
      priceId: price?.id,
      /* On the SUBSCRIPTION, not the item — Stripe has been moving this
         between the two across API versions, and the installed types put it
         here. UNIX SECONDS, like every Stripe timestamp: treated as
         milliseconds it lands in 1970 and every "renews on" reads as fifty
         years ago. */
      currentPeriodEnd: new Date(live.current_period_end * 1000),
      /* Stripe's own flag, not our record of having asked. A customer who
         cancelled in the hosted portal never touched one of our routes, and
         this is the only way that reaches us short of the renewal silently
         not happening. */
      cancelAtPeriodEnd: live.cancel_at_period_end,
      amountCents: price?.unit_amount ?? undefined,
      interval: recurring === 'month' || recurring === 'year' ? recurring : undefined,
    };
  }

  /** Same mechanism. Stripe refuses while any price under it is still active. */
  async archiveProduct(productId: string): Promise<void> {
    await this.client.products.update(productId, { active: false });
  }

  /**
   * The object's page in the Stripe Dashboard.
   *
   * `/test/` for a test key, bare for a live one — the same object id resolves
   * in only one of the two, so linking to the wrong mode shows a 404 that
   * reads like "this plan was never created".
   */
  dashboardUrl(ref: { readonly kind: 'product' | 'price'; readonly id: string }): string | null {
    const mode = this.isTestMode ? '/test' : '';
    return `https://dashboard.stripe.com${mode}/${ref.kind}s/${ref.id}`;
  }
}

/**
 * A recognized-but-unmapped Stripe event, distinct from a signature failure —
 * `webhook.ts` catches this specifically and treats it as an intentional
 * no-op (still records `providerEventId` is unavailable here, so it does NOT
 * write a `billing.webhook_events` row; Stripe's own retry policy does not
 * retry on a 200, so this must still answer 200, not error).
 */
export class UnrecognizedBillingEvent extends Error {
  constructor(
    readonly stripeType: string,
    readonly eventId: string,
  ) {
    super(`Unrecognized Stripe event type: ${stripeType}`);
  }
}

function translateEventType(stripeType: string): BillingWebhookEvent['kind'] | undefined {
  switch (stripeType) {
    case 'checkout.session.completed':
    case 'customer.subscription.updated':
      return 'subscription_activated';
    case 'invoice.payment_failed':
      return 'payment_failed';
    case 'invoice.payment_succeeded':
      return 'payment_recovered';
    case 'customer.subscription.deleted':
      return 'subscription_canceled';
    default:
      return undefined;
  }
}

function customerIdOf(event: Stripe.Event): string | undefined {
  const object = event.data.object as { customer?: string | { id: string } | null };
  const { customer } = object;
  if (customer === null || customer === undefined) return undefined;
  return typeof customer === 'string' ? customer : customer.id;
}

function subscriptionIdOf(event: Stripe.Event): string | undefined {
  const object = event.data.object as { id?: string; subscription?: string | null };
  return object.subscription ?? object.id;
}

/**
 * The price the customer actually bought.
 *
 * Three shapes, because Stripe puts it in three places depending on which
 * event this is: a Checkout Session has no line items expanded (so nothing to
 * read — the subscription event that follows carries it), a Subscription has
 * `items.data[0].price.id`, and an Invoice has `lines.data[0].price.id`.
 *
 * First line item only, deliberately: this deployment sells one plan per
 * subscription (§2's own "seats deferred" decision), so a second line is
 * proration or tax rather than a second plan. Reading it would resolve a
 * customer's plan from an adjustment.
 */
function priceIdOf(event: Stripe.Event): string | undefined {
  const object = event.data.object as {
    items?: { data?: { price?: { id?: string } }[] };
    lines?: { data?: { price?: { id?: string } | null }[] };
  };
  return object.items?.data?.[0]?.price?.id ?? object.lines?.data?.[0]?.price?.id ?? undefined;
}

/** Stripe's own invoice statuses. Anything unrecognized is treated as a draft. */
const INVOICE_STATUSES = new Set(['draft', 'open', 'paid', 'uncollectible', 'void']);

/**
 * The invoice an event carries, or undefined when it carries none.
 *
 * Only the invoice events have one — a subscription lifecycle event does not,
 * and inventing an empty invoice for it would put a meaningless row in the
 * customer's history.
 *
 * Every timestamp Stripe sends is UNIX SECONDS, not milliseconds. Multiplying
 * is not optional: treated as milliseconds, `created` lands in January 1970
 * and the whole history sorts backwards behind every other row.
 */
function invoiceOf(event: Stripe.Event): BillingInvoice | undefined {
  if (!event.type.startsWith('invoice.')) return undefined;

  const raw = event.data.object as {
    id?: string;
    number?: string | null;
    status?: string | null;
    amount_due?: number;
    amount_paid?: number;
    currency?: string;
    period_start?: number | null;
    period_end?: number | null;
    hosted_invoice_url?: string | null;
    invoice_pdf?: string | null;
    created?: number;
  };

  if (raw.id === undefined || raw.currency === undefined) return undefined;

  const seconds = (value: number | null | undefined): Date | undefined =>
    value === null || value === undefined ? undefined : new Date(value * 1000);

  const status =
    raw.status !== null && raw.status !== undefined && INVOICE_STATUSES.has(raw.status)
      ? (raw.status as BillingInvoice['status'])
      : 'draft';

  return {
    providerInvoiceId: raw.id,
    ...(raw.number === null || raw.number === undefined ? {} : { number: raw.number }),
    status,
    amountDueCents: raw.amount_due ?? 0,
    amountPaidCents: raw.amount_paid ?? 0,
    currency: raw.currency,
    ...(seconds(raw.period_start) === undefined ? {} : { periodStart: seconds(raw.period_start) }),
    ...(seconds(raw.period_end) === undefined ? {} : { periodEnd: seconds(raw.period_end) }),
    ...(raw.hosted_invoice_url === null || raw.hosted_invoice_url === undefined
      ? {}
      : { hostedInvoiceUrl: raw.hosted_invoice_url }),
    ...(raw.invoice_pdf === null || raw.invoice_pdf === undefined
      ? {}
      : { invoicePdfUrl: raw.invoice_pdf }),
    issuedAt: seconds(raw.created) ?? new Date(),
  };
}
