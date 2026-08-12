import { and, eq, or, outboxWriter, schema } from '@taskflow/db';
import type { withOrgScope } from '@taskflow/db';
import { unsafeAsId, type BillingWebhookEvent, type OrgId } from '@taskflow/contracts';
import { createEvent } from '@taskflow/events';
import type { BillingDeps } from './deps.js';
import { paymentFailed, subscriptionActivated, subscriptionCanceled } from './events.js';

/**
 * Applies a VERIFIED Stripe webhook event to `orgId`'s billing state
 * (Phase 12 Wave 3 §3.5). Separate from `webhook.ts`/`webhook.routes.ts` —
 * this is a `*.service.ts` file precisely because it mutates and guardrail
 * 11 should hold it to that, unlike `customer-link.ts`'s deliberate plumbing.
 *
 * Takes the CALLER's transaction rather than opening its own — the route
 * handler commits `billing.webhook_events`' idempotency row in the SAME
 * transaction as this function's write, the identical claim/write/mark
 * discipline `commitWebhookNonce` uses and for the identical reason: Stripe
 * retries an event it could not confirm was handled, and a retry carries the
 * same event id. Recording the id in a SEPARATE transaction from the effect
 * would mean a failure applying the effect still leaves the id marked seen,
 * silently losing the retry that exists to recover it.
 *
 * Every transition here is a CONDITIONAL `UPDATE ... WHERE billingStatus =
 * <fromStatus>`, the same `claimForScanning`/`suspendOrg` shape used
 * everywhere else in this codebase a state machine needs to avoid two
 * racing writers double-applying a transition.
 */
export async function applyBillingWebhookEvent(
  tx: Parameters<Parameters<typeof withOrgScope>[1]>[0],
  deps: BillingDeps,
  orgId: OrgId,
  event: BillingWebhookEvent,
  requestId: string,
): Promise<void> {
  const envelope = {
    orgId,
    actorId: null,
    requestId: unsafeAsId<'RequestId'>(requestId),
  };

  switch (event.kind) {
    case 'subscription_activated': {
      /* No fromStatus restriction: trialing, active (idempotent replay),
         past_due (recovery via a fresh subscription), and even canceled
         (reactivated through the portal after the sweep already closed the
         org out) all legitimately land here through the SAME write — there
         is no separate "un-cancel" path to keep in sync with this one. */
      await tx
        .update(schema.orgs)
        .set({
          billingStatus: 'active',
          planId: 'pro',
          stripeSubscriptionId: event.subscriptionId ?? null,
          billingGraceEndsAt: null,
        })
        .where(eq(schema.orgs.id, orgId));

      await outboxWriter.append(tx, [
        createEvent(
          subscriptionActivated,
          { orgId, planId: 'pro', stripeSubscriptionId: event.subscriptionId ?? '' },
          envelope,
        ),
      ]);
      return;
    }

    case 'payment_failed': {
      const graceEndsAt = new Date(Date.now() + deps.pastDueGraceDays * DAY_MS);
      const result = await tx
        .update(schema.orgs)
        .set({ billingStatus: 'past_due', billingGraceEndsAt: graceEndsAt })
        .where(
          and(
            eq(schema.orgs.id, orgId),
            or(eq(schema.orgs.billingStatus, 'trialing'), eq(schema.orgs.billingStatus, 'active')),
          ),
        );
      if (result.rowCount === 0) return;

      await outboxWriter.append(tx, [createEvent(paymentFailed, { orgId }, envelope)]);
      return;
    }

    case 'payment_recovered': {
      /* No event of its own — 'active' is the same state
         `subscription_activated` already has an event for, and a payment
         recovering onto an EXISTING subscription is not a new fact worth a
         second audit entry beyond the state itself changing. */
      await tx
        .update(schema.orgs)
        .set({ billingStatus: 'active', billingGraceEndsAt: null })
        .where(and(eq(schema.orgs.id, orgId), eq(schema.orgs.billingStatus, 'past_due')));
      return;
    }

    case 'subscription_canceled': {
      /* Owner-initiated, via the portal — not a payment failure, and
         deliberately does NOT go through past_due first: Stripe already
         kept the subscription live until its paid period ended, so by the
         time this event arrives there is nothing left to be lenient about. */
      await tx
        .update(schema.orgs)
        .set({ billingStatus: 'canceled', billingGraceEndsAt: null })
        .where(eq(schema.orgs.id, orgId));

      await outboxWriter.append(tx, [createEvent(subscriptionCanceled, { orgId }, envelope)]);
      return;
    }
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;
