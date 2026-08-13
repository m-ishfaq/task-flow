import {
  and,
  desc,
  eq,
  gte,
  lt,
  outboxWriter,
  schema,
  sumWithFallback,
  withOrgScope,
} from '@taskflow/db';
import { unsafeAsId, type OrgId, type PaymentProvider } from '@taskflow/contracts';
import { createEvent } from '@taskflow/events';
import { getEntitlements } from './entitlement-resolver.js';
import { usageCharged, usagePeriodClosed } from './events.js';

/**
 * Overage invoicing — the platform's own margin on tenant usage (Phase 12
 * Wave 4, ai/phase-12-wave4-plans.md §3.8).
 *
 * A plan includes some amount of telephony spend (`telephony_included_cents`);
 * past it, the tenant is billed what the carrier charged us plus the plan's
 * markup. That is where this deployment makes money on usage rather than only
 * on seats, and it is the reason `billing.plans` carries pricing policy
 * (`included`, `markup_pct`) that is NOT a gate.
 *
 * **Overage is billed, never blocked.** The hard stop remains
 * `comms.spend_policy.cap_cents`, enforced by `checkOutboundAllowed` before
 * anything reaches a carrier, exactly as it is today. Nothing in this file
 * refuses anything — an org past its included allowance keeps making calls and
 * receives a larger invoice. Two different questions ("can they afford this"
 * and "what do they owe"), deliberately answered in two different places: a
 * margin calculation that could refuse a call would be a spend control with no
 * test coverage as one, sitting outside the one chokepoint §6.1 named.
 *
 * ## The period is CHAINED, not read from the subscription
 *
 * The obvious implementation closes the period `identity.orgs.current_period_end`
 * names, and it has a race that loses money silently: `reconcileSubscription`
 * and the renewal webhook both advance that column, so a close job arriving
 * after either of them sees a period end in the FUTURE, skips, and never bills
 * the period that actually closed. Nothing reports it.
 *
 * So each period begins where the last one ended — read from this org's own
 * most recent `billing.usage_charges` row — and the subscription's period end
 * is consulted exactly once, to bootstrap the first window. After that the
 * chain is self-sustaining and depends on no mutable column: a worker down for
 * two months closes the older period on its next tick and the next one on the
 * tick after, in order, with no window skipped and none counted twice.
 */

/** Milliseconds in the two cadences a plan can be billed at. */
const INTERVAL_MS = {
  month: 30 * 24 * 60 * 60 * 1000,
  year: 365 * 24 * 60 * 60 * 1000,
} as const;

export interface OverageOutcome {
  readonly closed: boolean;
  readonly periodStart?: Date;
  readonly periodEnd?: Date;
  readonly billableCents?: number;
  readonly invoiceItemId?: string | null;
}

/**
 * `max(0, round(usage x (1 + markup/100)) - included)`.
 *
 * Exported and pure so the arithmetic can be tested without a database, a
 * processor or a clock — the three things that make the rest of this file
 * expensive to exercise. The rounding happens on the MARKED-UP figure rather
 * than on each ledger row, because rounding per row and then summing drifts
 * upward by up to half a cent per call: over a month of traffic that is a
 * charge the tenant can compute themselves and find wrong.
 */
export function computeBillableCents(options: {
  readonly usageCents: number;
  readonly includedCents: number;
  readonly markupPct: number;
}): number {
  const withMarkup = Math.round(options.usageCents * (1 + options.markupPct / 100));
  return Math.max(0, withMarkup - options.includedCents);
}

/**
 * Closes one org's oldest unbilled period, if one has actually ended.
 *
 * Returns `{ closed: false }` for every ordinary "nothing to do" case — no
 * subscription, the current window still open, the org never billed. Those are
 * answers, not failures, and the worker logs a count rather than an error.
 */
export async function closeUsagePeriod(
  orgId: OrgId,
  deps: { readonly payments: PaymentProvider; readonly now?: Date },
): Promise<OverageOutcome> {
  const now = deps.now ?? new Date();

  const context = await withOrgScope(orgId, async (tx) => {
    const orgRows = await tx
      .select({
        customerId: schema.orgs.stripeCustomerId,
        subscriptionId: schema.orgs.stripeSubscriptionId,
        currentPeriodEnd: schema.orgs.currentPeriodEnd,
        interval: schema.orgs.currentPriceInterval,
        planId: schema.orgs.planId,
      })
      .from(schema.orgs)
      .where(eq(schema.orgs.id, orgId))
      .limit(1);

    const org = orgRows[0];
    if (org === undefined) return null;

    const lastRows = await tx
      .select({ periodEnd: schema.usageCharges.periodEnd })
      .from(schema.usageCharges)
      .where(eq(schema.usageCharges.orgId, orgId))
      .orderBy(desc(schema.usageCharges.periodEnd))
      .limit(1);

    /* Currency follows the plan's own current price rather than a constant:
       a catalog priced in eur must not attach a usd overage item to a eur
       invoice, which the processor would reject at finalization — long after
       this job reported success. */
    const priceRows =
      org.planId === null
        ? []
        : await tx
            .select({ currency: schema.planPrices.currency })
            .from(schema.planPrices)
            .where(
              and(
                eq(schema.planPrices.planId, org.planId),
                eq(schema.planPrices.isCurrent, true),
              ),
            )
            .limit(1);

    return {
      ...org,
      lastPeriodEnd: lastRows[0]?.periodEnd ?? null,
      currency: priceRows[0]?.currency ?? 'usd',
    };
  });

  if (context === null) return { closed: false };

  /* A subscription is what an invoice item attaches to. A free-plan org has
     no included allowance to exceed and nothing to bill against, so there is
     no period to close — not a failure, just an org this job does not
     concern. */
  if (context.customerId === null || context.subscriptionId === null) return { closed: false };

  const intervalMs = INTERVAL_MS[context.interval === 'year' ? 'year' : 'month'];

  /* Bootstrap: the only read of `current_period_end`, and only when this org
     has never been billed. One period back from the current renewal is the
     window that just ran; usage before it is not billed, which is the safe
     direction to be wrong in for a customer's first invoice. */
  const periodStart =
    context.lastPeriodEnd ??
    (context.currentPeriodEnd === null
      ? null
      : new Date(context.currentPeriodEnd.getTime() - intervalMs));

  if (periodStart === null) return { closed: false };

  const periodEnd = new Date(periodStart.getTime() + intervalMs);

  /* The window is still open. Billing it now would charge for usage that has
     not happened yet and would move the chain forward past it. */
  if (periodEnd.getTime() > now.getTime()) return { closed: false };

  const entitlements = await getEntitlements(orgId);
  const includedCents = entitlements.limits.telephonyIncludedCents ?? 0;
  const markupPct = entitlements.limits.telephonyMarkupPct ?? 0;

  const claim = await withOrgScope(orgId, async (tx) => {
    const spendRows = await tx
      .select({
        /* COALESCE(actual, estimated) — the same number the spend gate
           enforces against. SUM(actual) alone treats every call the carrier
           has not reconciled yet as free, which would under-bill exactly the
           traffic that arrived near the end of the period. */
        total: sumWithFallback(schema.spendLedger.actualCents, schema.spendLedger.estimatedCents),
      })
      .from(schema.spendLedger)
      .where(
        and(
          eq(schema.spendLedger.orgId, orgId),
          gte(schema.spendLedger.occurredAt, periodStart),
          /* Half-open. A ledger row landing exactly on the boundary belongs
             to the next period, so no cent is counted in both. */
          lt(schema.spendLedger.occurredAt, periodEnd),
        ),
      );

    const usageCents = Number(spendRows[0]?.total ?? 0);
    const billableCents = computeBillableCents({ usageCents, includedCents, markupPct });

    /* THE CLAIM, and it happens BEFORE the processor is called. The primary
       key on (org_id, period_start) is what makes two workers racing on the
       same period produce one charge instead of two — decided by Postgres,
       not by a check-then-act both of them pass. Only the writer whose insert
       reported a row goes on to spend money. */
    const inserted = await tx
      .insert(schema.usageCharges)
      .values({
        orgId,
        periodStart,
        periodEnd,
        usageCents,
        includedCents,
        markupPct,
        billableCents,
      })
      .onConflictDoNothing();

    if ((inserted.rowCount ?? 0) === 0) return null;

    /* UNCONDITIONAL, and guardrail 11 is what made it so. The claim row is a
       mutation on every path — "this period is now closed" — and the first
       version only emitted when there was nothing to bill, so a period with
       money in it committed silently. A consumer that wants only the paying
       ones reads `hadOverage`. */
    await outboxWriter.append(tx, [
      createEvent(
        usagePeriodClosed,
        {
          orgId,
          periodStart: periodStart.toISOString(),
          periodEnd: periodEnd.toISOString(),
          /* Whether anything was owed at all, not how much. The stream reaches
             audit, notifications, search indexing and automation, and what a
             tenant was charged lives behind `org:billing` (Owner-only) — the
             same reason `invoiceRecorded` carries no amount. */
          hadOverage: billableCents > 0,
        },
        { orgId, actorId: null, requestId: unsafeAsId<'RequestId'>(CLOSE_REQUEST_ID) },
      ),
    ]);

    return { usageCents, billableCents };
  });

  if (claim === null) return { closed: false };

  /* Nothing to charge. The row still exists and still moves the chain
     forward: an org inside its allowance has a CLOSED period, not an
     unattempted one, or every tick would recompute the same window forever. */
  if (claim.billableCents === 0) {
    return {
      closed: true,
      periodStart,
      periodEnd,
      billableCents: 0,
      invoiceItemId: null,
    };
  }

  let invoiceItemId: string | null = null;
  let failedReason: string | null = null;

  try {
    /* The idempotency key is the second layer, covering the one window the
       claim above cannot: a call the processor ACCEPTED whose response never
       reached us, leaving our row saying nothing was charged. Derived from
       the org and the period rather than randomly, so a retry produces the
       same key and the processor replays its original answer. */
    const result = await deps.payments.createInvoiceItem({
      customerId: context.customerId,
      amountCents: claim.billableCents,
      currency: context.currency,
      description: `Usage above plan allowance, ${periodStart.toISOString().slice(0, 10)} to ${periodEnd.toISOString().slice(0, 10)}`,
      idempotencyKey: `usage-${orgId}-${periodStart.toISOString()}`,
    });
    invoiceItemId = result.invoiceItemId;
  } catch (error) {
    /* Recorded, not rethrown and not retried. The processor's API cannot tell
       "the call never landed" from "it landed and the response was lost", and
       guessing wrong bills a customer twice — which is worse than a charge an
       operator has to go and look at. `usage_charges_failed_idx` is the query
       that finds these. */
    failedReason = error instanceof Error ? error.message.slice(0, 500) : 'unknown provider error';
  }

  /* The outcome and its event in ONE transaction (guardrail 11's own rule
     about the mutation's transaction). If this rolls back, the claim row stays
     as it was — billable, unsent, with neither outcome column set — which the
     next tick will not retry, because the claim is already taken. That is the
     same operator-visible state a provider failure produces, and it is
     deliberately the state a partial failure lands in rather than a silent
     re-attempt that could bill twice. */
  await withOrgScope(orgId, async (tx) => {
    await tx
      .update(schema.usageCharges)
      .set(
        invoiceItemId === null
          ? { failedReason }
          : { providerInvoiceItemId: invoiceItemId, chargedAt: new Date() },
      )
      .where(
        and(
          eq(schema.usageCharges.orgId, orgId),
          eq(schema.usageCharges.periodStart, periodStart),
        ),
      );

    await outboxWriter.append(tx, [
      createEvent(
        usageCharged,
        {
          orgId,
          periodStart: periodStart.toISOString(),
          periodEnd: periodEnd.toISOString(),
          /* False means the processor call failed and an operator should look
             (`usage_charges.failed_reason`); never retried automatically. */
          charged: invoiceItemId !== null,
        },
        { orgId, actorId: null, requestId: unsafeAsId<'RequestId'>(CLOSE_REQUEST_ID) },
      ),
    ]);
  });

  return { closed: true, periodStart, periodEnd, billableCents: claim.billableCents, invoiceItemId };
}

/* Both events above are appended INLINE rather than through a helper, and
   guardrail 11 is the reason. The rule counts `x.append(...)` lexically
   inside the outermost exported function; a helper call is a plain identifier,
   so a perfectly correct emit behind one reads to the rule as no emit at all.
   Rather than argue with it, this file uses the shape every other service in
   the codebase uses — which is also the shape that makes "does this mutation
   emit?" answerable by reading the function top to bottom. */

/**
 * A fixed, recognizable request id for every event this job publishes — the
 * same reasoning `sweep.service.ts`'s own constant gives: there is no HTTP
 * request behind a scheduled tick, and a random id per event would make "which
 * of these came from the period close" a string to grep for rather than a
 * constant to recognize. Distinct from the sweep's, because the two run in the
 * same tick and an audit reader needs to tell them apart.
 */
const CLOSE_REQUEST_ID = '00000000-0000-0000-0000-000000005eea';
