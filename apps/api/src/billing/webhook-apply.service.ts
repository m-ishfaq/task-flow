import { and, eq, or, outboxWriter, schema } from '@taskflow/db';
import type { withOrgScope } from '@taskflow/db';
import {
  unsafeAsId,
  type BillingInvoice,
  type RequestId,
  type BillingWebhookEvent,
  type OrgId,
} from '@taskflow/contracts';
import { createEvent } from '@taskflow/events';
import type { BillingDeps } from './deps.js';
import {
  invoiceRecorded,
  paymentFailed,
  subscriptionActivated,
  subscriptionCanceled,
} from './events.js';
import { invalidateEntitlements } from './entitlement-resolver.js';
import { sendBillingMail } from './billing-mail.js';

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

  /* Recorded FIRST, and for every event kind that carries one — before the
     status transitions below, and regardless of whether any of them apply.
     An invoice is a fact about what the processor did; a conditional UPDATE
     that matches zero rows (an already-applied replay) must still leave the
     document in the customer's history. Same transaction as everything else
     here, so a failure rolls the whole event back and the retry re-does it. */
  if (event.invoice !== undefined) {
    await recordInvoice(tx, orgId, event.invoice, envelope);
  }

  switch (event.kind) {
    case 'subscription_activated': {
      /* The plan the customer ACTUALLY bought, resolved from the price the
         processor reported.

         This was hardcoded `'pro'` until Phase 12 Wave 4 — correct while
         `pro` was the only plan that could exist (one env var, one literal),
         and silently wrong the moment a catalog with several tiers did: an
         org checking out Business would have been recorded as Pro, with the
         entitlement resolver then granting Pro's features to someone paying
         for Business.

         Falls back to the org's CURRENT plan rather than to a literal when
         the price cannot be resolved — an unknown price is a reason to change
         nothing, never a reason to assume a tier. */
      const planId =
        (await resolvePlanFromPrice(tx, event.priceId)) ?? (await currentPlanId(tx, orgId));

      /* No fromStatus restriction: trialing, active (idempotent replay),
         past_due (recovery via a fresh subscription), and even canceled
         (reactivated through the portal after the sweep already closed the
         org out) all legitimately land here through the SAME write — there
         is no separate "un-cancel" path to keep in sync with this one. */
      await tx
        .update(schema.orgs)
        .set({
          billingStatus: 'active',
          planId,
          stripeSubscriptionId: event.subscriptionId ?? null,
          billingGraceEndsAt: null,
        })
        .where(eq(schema.orgs.id, orgId));

      /* The entitlement resolver caches per org for 30 seconds. Dropping it
         here is not what makes the change correct — the TTL already does —
         it removes the window where a customer who just paid still sees the
         old plan's features. */
      invalidateEntitlements(orgId);

      await outboxWriter.append(tx, [
        createEvent(
          subscriptionActivated,
          { orgId, planId: planId ?? '', stripeSubscriptionId: event.subscriptionId ?? '' },
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

      /* Immediate, and the most important email this system sends: it starts
         a countdown that ends in losing access, and the owner is the only
         person who can act on it. Queued rather than awaited — a dead SMTP
         relay must not roll back the transaction that recorded a real
         payment failure. */
      if (deps.mail !== undefined) {
        void sendBillingMail(deps.mail, orgId, 'payment_failed', { deadline: graceEndsAt });
      }
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
        /* The schedule is SPENT once the subscription actually ends (0069).
           Leaving it true would make a re-subscribing org's fresh subscription
           read as already cancelled, because nothing else ever clears it. */
        .set({ billingStatus: 'canceled', billingGraceEndsAt: null, cancelAtPeriodEnd: false })
        .where(eq(schema.orgs.id, orgId));

      await outboxWriter.append(tx, [createEvent(subscriptionCanceled, { orgId }, envelope)]);
      invalidateEntitlements(orgId);

      if (deps.mail !== undefined) {
        void sendBillingMail(deps.mail, orgId, 'subscription_canceled');
      }
      return;
    }
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Upserts one invoice into `billing.invoices` (migration 0065).
 *
 * The processor's invoice id is the primary key, so a retried webhook — which
 * carries the same invoice — updates the row rather than duplicating it. That
 * matters beyond tidiness: an invoice's STATUS changes over its life (`open`
 * then `paid`, or `open` then `void`), and each change arrives as another
 * event about the same document. Insert-only would leave a customer's history
 * showing the same invoice three times in three states.
 */
async function recordInvoice(
  tx: Parameters<Parameters<typeof withOrgScope>[1]>[0],
  orgId: OrgId,
  invoice: BillingInvoice,
  envelope: { orgId: OrgId; actorId: null; requestId: RequestId },
): Promise<void> {
  const row = {
    providerInvoiceId: invoice.providerInvoiceId,
    orgId,
    number: invoice.number ?? null,
    status: invoice.status,
    amountDueCents: invoice.amountDueCents,
    amountPaidCents: invoice.amountPaidCents,
    currency: invoice.currency,
    periodStart: invoice.periodStart ?? null,
    periodEnd: invoice.periodEnd ?? null,
    hostedInvoiceUrl: invoice.hostedInvoiceUrl ?? null,
    invoicePdfUrl: invoice.invoicePdfUrl ?? null,
    issuedAt: invoice.issuedAt,
  };

  await tx
    .insert(schema.invoices)
    .values(row)
    .onConflictDoUpdate({
      target: schema.invoices.providerInvoiceId,
      /* `orgId` and `issuedAt` are deliberately NOT updated. The org a
         customer id resolves to cannot change, and the issue date is the
         processor's own — a later event about the same invoice reports the
         same moment, so rewriting it could only ever introduce drift. */
      set: {
        number: row.number,
        status: row.status,
        amountDueCents: row.amountDueCents,
        amountPaidCents: row.amountPaidCents,
        currency: row.currency,
        periodStart: row.periodStart,
        periodEnd: row.periodEnd,
        hostedInvoiceUrl: row.hostedInvoiceUrl,
        invoicePdfUrl: row.invoicePdfUrl,
      },
    });

  /* Guardrail 11. The rule fired on the upsert above and it was right to: an
     invoice landing is exactly the kind of state change audit, notifications
     and automation all read the event stream for, and a silent write breaks
     all four without failing anything. Appended to the OUTBOX inside this
     same transaction, so the event and the row commit together. */
  await outboxWriter.append(tx, [
    createEvent(
      invoiceRecorded,
      { orgId, providerInvoiceId: invoice.providerInvoiceId, status: invoice.status },
      envelope,
    ),
  ]);
}

/**
 * The plan a processor price belongs to, or null.
 *
 * Searches EVERY price row, not just the current ones. A grandfathered
 * customer renews against an ARCHIVED price (that is the entire point of
 * §3.2's append-and-archive design), so filtering to `is_current` here would
 * fail to resolve exactly the customers the grandfathering exists to protect —
 * and they would silently keep whatever plan they had, which happens to be
 * right today and would not be after any plan change.
 */
async function resolvePlanFromPrice(
  tx: Parameters<Parameters<typeof withOrgScope>[1]>[0],
  priceId: string | undefined,
): Promise<string | null> {
  if (priceId === undefined) return null;

  const rows = await tx
    .select({ planId: schema.planPrices.planId })
    .from(schema.planPrices)
    .where(eq(schema.planPrices.stripePriceId, priceId))
    .limit(1);

  return rows[0]?.planId ?? null;
}

/** The org's current plan — the fallback when a price cannot be resolved. */
async function currentPlanId(
  tx: Parameters<Parameters<typeof withOrgScope>[1]>[0],
  orgId: OrgId,
): Promise<string | null> {
  const rows = await tx
    .select({ planId: schema.orgs.planId })
    .from(schema.orgs)
    .where(eq(schema.orgs.id, orgId))
    .limit(1);

  return rows[0]?.planId ?? null;
}
