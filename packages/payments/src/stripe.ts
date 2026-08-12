import Stripe from 'stripe';
import type { BillingWebhookEvent, OrgId, PaymentProvider } from '@taskflow/contracts';

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

  constructor(config: StripeConfig) {
    this.client = new Stripe(config.secretKey);
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
    readonly planId: string;
    readonly successUrl: string;
    readonly cancelUrl: string;
  }): Promise<{ readonly url: string }> {
    const session = await this.client.checkout.sessions.create({
      customer: options.customerId,
      mode: 'subscription',
      line_items: [{ price: options.planId, quantity: 1 }],
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

    return {
      kind,
      providerEventId: event.id,
      customerId,
      ...(subscriptionId === undefined ? {} : { subscriptionId }),
    };
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
