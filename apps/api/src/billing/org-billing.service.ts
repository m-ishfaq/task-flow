import {
  and,
  desc,
  eq,
  gte,
  outboxWriter,
  schema,
  sumColumn,
  sumWithFallback,
  withOrgScope,
} from '@taskflow/db';
import { createEvent } from '@taskflow/events';
import { newId } from '@taskflow/security';
import { planChanged, subscriptionActivated, subscriptionCancelScheduled } from './events.js';
import { FLAGS, FLAG_NAMES } from '@taskflow/feature-flags';
import { getEntitlements, invalidateEntitlements } from './entitlement-resolver.js';
import { getFeatureFlags } from '../platform-admin/flag-evaluator.js';
import { errors, unsafeAsId, type OrgId, type UserId } from '@taskflow/contracts';
import type { BillingDeps } from './deps.js';
import { ensureCustomerId } from './customer-link.js';
import { sendBillingMail } from './billing-mail.js';

/**
 * The owner-facing half of billing (Phase 12 Wave 3 §3.1, §3.6) — "what does
 * MY org pay, and can I change it." Every function here is scoped to exactly
 * one org (`withOrgScope`), reached only through `org:billing`
 * (`packages/policy`'s ORG_LEVEL, owner-only permission with no resource
 * tuple that can ever satisfy it — see that file's own comment). Distinct
 * from `platform-admin/billing.ts`'s operator-facing, cross-org half, which
 * this module never imports and never calls.
 */

export interface BillingStatusView {
  readonly billingStatus: string;
  readonly planId: string | null;
  readonly trialEndsAt: Date | null;
  readonly billingGraceEndsAt: Date | null;
}

/**
 * Everything the Billing page needs, in one read.
 *
 * `getStatus` below answers four fields and was the whole owner-facing
 * surface, which left the page unable to say what the org is ON, what that
 * includes, how much of it they have used, or who to talk to about it — the
 * four questions anyone opening a billing page actually has.
 *
 * Deliberately NOT merged into `getStatus`: that one is called by the org
 * bootstrap on a hot path, and this is six reads.
 */
export interface BillingOverview extends BillingStatusView {
  readonly planName: string | null;
  /** What the current plan includes, resolved through the four tiers. */
  readonly features: readonly { readonly flagName: string; readonly description: string }[];
  /**
   * Telephony spend over the rolling 30 days, and the ceiling it counts
   * against. `COALESCE(actual, estimated)` — the same number the spend gate
   * enforces, never `SUM(actual)`, which reads low while calls are in flight.
   */
  readonly usage: {
    readonly telephonySpentCents: number;
    readonly telephonyCapCents: number | null;
    readonly telephonyIncludedCents: number;
    /**
     * The AI assistant's own spend, alongside telephony's — closing a real
     * gap: `ai/spend-gate.ts`'s own budget report was platform-operator-only
     * (`aiSpendReport`, gated `withPlatformAdminScope`) until now, so an org
     * owner could see what their org spends on TELEPHONY but not on the
     * assistant, even though both are real third-party spend this org pays
     * for. Calendar-month, matching `readAiSpendState`'s own window — the
     * budget's name (`aiTokenBudgetMonthlyCents`) is the contract, unlike
     * telephony's rolling 30-day window.
     */
    readonly aiSpentCents: number;
    /** null = unlimited (Phase 12 Wave 4's entitlement convention). */
    readonly aiCapCents: number | null;
  };
  /**
   * Who can actually change any of this.
   *
   * `org:billing` is Owner-only and ORG_LEVEL — no tuple can grant it — so an
   * admin reading this page can do nothing about what it says. Naming the
   * owner turns a dead end into a next step.
   */
  readonly billingContact: { readonly email: string; readonly name: string | null } | null;

  /**
   * ONE answer to "what happens next, and when".
   *
   * Three date columns exist and at most one matters at a time, but which one
   * depends on the org's status — so every surface that rendered them
   * independently had to reimplement that decision, and each showed a blank
   * cell for the states it had not thought about. Computed once, here.
   *
   * Null when nothing is scheduled: an org on a free plan with no
   * subscription has no next event, and inventing one would be worse than
   * saying so.
   */
  readonly deadline: {
    readonly kind: 'trial_ends' | 'grace_ends' | 'renews' | 'cancels' | 'plan_changes';
    readonly at: Date;
    /** Set only for `plan_changes` — the plan they are moving TO. */
    readonly planId: string | null;
  } | null;

  /**
   * What they pay today, so the switch confirmation can say whether a change
   * charges now or waits.
   *
   * The client uses it only to WORD the dialog. The server decides the actual
   * direction from the same comparison (`changePlan`), so a client that got
   * this wrong would show the wrong sentence and still get the right
   * behaviour — which is the correct way round for a number that reaches a
   * browser.
   */
  readonly currentPriceCents: number | null;

  /**
   * The subscription stops at the end of the paid period instead of renewing.
   *
   * Also readable from `deadline.kind === 'cancels'`; carried separately
   * because the two answer different questions — the deadline is "what date
   * matters", this is "which controls belong on screen" — and a page deriving
   * the second from the first goes wrong the moment a higher-priority
   * deadline (a grace period) takes the slot.
   */
  readonly cancelAtPeriodEnd: boolean;

  /**
   * There is a live subscription at the processor.
   *
   * Answered here rather than inferred by the client, because the client's
   * only previous route to it was `deadline.kind` — and the deadline holds
   * exactly ONE value while several of them imply a subscription. Scheduling a
   * cancellation moved the kind to `cancels` and the plan picker's buttons
   * silently changed from "Switch" to "Choose", which starts a CHECKOUT for an
   * org that already has a subscription — refused by `createCheckoutSession`,
   * so the button simply stopped working. A `past_due` org had the same bug
   * for longer: `grace_ends` outranks `renews` too.
   *
   * The subscription id itself is deliberately not exposed — the client needs
   * the answer, not the processor's identifier.
   */
  readonly hasSubscription: boolean;
}

/**
 * Picks the one date that matters for this org right now.
 *
 * Order is deliberate. A parked plan change outranks a renewal because it is
 * the more surprising fact — "renews on the 14th" is true and useless when
 * what actually happens on the 14th is a downgrade. Grace outranks everything
 * because it is the only one with consequences for access.
 */
function resolveDeadline(row: {
  billingStatus: string;
  trialEndsAt: Date | null;
  billingGraceEndsAt: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  pendingPlanId: string | null;
  pendingPlanEffectiveAt: Date | null;
}): BillingOverview['deadline'] {
  if (row.billingStatus === 'past_due' && row.billingGraceEndsAt !== null) {
    return { kind: 'grace_ends', at: row.billingGraceEndsAt, planId: null };
  }
  /* Ahead of a parked plan change on purpose: scheduling a downgrade and
     then cancelling leaves both facts on the row, and the one that matters to
     the person reading it is that the subscription is ending. */
  if (row.cancelAtPeriodEnd && row.currentPeriodEnd !== null) {
    return { kind: 'cancels', at: row.currentPeriodEnd, planId: null };
  }
  if (row.pendingPlanId !== null && row.pendingPlanEffectiveAt !== null) {
    return { kind: 'plan_changes', at: row.pendingPlanEffectiveAt, planId: row.pendingPlanId };
  }
  if (row.billingStatus === 'trialing' && row.trialEndsAt !== null) {
    return { kind: 'trial_ends', at: row.trialEndsAt, planId: null };
  }
  if (row.currentPeriodEnd !== null) {
    return { kind: 'renews', at: row.currentPeriodEnd, planId: null };
  }
  return null;
}

const SPEND_WINDOW_DAYS = 30;

/** UTC calendar-month boundary — `aiTokenBudgetMonthlyCents`'s own name is the contract. */
function startOfCurrentMonth(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export async function getOverview(orgId: OrgId): Promise<BillingOverview> {
  const [status, entitlements, flags] = await Promise.all([
    getStatus(orgId),
    getEntitlements(orgId),
    getFeatureFlags(),
  ]);

  return withOrgScope(orgId, async (tx) => {
    const planRows =
      status.planId === null
        ? []
        : await tx
            .select({ name: schema.plans.name })
            .from(schema.plans)
            .where(eq(schema.plans.id, status.planId))
            .limit(1);

    const extraRows = await tx
      .select({
        currentPeriodEnd: schema.orgs.currentPeriodEnd,
        cancelAtPeriodEnd: schema.orgs.cancelAtPeriodEnd,
        subscriptionId: schema.orgs.stripeSubscriptionId,
        currentPriceCents: schema.orgs.currentPriceCents,
        pendingPlanId: schema.orgs.pendingPlanId,
        pendingPlanEffectiveAt: schema.orgs.pendingPlanEffectiveAt,
      })
      .from(schema.orgs)
      .where(eq(schema.orgs.id, orgId))
      .limit(1);
    const extra = extraRows[0];

    const since = new Date(Date.now() - SPEND_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const spendRows = await tx
      .select({
        total: sumWithFallback(schema.spendLedger.actualCents, schema.spendLedger.estimatedCents),
      })
      .from(schema.spendLedger)
      .where(and(eq(schema.spendLedger.orgId, orgId), gte(schema.spendLedger.occurredAt, since)));

    /* AI spend, over the calendar month `aiTokenBudgetMonthlyCents` bills
       against — not `ai/spend-gate.ts`'s own `readAiSpendState`, which would
       pull `apps/api/src/ai` into `apps/api/src/billing` and back again
       (`spend-gate.ts` already imports `getEntitlements` from THIS module),
       a real import cycle rather than a hypothetical one. A small, deliberate
       duplicate of the same calendar-month arithmetic, matching this
       codebase's own accepted precedent for a duplicate this small
       (`apps/mobile`'s own `slugify`, cited for the identical reason). */
    const aiSince = startOfCurrentMonth();
    const aiSpendRows = await tx
      .select({ total: sumColumn(schema.aiUsageLedger.costCents) })
      .from(schema.aiUsageLedger)
      .where(
        and(eq(schema.aiUsageLedger.orgId, orgId), gte(schema.aiUsageLedger.occurredAt, aiSince)),
      );

    /* The owner, for "who do I ask". LEFT join on profiles — a profile row is
       lazily created, and an inner join would hide the owner's ADDRESS from
       anyone whose owner has never opened the account page. */
    const ownerRows = await tx
      .select({ email: schema.users.email, name: schema.profiles.displayName })
      .from(schema.memberships)
      .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
      .leftJoin(schema.profiles, eq(schema.profiles.userId, schema.memberships.userId))
      .where(
        and(
          eq(schema.memberships.orgId, orgId),
          eq(schema.memberships.role, 'owner'),
          eq(schema.memberships.status, 'active'),
        ),
      )
      .limit(1);

    const owner = ownerRows[0];

    return {
      ...status,
      planName: planRows[0]?.name ?? null,
      features: FLAG_NAMES.filter(
        (name) =>
          FLAGS[name].perOrg && flags.isEnabled(name, { orgOverrides: entitlements.features }),
      ).map((name) => ({ flagName: name, description: FLAGS[name].description })),
      usage: {
        telephonySpentCents: Number(spendRows[0]?.total ?? 0),
        telephonyCapCents: entitlements.limits.telephonyCapCents ?? null,
        telephonyIncludedCents: entitlements.limits.telephonyIncludedCents ?? 0,
        /* Postgres SUM over bigint arrives as a STRING through the driver,
           and `Number(undefined)` is NaN, which compares false against every
           threshold — the identical trap `readAiSpendState` guards against,
           parsed explicitly and floored at 0 here for the same reason. */
        aiSpentCents: Math.max(0, Number.parseInt(aiSpendRows[0]?.total ?? '0', 10) || 0),
        aiCapCents: entitlements.limits.aiTokenBudgetMonthlyCents ?? null,
      },
      billingContact: owner === undefined ? null : { email: owner.email, name: owner.name },
      currentPriceCents: extra?.currentPriceCents ?? null,
      cancelAtPeriodEnd: extra?.cancelAtPeriodEnd ?? false,
      hasSubscription: (extra?.subscriptionId ?? null) !== null,
      deadline: resolveDeadline({
        billingStatus: status.billingStatus,
        trialEndsAt: status.trialEndsAt,
        billingGraceEndsAt: status.billingGraceEndsAt,
        currentPeriodEnd: extra?.currentPeriodEnd ?? null,
        cancelAtPeriodEnd: extra?.cancelAtPeriodEnd ?? false,
        pendingPlanId: extra?.pendingPlanId ?? null,
        pendingPlanEffectiveAt: extra?.pendingPlanEffectiveAt ?? null,
      }),
    };
  });
}

export async function getStatus(orgId: OrgId): Promise<BillingStatusView> {
  return withOrgScope(orgId, async (tx) => {
    const rows = await tx
      .select({
        billingStatus: schema.orgs.billingStatus,
        planId: schema.orgs.planId,
        trialEndsAt: schema.orgs.trialEndsAt,
        billingGraceEndsAt: schema.orgs.billingGraceEndsAt,
      })
      .from(schema.orgs)
      .where(eq(schema.orgs.id, orgId))
      .limit(1);

    const org = rows[0];
    if (!org) throw errors.notFound();
    return org;
  });
}

/**
 * The plans an owner may actually buy, with their current prices.
 *
 * Reads the catalog as the ORDINARY application role — `taskflow_app` holds
 * SELECT on `billing.plans` and `billing.plan_prices` and nothing else
 * (migration 0062), so an owner can see what is on sale and can never edit it.
 * There is no `withOrgScope` filter to apply: the catalog carries no `org_id`,
 * because a plan belongs to no tenant.
 *
 * Filtered to `isActive` here, unlike the operator console's own list, which
 * deliberately shows retired tiers: an org already ON a retired plan keeps it,
 * but nobody may newly buy one.
 */
export interface PurchasablePlan {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly features: readonly string[];
  readonly prices: readonly {
    readonly interval: 'month' | 'year';
    readonly amountCents: number;
    readonly currency: string;
  }[];
}

export async function listPurchasablePlans(orgId: OrgId): Promise<readonly PurchasablePlan[]> {
  return withOrgScope(orgId, async (tx) => {
    const plans = await tx
      .select()
      .from(schema.plans)
      .where(eq(schema.plans.isActive, true))
      .orderBy(schema.plans.sortOrder);

    const prices = await tx
      .select()
      .from(schema.planPrices)
      .where(eq(schema.planPrices.isCurrent, true));

    return plans.map((plan) => ({
      id: plan.id,
      name: plan.name,
      description: plan.description,
      features: plan.features,
      prices: prices
        .filter((price) => price.planId === plan.id)
        .map((price) => ({
          interval: price.interval,
          amountCents: price.amountCents,
          currency: price.currency,
        })),
    }));
  });
}

export interface InvoiceRow {
  readonly providerInvoiceId: string;
  readonly number: string | null;
  readonly status: string;
  readonly amountDueCents: number;
  readonly amountPaidCents: number;
  readonly currency: string;
  readonly periodStart: Date | null;
  readonly periodEnd: Date | null;
  /** The processor's own hosted copy — this table is a mirror, that is the original. */
  readonly hostedInvoiceUrl: string | null;
  readonly invoicePdfUrl: string | null;
  readonly issuedAt: Date;
}

/**
 * This org's invoices, newest first (migration 0065).
 *
 * Read from OUR table, not from the processor: the page has to work during a
 * processor incident, and the record has to survive a processor swap. Ordered
 * by the processor's own `issued_at` rather than by when we recorded it — a
 * retried webhook can arrive late, and ordering by our clock would put a
 * recovered invoice in the wrong place in the customer's history.
 */
export async function listInvoices(orgId: OrgId, limit: number): Promise<readonly InvoiceRow[]> {
  return withOrgScope(orgId, async (tx) =>
    tx
      .select({
        providerInvoiceId: schema.invoices.providerInvoiceId,
        number: schema.invoices.number,
        status: schema.invoices.status,
        amountDueCents: schema.invoices.amountDueCents,
        amountPaidCents: schema.invoices.amountPaidCents,
        currency: schema.invoices.currency,
        periodStart: schema.invoices.periodStart,
        periodEnd: schema.invoices.periodEnd,
        hostedInvoiceUrl: schema.invoices.hostedInvoiceUrl,
        invoicePdfUrl: schema.invoices.invoicePdfUrl,
        issuedAt: schema.invoices.issuedAt,
      })
      .from(schema.invoices)
      .where(eq(schema.invoices.orgId, orgId))
      .orderBy(desc(schema.invoices.issuedAt))
      .limit(limit),
  );
}

/**
 * Applies the processor's CURRENT subscription state without waiting for a
 * webhook.
 *
 * ## Why this exists at all
 *
 * The webhook is still the primary path and nothing here replaces it. But a
 * webhook is a message, and a message can be late, lost, or — against a
 * localhost API with no forwarding tunnel — never deliverable. The owner who
 * just completed checkout is looking at the page RIGHT NOW, and "trialing" on
 * a page they just paid on reads as "the purchase did nothing".
 *
 * Called when the browser returns from checkout. Safe to call at any other
 * time too: it reads the processor, then applies the same conditional write
 * the webhook handler applies, so a race between the two settles on the same
 * state rather than on whichever ran last.
 *
 * ## It cannot invent a subscription
 *
 * The only thing that can activate an org here is the PROCESSOR reporting a
 * live subscription for its customer id. No input from the browser reaches
 * this decision — the caller supplies an org, and the org's own stored
 * customer id is what gets looked up. A user replaying the success URL a
 * hundred times gets a hundred reads and no change.
 *
 * Against `PAYMENTS_PROVIDER=fake` this is a no-op, because the fake has no
 * subscriptions — deliberately, so a deployment with no processor cannot
 * activate orgs that never paid.
 */
export async function reconcileSubscription(
  deps: BillingDeps,
  orgId: OrgId,
): Promise<{ readonly reconciled: boolean; readonly planId: string | null }> {
  const customerId = await withOrgScope(orgId, async (tx) => {
    const rows = await tx
      .select({ customerId: schema.orgs.stripeCustomerId })
      .from(schema.orgs)
      .where(eq(schema.orgs.id, orgId))
      .limit(1);
    return rows[0]?.customerId ?? null;
  });

  /* No customer means no checkout was ever started for this org. Not an
     error — an owner can land on the billing page having done nothing. */
  if (customerId === null) return { reconciled: false, planId: null };

  const subscription = await deps.payments.getActiveSubscription(customerId);
  if (subscription === null) return { reconciled: false, planId: null };

  const planId = await withOrgScope(orgId, async (tx) => {
    /* The same price -> plan resolution the webhook handler does, over EVERY
       price row including retired ones (§3.2's grandfathering). */
    const priceRows =
      subscription.priceId === undefined
        ? []
        : await tx
            .select({ planId: schema.planPrices.planId })
            .from(schema.planPrices)
            .where(eq(schema.planPrices.stripePriceId, subscription.priceId))
            .limit(1);

    const currentRows = await tx
      .select({ planId: schema.orgs.planId })
      .from(schema.orgs)
      .where(eq(schema.orgs.id, orgId))
      .limit(1);

    const resolved = priceRows[0]?.planId ?? currentRows[0]?.planId ?? null;

    await tx
      .update(schema.orgs)
      .set({
        billingStatus: 'active',
        planId: resolved,
        stripeSubscriptionId: subscription.subscriptionId,
        billingGraceEndsAt: null,
        /* The period the processor just told us about. Reading it and not
           storing it was the whole reason the billing page could not say when
           anything renews, and why the Cancel control — gated on a renewal
           existing — never appeared for a genuinely subscribed org. */
        currentPeriodEnd: subscription.currentPeriodEnd ?? null,
        /* Synced from the processor rather than left alone, because this app
           links customers to its hosted portal: a cancellation performed there
           touched none of our routes, and reconcile is where it becomes
           visible. Synced in BOTH directions for the same reason — somebody
           who resumed over there must not keep seeing "ends 13 Sep" here. */
        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
        currentPriceCents: subscription.amountCents ?? null,
        currentPriceInterval: subscription.interval ?? null,
      })
      .where(eq(schema.orgs.id, orgId));

    /* Guardrail 11. The same event the WEBHOOK emits for the same transition
       — reconciliation is the identical fact arriving by a different route,
       and a second event kind would make every consumer handle both. */
    await outboxWriter.append(tx, [
      createEvent(
        subscriptionActivated,
        {
          orgId,
          planId: resolved ?? '',
          stripeSubscriptionId: subscription.subscriptionId,
        },
        { orgId, actorId: null, requestId: unsafeAsId<'RequestId'>(newId<'RequestId'>()) },
      ),
    ]);

    return resolved;
  });

  /* The resolver caches per org; a customer who just paid must not wait out a
     TTL to see what they bought. */
  invalidateEntitlements(orgId);

  return { reconciled: true, planId };
}

/**
 * Moves an existing subscription to a different plan.
 *
 * ## Upgrade now, downgrade at period end
 *
 * The direction is decided by PRICE, not by anything the caller says — a
 * client cannot ask for "treat this as an upgrade" and get features early.
 *
 *   - Costs MORE: applied immediately. They asked for more, the processor
 *     charges the difference now, and `plan_id` moves at once.
 *   - Costs the SAME or LESS: the processor's price changes with no
 *     proration (so the next invoice is the new amount), and `plan_id` is
 *     PARKED in `pending_plan_id` until the period they already paid for
 *     runs out. Taking features away mid-period from someone who paid for
 *     them is a refund conversation, not a plan change.
 *
 * The parked change is applied by the billing sweep when
 * `pending_plan_effective_at` passes.
 */
export async function changePlan(
  deps: BillingDeps,
  orgId: OrgId,
  input: { readonly planId: string; readonly interval: 'month' | 'year' },
): Promise<{ readonly effective: 'now' | 'period_end'; readonly effectiveAt: Date | null }> {
  const state = await withOrgScope(orgId, async (tx) => {
    const orgRows = await tx
      .select({
        subscriptionId: schema.orgs.stripeSubscriptionId,
        planId: schema.orgs.planId,
        currentPeriodEnd: schema.orgs.currentPeriodEnd,
        currentPriceCents: schema.orgs.currentPriceCents,
      })
      .from(schema.orgs)
      .where(eq(schema.orgs.id, orgId))
      .limit(1);

    const priceRows = await tx
      .select({
        stripePriceId: schema.planPrices.stripePriceId,
        amountCents: schema.planPrices.amountCents,
        isActive: schema.plans.isActive,
      })
      .from(schema.planPrices)
      .innerJoin(schema.plans, eq(schema.plans.id, schema.planPrices.planId))
      .where(
        and(
          eq(schema.planPrices.planId, input.planId),
          eq(schema.planPrices.interval, input.interval),
          eq(schema.planPrices.isCurrent, true),
        ),
      )
      .limit(1);

    return { org: orgRows[0], price: priceRows[0] };
  });

  if (state.org?.subscriptionId == null) {
    throw errors.validation(
      { planId: 'This organization has no subscription to change. Start one with checkout.' },
      'No subscription to change.',
    );
  }
  /* Narrowed into a local BEFORE the guard, so the check carries into the
     closure below — TypeScript drops narrowing on a property access the
     moment it is copied, which is how the first version of this compiled with
     `string | null` reaching a parameter typed `string`. */
  const stripePriceId = state.price?.stripePriceId ?? null;

  if (state.price === undefined || !state.price.isActive || stripePriceId === null) {
    throw errors.validation(
      { planId: `No current ${input.interval}ly price exists for plan "${input.planId}".` },
      'This plan is not available.',
    );
  }
  if (state.org.planId === input.planId) {
    throw errors.validation(
      { planId: 'This organization is already on that plan.' },
      'Already on this plan.',
    );
  }

  /* Hoisted after the guards above: TypeScript cannot carry the narrowing
     into the closure below, and re-asserting inside it would be a second
     place the invariant could be got wrong. */
  const price = state.price;
  const subscriptionId = state.org.subscriptionId;

  /* Direction from PRICE, never from the request. A client that could declare
     its own change an upgrade would get the features before paying for them. */
  const isUpgrade = price.amountCents > (state.org.currentPriceCents ?? 0);

  await deps.payments.changeSubscriptionPrice({
    subscriptionId,
    priceId: stripePriceId,
    prorate: isUpgrade,
  });

  /* No period end recorded (a subscription we have never reconciled) falls
     back to applying now — better to give the plan than to park a change with
     no date, which the CHECK constraint would refuse anyway. */
  const effectiveAt = isUpgrade ? null : (state.org.currentPeriodEnd ?? null);

  await withOrgScope(orgId, async (tx) => {
    await tx
      .update(schema.orgs)
      .set(
        effectiveAt === null
          ? {
              planId: input.planId,
              currentPriceCents: price.amountCents,
              currentPriceInterval: input.interval,
              pendingPlanId: null,
              pendingPlanEffectiveAt: null,
            }
          : { pendingPlanId: input.planId, pendingPlanEffectiveAt: effectiveAt },
      )
      .where(eq(schema.orgs.id, orgId));

    await outboxWriter.append(tx, [
      createEvent(
        planChanged,
        {
          orgId,
          from: state.org?.planId ?? null,
          to: input.planId,
          effective: effectiveAt === null ? 'now' : 'period_end',
          effectiveAt: effectiveAt?.toISOString() ?? null,
        },
        { orgId, actorId: null, requestId: unsafeAsId<'RequestId'>(newId<'RequestId'>()) },
      ),
    ]);
  });

  invalidateEntitlements(orgId);

  /* A plan change is the owner's own action, so this is confirmation rather
     than warning — but a DOWNGRADE that lands weeks later is exactly the kind
     of thing someone forgets agreeing to, and the mail is the record. */
  if (deps.mail !== undefined) {
    void sendBillingMail(deps.mail, orgId, 'plan_changed', {
      planName: input.planId,
      deadline: effectiveAt,
    });
  }

  return {
    effective: effectiveAt === null ? 'now' : 'period_end',
    effectiveAt,
  };
}

/**
 * Cancels at the end of the paid period.
 *
 * The processor stops renewing; the customer keeps everything until the
 * period they bought runs out. What happens AFTER that is the trial-to-Free
 * decision — they land on the default plan rather than being locked out.
 */
export async function cancelPlan(
  deps: BillingDeps,
  orgId: OrgId,
): Promise<{ readonly endsAt: Date | null }> {
  const org = await withOrgScope(orgId, async (tx) => {
    const rows = await tx
      .select({
        subscriptionId: schema.orgs.stripeSubscriptionId,
        currentPeriodEnd: schema.orgs.currentPeriodEnd,
      })
      .from(schema.orgs)
      .where(eq(schema.orgs.id, orgId))
      .limit(1);
    return rows[0];
  });

  if (org?.subscriptionId == null) {
    throw errors.validation(
      { subscription: 'This organization has no subscription to cancel.' },
      'Nothing to cancel.',
    );
  }

  await deps.payments.cancelSubscription(org.subscriptionId);

  /* Deliberately NOT writing billing_status here. The subscription is still
     live until the period ends, and the processor's own
     `subscription_canceled` webhook is what moves the state when it actually
     does — writing it now would lock out a customer who has paid through the
     end of the month.

     What this DOES write is the schedule (migration 0069). The original
     version stopped at the paragraph above, as though "do not write the
     status" meant "write nothing", and the consequence was a button that
     returned 200 and changed nothing anybody could see: `getOverview` still
     computed `renews`, the page still said "Renews 13 Sep", and it still
     offered the Cancel control that had just been used. The processor knew;
     this database did not. */
  await withOrgScope(orgId, async (tx) => {
    await tx.update(schema.orgs).set({ cancelAtPeriodEnd: true }).where(eq(schema.orgs.id, orgId));

    await outboxWriter.append(tx, [
      createEvent(
        subscriptionCancelScheduled,
        {
          orgId,
          scheduled: true,
          endsAt: org.currentPeriodEnd?.toISOString() ?? null,
        },
        { orgId, actorId: null, requestId: unsafeAsId<'RequestId'>(newId<'RequestId'>()) },
      ),
    ]);
  });

  return { endsAt: org.currentPeriodEnd ?? null };
}

/** Clears a pending cancellation, so the subscription renews as normal. */
export async function resumePlan(deps: BillingDeps, orgId: OrgId): Promise<void> {
  const org = await withOrgScope(orgId, async (tx) => {
    const rows = await tx
      .select({
        subscriptionId: schema.orgs.stripeSubscriptionId,
        currentPeriodEnd: schema.orgs.currentPeriodEnd,
      })
      .from(schema.orgs)
      .where(eq(schema.orgs.id, orgId))
      .limit(1);
    return rows[0];
  });

  if (org?.subscriptionId == null) {
    throw errors.validation(
      { subscription: 'This organization has no subscription to resume.' },
      'Nothing to resume.',
    );
  }

  /* Processor first, our row second — the same ordering `cancelPlan` uses and
     the plan catalog uses for products. If the processor refuses, we have
     written nothing and the page still correctly says the subscription is
     ending; the reverse would show "renews" for a subscription that is still
     scheduled to stop. */
  await deps.payments.resumeSubscription(org.subscriptionId);

  await withOrgScope(orgId, async (tx) => {
    await tx.update(schema.orgs).set({ cancelAtPeriodEnd: false }).where(eq(schema.orgs.id, orgId));

    await outboxWriter.append(tx, [
      createEvent(
        subscriptionCancelScheduled,
        {
          orgId,
          scheduled: false,
          endsAt: org.currentPeriodEnd?.toISOString() ?? null,
        },
        { orgId, actorId: null, requestId: unsafeAsId<'RequestId'>(newId<'RequestId'>()) },
      ),
    ]);
  });
}

export interface CreateCheckoutSessionInput {
  readonly planId: string;
  readonly interval: 'month' | 'year';
}

/**
 * Starts a checkout for one plan at one interval.
 *
 * ## The price comes from the CATALOG, not from configuration
 *
 * Until Phase 12 Wave 4 this resolved through `deps.planPriceIds`, a map built
 * at boot from `BILLING_STRIPE_PRICE_ID_PRO` — one env var, one hardcoded
 * `'pro'` literal, and a redeploy to change either. That variable is gone: the
 * operator console writes `billing.plan_prices` and this reads it, so a plan
 * created in the console is immediately purchasable and a repriced plan takes
 * effect on the next checkout with nothing restarted.
 *
 * `is_current` is what makes grandfathering work here rather than merely in
 * the console: a retired price row still exists and still bills every
 * subscription already on it, and this query cannot select one — so a new
 * customer can only ever check out against today's price.
 */
export async function createCheckoutSession(
  deps: BillingDeps,
  orgId: OrgId,
  actor: { readonly userId: UserId; readonly email: string },
  input: CreateCheckoutSessionInput,
): Promise<{ readonly url: string }> {
  /**
   * Checkout STARTS a subscription. It does not switch one.
   *
   * Stripe Checkout in `mode: 'subscription'` creates a NEW subscription
   * every time, so an org that already has one would end up paying for both —
   * and `identity.orgs.stripe_subscription_id` holds a single value, so the
   * first would silently stop being tracked. A customer double-charged by a
   * button labelled "Choose".
   *
   * Refused here rather than defended against in the UI: a stale tab, a
   * double-click, or a scripted client all reach this function, and only this
   * function can see the org's current state. Changing an existing
   * subscription is `changeSubscriptionPlan` — a different Stripe operation
   * (`subscriptions.update`), with proration, which is why it cannot be the
   * same call site.
   */
  const existingSubscription = await withOrgScope(orgId, async (tx) => {
    const rows = await tx
      .select({ subscriptionId: schema.orgs.stripeSubscriptionId })
      .from(schema.orgs)
      .where(eq(schema.orgs.id, orgId))
      .limit(1);
    return rows[0]?.subscriptionId ?? null;
  });

  if (existingSubscription !== null) {
    throw errors.validation(
      {
        planId:
          'This organization already has a subscription. Switching plans updates the existing ' +
          'one rather than starting a second — use the change-plan action, not checkout.',
      },
      'You already have a subscription.',
    );
  }

  const priceId = await withOrgScope(orgId, async (tx) => {
    const rows = await tx
      .select({
        stripePriceId: schema.planPrices.stripePriceId,
        isActive: schema.plans.isActive,
      })
      .from(schema.planPrices)
      .innerJoin(schema.plans, eq(schema.plans.id, schema.planPrices.planId))
      .where(
        and(
          eq(schema.planPrices.planId, input.planId),
          eq(schema.planPrices.interval, input.interval),
          eq(schema.planPrices.isCurrent, true),
        ),
      )
      .limit(1);

    const row = rows[0];
    /* A retired plan is refused here as well as hidden from the picker: the
       picker is a UI, and an owner with a stale tab or a scripted client must
       not be able to subscribe to a tier that is no longer sold. */
    if (!row?.isActive) return null;
    return row.stripePriceId;
  });

  /* `null` covers all three refusals — no such plan, no current price for the
     interval, and a retired plan — because the query above collapses them to
     one answer deliberately: which of the three it was is useful to the
     OPERATOR (who reads the console) and not to a caller, who gets the same
     "pick another plan" either way. `stripePriceId` is itself nullable, so a
     catalog row written before its provider call returned lands here too. */
  if (priceId === null) {
    throw errors.validation(
      {
        planId:
          `No current ${input.interval}ly price exists for plan "${input.planId}". ` +
          'Set one in the platform console, or choose a different plan.',
      },
      'This plan is not available.',
    );
  }

  const customerId = await ensureCustomerId(deps, orgId, actor.email);

  return deps.payments.createCheckoutSession({
    customerId,
    priceId,
    // The Billing section lives on the ordinary org settings page
    // (apps/web/src/features/admin/settings-page.tsx), not a route of its
    // own — matching where this redirects back to.
    successUrl: `${deps.webOrigin}/settings?checkout=success`,
    cancelUrl: `${deps.webOrigin}/settings?checkout=canceled`,
  });
}

export async function createPortalSession(
  deps: BillingDeps,
  orgId: OrgId,
  actor: { readonly userId: UserId; readonly email: string },
): Promise<{ readonly url: string }> {
  const customerId = await ensureCustomerId(deps, orgId, actor.email);

  return deps.payments.createPortalSession({
    customerId,
    returnUrl: `${deps.webOrigin}/settings`,
  });
}
