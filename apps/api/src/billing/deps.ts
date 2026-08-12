import { FakePaymentProvider, StripePaymentProvider } from '@taskflow/payments';
import type { PaymentProvider } from '@taskflow/contracts';
import type { Env } from '../config/env.js';

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
  /** This wave's one plan id -> the configured processor's own price id. Empty when unconfigured. */
  readonly planPriceIds: ReadonlyMap<string, string>;
  readonly webhookSecret: string | undefined;
}

export function buildBillingDeps(env: Env): BillingDeps {
  const payments = buildProvider(env);

  const planPriceIds = new Map<string, string>();
  if (env.BILLING_STRIPE_PRICE_ID_PRO !== undefined) {
    planPriceIds.set('pro', env.BILLING_STRIPE_PRICE_ID_PRO);
  }

  return {
    payments,
    trialDays: env.BILLING_TRIAL_DAYS,
    pastDueGraceDays: env.BILLING_PAST_DUE_GRACE_DAYS,
    planPriceIds,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET,
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
  if (env.BILLING_STRIPE_PRICE_ID_PRO === undefined) {
    throw new Error(
      'BILLING_STRIPE_PRICE_ID_PRO is required when PAYMENTS_PROVIDER=stripe — without it, ' +
        'an owner clicking "Upgrade" has no Stripe Price id to check out against.',
    );
  }

  return new StripePaymentProvider({ secretKey: env.STRIPE_SECRET_KEY });
}
