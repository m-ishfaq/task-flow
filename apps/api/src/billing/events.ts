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

/**
 * An invoice arrived from the processor and was recorded (migration 0065).
 *
 * Emitted for every invoice event, including a REPLAY that changes nothing —
 * the row is an upsert, and "we heard about this invoice again" is still a
 * fact the audit trail should carry. A consumer that cares about the
 * transition rather than the notification reads `status`.
 *
 * Carries no amount deliberately. The event stream reaches audit,
 * notifications, search indexing and automation; what a customer was charged
 * is in `billing.invoices` behind `org:billing` (Owner-only), and copying it
 * onto a bus that four subsystems consume widens who can see it for no
 * consumer that needs it.
 */
export const invoiceRecorded = defineEvent(
  'billing.invoice_recorded',
  z
    .object({
      orgId: z.string(),
      providerInvoiceId: z.string(),
      status: z.enum(['draft', 'open', 'paid', 'uncollectible', 'void']),
    })
    .strict(),
);

/**
 * An owner moved their org to a different plan (Phase 12 Wave 4).
 *
 * `effective` is the whole point of the event: an upgrade lands immediately
 * and a downgrade is parked until the paid period ends, so a consumer that
 * treated every change as instant would revoke features someone had paid for.
 * `effectiveAt` is null exactly when `effective` is `now`.
 */
export const planChanged = defineEvent(
  'billing.plan_changed',
  z
    .object({
      orgId: z.string(),
      from: z.string().nullable(),
      to: z.string(),
      effective: z.enum(['now', 'period_end']),
      effectiveAt: z.string().nullable(),
    })
    .strict(),
);

/**
 * A usage period was closed and its overage settled (Phase 12 Wave 4 §3.8).
 *
 * Carries no usage figure and no amount, deliberately, for the reason
 * `invoiceRecorded` carries none: this stream reaches audit, notifications,
 * search indexing and automation, while what a tenant was charged lives behind
 * `org:billing` (Owner-only). `hadOverage` and `charged` are what a consumer
 * actually needs — whether anything was owed, and whether it settled or wants
 * an operator's attention.
 */
export const usagePeriodClosed = defineEvent(
  'billing.usage_period_closed',
  z
    .object({
      orgId: z.string(),
      periodStart: z.string(),
      periodEnd: z.string(),
      hadOverage: z.boolean(),
    })
    .strict(),
);

/**
 * An overage charge was pushed to the processor, or the attempt failed.
 *
 * Split from `usagePeriodClosed` because guardrail 11 pointed out they are two
 * facts, not one: a period CLOSES on every tick that finds one due, and only
 * some of those owe anything. The first version emitted a single event
 * conditionally, which meant the claim row — a mutation on every path — could
 * commit with no event at all whenever there was money involved. Exactly the
 * silent mutation the rule exists to catch.
 *
 * `charged: false` means the processor call failed and an operator should look
 * (`usage_charges.failed_reason`); it is never retried automatically.
 */
export const usageCharged = defineEvent(
  'billing.usage_charged',
  z
    .object({
      orgId: z.string(),
      periodStart: z.string(),
      periodEnd: z.string(),
      charged: z.boolean(),
    })
    .strict(),
);

/**
 * A subscription was set to stop at period end, or that was called off.
 *
 * ONE event with a boolean rather than two kinds, because every consumer that
 * cares cares about the same thing — "is this org leaving?" — and two kinds
 * would make each of them handle both to answer it. The same shape
 * `planChanged` uses for `effective`.
 *
 * Distinct from `subscriptionCanceled`, which is the subscription actually
 * ENDING. This one fires while the org is still fully active and paying, and
 * is the notice that gives a retention path somewhere to hook in.
 */
export const subscriptionCancelScheduled = defineEvent(
  'billing.subscription_cancel_scheduled',
  z.object({ orgId: z.string(), scheduled: z.boolean(), endsAt: z.string().nullable() }).strict(),
);
