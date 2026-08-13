import { defineSeedModule } from '../registry.js';
import { daysAfter, daysBefore } from '../support.js';
import { orgsModule } from './tenancy.orgs.js';
import { catalogModule } from './billing.catalog.js';

/**
 * What each org PAYS — the plan it is on, the state of its subscription, and
 * the invoices behind it (Phase 12 Waves 3–4).
 *
 * ## The gap this closes
 *
 * Nothing seeded billing at all. Every org came out `trialing` with
 * `plan_id = NULL`, which meant the entire billing surface — the plan picker,
 * the renewal line, the usage bar, invoice history, the operator console's
 * billing tab — rendered its empty state on a freshly seeded database. That is
 * the worst possible default for the one dataset meant to demonstrate the
 * product, and it also left every billing code path untested by the fixture
 * that exists to exercise them.
 *
 * ## Columns, not routes
 *
 * Unlike `billing.catalog`, this module writes rows directly, and the
 * distinction is the same one that file's header draws. A plan is half a
 * processor object, so it has to be created through the service. A
 * SUBSCRIPTION's seeded form is not: `checkoutCompleted` requires a real
 * hosted-checkout round trip that no script can perform, and the columns it
 * ultimately writes are exactly the ones below. Inventing a Stripe
 * subscription id here is honest for the same reason a fake price id is —
 * nothing dials it; the fake provider is what reads it back.
 *
 * The one caveat worth stating: against a LIVE processor these subscription
 * ids name nothing. `reconcileSubscription` will find no subscription and
 * report `{ reconciled: false }`, which is the correct answer for a customer
 * who never checked out. It will not corrupt anything.
 *
 * ## Every state, on purpose
 *
 * The states are declared per org in `OrgPlan.billing` rather than rolled,
 * because the interesting ones are exactly the ones a random draw almost never
 * produces: a subscription set to cancel at period end, an org in its past-due
 * grace window, a trial about to expire. Each is a screen with its own copy
 * and its own controls, and each was previously unreachable without editing
 * SQL by hand.
 */

/** Days of invoice history behind an active subscription. */
const INVOICE_MONTHS = 6;

export interface SubscriptionsOutput {
  readonly subscribed: number;
  readonly invoices: number;
}

export const subscriptionsModule = defineSeedModule({
  name: 'billing.subscriptions',
  requires: [orgsModule, catalogModule],
  /* `identity.orgs` belongs to `tenancy.orgs` — this module UPDATEs it and
     must not claim it for reset, or two modules would each try to clear the
     same table. `billing.invoices` is genuinely this module's own. */
  tables: ['billing.invoices'],

  async seed(ctx): Promise<SubscriptionsOutput> {
    const { orgs } = ctx.use(orgsModule);
    const { planIds } = ctx.use(catalogModule);

    if (planIds.length === 0) {
      ctx.log('billing.subscriptions: no plan catalog — skipped.');
      return { subscribed: 0, invoices: 0 };
    }

    const rng = ctx.rng.fork('billing.subscriptions');
    let subscribed = 0;
    let invoices = 0;

    for (const org of orgs) {
      const billing = org.plan.billing;
      if (billing === undefined) continue;

      if (!planIds.includes(billing.planId)) {
        throw new Error(
          `billing.subscriptions: org "${org.slug}" names plan "${billing.planId}", which the ` +
            `catalog does not have. Available: ${planIds.join(', ')}.`,
        );
      }

      /* A free org has a plan and no subscription — no customer, no period, no
         invoices. Writing a customer id for it would make `hasSubscription`
         true and put a Cancel button on a plan nobody is paying for. */
      const paid = billing.status !== 'free';

      const periodEnd = daysAfter(ctx.now, billing.renewsInDays ?? 20);
      const priceCents = billing.priceCents ?? null;

      await ctx.orgScope(org.id, () =>
        ctx.db.query(
          `UPDATE identity.orgs
              SET plan_id = $2,
                  billing_status = $3,
                  trial_ends_at = $4,
                  billing_grace_ends_at = $5,
                  stripe_customer_id = $6,
                  stripe_subscription_id = $7,
                  current_period_end = $8,
                  current_price_cents = $9,
                  current_price_interval = $10,
                  cancel_at_period_end = $11
            WHERE id = $1`,
          [
            org.id,
            billing.planId,
            /* `free` is not a billing_status the column knows — it is a PLAN.
               The org is `active`, on a plan that costs nothing, which is
               exactly the distinction Wave 4 drew when it stopped sending
               expired trials to `past_due`. */
            billing.status === 'free' ? 'active' : billing.status,
            billing.trialEndsInHours === undefined
              ? null
              : new Date(ctx.now.getTime() + billing.trialEndsInHours * 60 * 60 * 1000),
            billing.graceEndsInDays === undefined
              ? null
              : daysAfter(ctx.now, billing.graceEndsInDays),
            paid ? `cus_seed_${org.slug}` : null,
            paid ? `sub_seed_${org.slug}` : null,
            paid ? periodEnd : null,
            paid ? priceCents : null,
            paid ? 'month' : null,
            billing.cancelAtPeriodEnd ?? false,
          ],
        ),
      );

      if (!paid) continue;
      subscribed += 1;

      /* Invoice history, oldest first. A billing page with one invoice looks
         like a bug; six months of them looks like a customer, and gives the
         list something to scroll and the operator console's billing tab
         something to show. */
      for (let month = INVOICE_MONTHS; month >= 1; month -= 1) {
        const issuedAt = daysBefore(periodEnd, 30 * month);
        /* Nothing before the org existed. An invoice predating its own tenant
           is the kind of detail that only shows up in a screenshot. */
        if (issuedAt.getTime() < org.createdAt.getTime()) continue;

        /* The most recent invoice on a past_due org is the one that FAILED —
           that is what put it in grace, and a history where every invoice is
           paid contradicts the status shown above it. */
        const isLatest = month === 1;
        const status = isLatest && billing.status === 'past_due' ? 'open' : 'paid';
        const amount = priceCents ?? 0;

        await ctx.orgScope(org.id, () =>
          ctx.db.query(
            `INSERT INTO billing.invoices
               (provider_invoice_id, org_id, number, status, amount_due_cents,
                amount_paid_cents, currency, period_start, period_end,
                hosted_invoice_url, invoice_pdf_url, issued_at)
             VALUES ($1, $2, $3, $4, $5, $6, 'usd', $7, $8, $9, $10, $11)
             ON CONFLICT (provider_invoice_id) DO NOTHING`,
            [
              `in_seed_${org.slug}_${String(month)}`,
              org.id,
              `${org.slug.toUpperCase().slice(0, 4)}-${String(1000 + rng.int(1, 8999))}`,
              status,
              amount,
              status === 'paid' ? amount : 0,
              daysBefore(issuedAt, 30),
              issuedAt,
              `https://invoice.stripe.com/seed/${org.slug}/${String(month)}`,
              `https://invoice.stripe.com/seed/${org.slug}/${String(month)}.pdf`,
              issuedAt,
            ],
          ),
        );
        invoices += 1;
      }
    }

    ctx.log(
      `billing.subscriptions: ${String(subscribed)} subscription(s), ${String(invoices)} invoice(s)`,
    );
    return { subscribed, invoices };
  },
});
