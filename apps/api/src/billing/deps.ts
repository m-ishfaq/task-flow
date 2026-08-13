import { FakePaymentProvider, StripePaymentProvider } from '@taskflow/payments';
import type { PaymentProvider } from '@taskflow/contracts';
import type { Env } from '../config/env.js';
import type { MailQueue } from '@taskflow/mail';
import type { BillingMailDeps } from './billing-mail.js';

/**
 * Wiring for the billing module (ai/phase-12-wave3.md §3.3).
 *
 * Built from the validated environment (guardrail 3), constructed once at
 * boot — the identical shape `buildTelephonyDeps` uses, down to the
 * fail-closed-at-boot reasoning: a half-configured provider that boots
 * successfully fails at the first real checkout instead of at startup, which
 * is a worse place to discover it.
 *
 * Unlike telephony, this NEVER returns `undefined` — every instance has SOME
 * `PaymentProvider`, because `PAYMENTS_PROVIDER` defaults to `fake` rather
 * than to an absent credential. An org's trial still starts, and billing
 * routes still answer, on an instance nobody has configured Stripe for; they
 * just cannot reach a real Checkout session, and `FakePaymentProvider` makes
 * that a normal, fully-testable state rather than a missing module.
 */

export interface BillingDeps {
  readonly payments: PaymentProvider;
  readonly trialDays: number;
  readonly pastDueGraceDays: number;
  readonly webhookSecret: string | undefined;
  /**
   * Where billing email goes. Optional so a test can build deps without a
   * mailer — with none, the sends are skipped and nothing throws, the same
   * shape `telephony` uses for an unconfigured carrier.
   *
   * These emails deliberately do NOT go through the notification projection:
   * that mechanism batches and defers, which is right for a mention and wrong
   * for "your payment failed and you have seven days". See `billing-mail.ts`.
   */
  readonly mail?: BillingMailDeps | undefined;
  /** Where Checkout/the customer portal redirect back to. Same value every other absolute link in this app already builds from. */
  readonly webOrigin: string;
}

export function buildBillingDeps(env: Env, mailQueue?: MailQueue): BillingDeps {
  /* No price map here any more. Wave 4 moved the catalog into
     `billing.plans`/`billing.plan_prices`, so a price is a row an operator
     edits from the console rather than a value baked in at boot — and
     `createCheckoutSession` reads it per request. `BILLING_STRIPE_PRICE_ID_PRO`
     was deleted from the env schema in the same change: a variable that
     configured the ONE hardcoded plan has no meaning once plans are data. */
  return {
    payments: buildProvider(env),
    trialDays: env.BILLING_TRIAL_DAYS,
    pastDueGraceDays: env.BILLING_PAST_DUE_GRACE_DAYS,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET,
    webOrigin: env.WEB_ORIGIN,
    /* Absent when no queue was supplied — a test building deps directly gets
       no billing mail rather than a stub that silently swallows it. */
    ...(mailQueue === undefined
      ? {}
      : { mail: { queue: mailQueue, webOrigin: env.WEB_ORIGIN } }),
  };
}

function buildProvider(env: Env): PaymentProvider {
  if (env.PAYMENTS_PROVIDER === 'fake') {
    return new FakePaymentProvider();
  }

  /* PAYMENTS_PROVIDER === 'stripe' from here — every value this fail-closed
     check requires is optional in the env schema (a `fake` deployment needs
     none of them), so the refusal has to happen here, at the point something
     was actually asked to be live. */
  if (env.STRIPE_SECRET_KEY === undefined) {
    throw new Error(
      'STRIPE_SECRET_KEY is required when PAYMENTS_PROVIDER=stripe. Set it to a live or ' +
        'test Stripe secret key, or set PAYMENTS_PROVIDER=fake to run without a Stripe account.',
    );
  }
  if (env.STRIPE_WEBHOOK_SECRET === undefined) {
    throw new Error(
      'STRIPE_WEBHOOK_SECRET is required when PAYMENTS_PROVIDER=stripe — without it, ' +
        'apps/api/src/billing/webhook.ts cannot verify Stripe signed the request, and a ' +
        'signature check that trusts an unset secret is not a check. Find it in the Stripe ' +
        'Dashboard under the webhook endpoint this deployment registered.',
    );
  }
  /* There is deliberately NO boot check for a configured price any more.
     Wave 4 makes the catalog data, so "is there a sellable plan?" is a
     question about rows an operator can fix in the console at any time — not
     a deployment invariant that should stop the API from starting. A `stripe`
     instance with an empty catalog boots fine, serves every other surface,
     and answers the one route that needs a price with a validation error
     naming exactly what to do about it (`org-billing.service.ts`). Refusing
     to boot for it would mean a pricing mistake takes the whole product down. */
  return new StripePaymentProvider({ secretKey: env.STRIPE_SECRET_KEY });
}
