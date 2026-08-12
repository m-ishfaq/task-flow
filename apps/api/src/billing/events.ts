import { z } from 'zod';
import { defineEvent } from '@taskflow/events';

/**
 * Billing & org lifecycle domain events — guardrail 11 (ai/phase-12-wave3.md
 * §4).
 *
 * All six publish through the ORDINARY outbox (`outboxWriter.append` inside
 * `withOrgScope`), unlike `platform-admin/events.ts`'s EventBus path — every
 * billing mutation here has a real org scope open when it writes (the sweep
 * and the webhook handler both resolve the org before touching anything),
 * unlike a platform operator's cross-org actions.
 */

/** Emitted from `org.service.ts::createOrg`, in the SAME transaction as `org.created`. */
export const trialStarted = defineEvent(
  'billing.trial_started',
  z.object({ orgId: z.string(), trialEndsAt: z.string() }).strict(),
);

/** Checkout completes, or a `past_due` org's payment recovers into a real subscription. */
export const subscriptionActivated = defineEvent(
  'billing.subscription_activated',
  z.object({ orgId: z.string(), planId: z.string(), stripeSubscriptionId: z.string() }).strict(),
);

/** `trialing`/`active` → `past_due`. */
export const paymentFailed = defineEvent(
  'billing.payment_failed',
  z.object({ orgId: z.string() }).strict(),
);

/**
 * `past_due` → `canceled`, the sweep's own write. Deliberately distinct from
 * `platform.org_suspended` (Wave 1) even though the user-visible effect
 * rhymes — different cause, different column, different audience reading
 * the audit log later trying to understand why access stopped.
 */
export const orgSuspendedForNonpayment = defineEvent(
  'billing.org_suspended_for_nonpayment',
  z.object({ orgId: z.string() }).strict(),
);

/** Owner-initiated cancel via the Stripe customer portal. */
export const subscriptionCanceled = defineEvent(
  'billing.subscription_canceled',
  z.object({ orgId: z.string() }).strict(),
);

/** An operator's support-ticket override (§3.6) — pushes `billingGraceEndsAt` out, never flips `billingStatus` directly. */
export const graceExtended = defineEvent(
  'billing.grace_extended',
  z.object({ orgId: z.string(), operatorUserId: z.string(), extendedToDate: z.string() }).strict(),
);
