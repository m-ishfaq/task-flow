import { z } from 'zod';
import { route, router } from '../trpc/builder.js';
import * as people from '../people/profile.service.js';
import * as billing from './org-billing.service.js';
import type { BillingDeps } from './deps.js';

/**
 * The owner-facing billing routes (Phase 12 Wave 3 §3.1, §5). `billing.*`,
 * deliberately not nested under `tenancy.orgs.*` — a visibly different
 * namespace from `platformAdmin.billing.*` is what keeps the two questions
 * ("what does MY org pay" vs. "show me every org's billing state") from
 * reading like the same feature with two doors into it.
 *
 * Every route is `route({ permission: 'org:billing' })` — Owner-only,
 * ORG_LEVEL, never satisfiable by a resource tuple (`packages/policy`'s own
 * comment on why `org:billing` lives in that set).
 */
export function createBillingRouter(deps: BillingDeps) {
  return router({
    status: route({ permission: 'org:billing' })
      .output(
        z.object({
          billingStatus: z.string(),
          planId: z.string().nullable(),
          trialEndsAt: z.date().nullable(),
          billingGraceEndsAt: z.date().nullable(),
        }),
      )
      .query(({ ctx }) => billing.getStatus(ctx.principal.org.orgId)),

    /**
     * The whole Billing page, in one read — plan, what it includes, usage
     * against the ceiling, and who can change any of it.
     *
     * Separate from `status` above rather than replacing it: `status` is four
     * columns on a hot path, this is six reads for one page.
     */
    overview: route({ permission: 'org:billing' })
      .output(
        z
          .object({
            billingStatus: z.string(),
            planId: z.string().nullable(),
            planName: z.string().nullable(),
            trialEndsAt: z.date().nullable(),
            billingGraceEndsAt: z.date().nullable(),
            features: z
              .array(z.object({ flagName: z.string(), description: z.string() }).strict())
              .readonly(),
            usage: z
              .object({
                telephonySpentCents: z.number().int().nonnegative(),
                telephonyCapCents: z.number().int().nullable(),
                telephonyIncludedCents: z.number().int().nonnegative(),
              })
              .strict(),
            billingContact: z
              .object({ email: z.string(), name: z.string().nullable() })
              .strict()
              .nullable(),
            deadline: z
              .object({
                kind: z.enum(['trial_ends', 'grace_ends', 'renews', 'cancels', 'plan_changes']),
                at: z.date(),
                planId: z.string().nullable(),
              })
              .strict()
              .nullable(),
            currentPriceCents: z.number().int().nullable(),
            cancelAtPeriodEnd: z.boolean(),
            hasSubscription: z.boolean(),
          })
          .strict(),
      )
      .query(({ ctx }) => billing.getOverview(ctx.principal.org.orgId)),

    /**
     * Recorded invoices, newest first.
     *
     * Served from OUR mirror (migration 0065) rather than the processor, so
     * the page works during a processor incident and the record survives a
     * processor swap. Every row carries `hostedInvoiceUrl` — the path back to
     * the authoritative document, because this table is a copy.
     */
    invoices: route({ permission: 'org:billing' })
      .input(z.object({ limit: z.number().int().min(1).max(100).default(24) }).strict())
      .output(
        z
          .array(
            z
              .object({
                providerInvoiceId: z.string(),
                number: z.string().nullable(),
                status: z.string(),
                amountDueCents: z.number().int().nonnegative(),
                amountPaidCents: z.number().int().nonnegative(),
                currency: z.string(),
                periodStart: z.date().nullable(),
                periodEnd: z.date().nullable(),
                hostedInvoiceUrl: z.string().nullable(),
                invoicePdfUrl: z.string().nullable(),
                issuedAt: z.date(),
              })
              .strict(),
          )
          .readonly(),
      )
      .query(({ input, ctx }) => billing.listInvoices(ctx.principal.org.orgId, input.limit)),

    /**
     * What this org can buy, from the catalog an operator maintains.
     *
     * Read as the ordinary application role — `taskflow_app` holds SELECT on
     * the two catalog tables and nothing else (migration 0062), so an owner
     * can see the price list and can never edit it.
     */
    listPlans: route({ permission: 'org:billing' })
      .output(
        z
          .array(
            z
              .object({
                id: z.string(),
                name: z.string(),
                description: z.string().nullable(),
                features: z.array(z.string()).readonly(),
                prices: z
                  .array(
                    z
                      .object({
                        interval: z.enum(['month', 'year']),
                        amountCents: z.number().int().nonnegative(),
                        currency: z.string(),
                      })
                      .strict(),
                  )
                  .readonly(),
              })
              .strict(),
          )
          .readonly(),
      )
      .query(({ ctx }) => billing.listPurchasablePlans(ctx.principal.org.orgId)),

    /* `planId` is a free string validated against the CATALOG rather than the
       `z.literal('pro')` it was until Wave 4 — a literal cannot express a
       plan list an operator edits at runtime, and the service refuses any id
       with no current price for the requested interval. */
    createCheckoutSession: route({ permission: 'org:billing' })
      .input(
        z
          .object({
            planId: z.string().min(1).max(31),
            interval: z.enum(['month', 'year']).default('month'),
          })
          .strict(),
      )
      .output(z.object({ url: z.string() }))
      .mutation(async ({ input, ctx }) => {
        const profile = await people.getProfile(ctx.principal.userId);
        return billing.createCheckoutSession(
          deps,
          ctx.principal.org.orgId,
          { userId: ctx.principal.userId, email: profile.email },
          input,
        );
      }),

    /**
     * Applies the processor's current subscription state, without waiting for
     * a webhook.
     *
     * Called by the browser when it returns from checkout. The webhook remains
     * the primary path — this exists because a webhook can be late, lost, or
     * (against a localhost API with no forwarding tunnel) never deliverable,
     * and the owner who just paid is looking at the page now.
     *
     * A mutation rather than a query because it writes, but it is idempotent:
     * the only thing that can activate an org is the PROCESSOR reporting a
     * live subscription for that org's own stored customer id. Nothing from
     * the browser reaches the decision, so replaying the success URL changes
     * nothing.
     */
    reconcile: route({ permission: 'org:billing' })
      .output(z.object({ reconciled: z.boolean(), planId: z.string().nullable() }).strict())
      .mutation(({ ctx }) => billing.reconcileSubscription(deps, ctx.principal.org.orgId)),

    /**
     * Moves an existing subscription to another plan.
     *
     * Separate from `createCheckoutSession` because they are different
     * processor operations: checkout STARTS a subscription (and would create
     * a second one), this repricies the existing one. The upgrade/downgrade
     * direction is decided server-side from the PRICE — a client cannot ask
     * to be treated as an upgrade and get features before paying.
     */
    changePlan: route({ permission: 'org:billing' })
      .input(
        z
          .object({
            planId: z.string().min(1).max(31),
            interval: z.enum(['month', 'year']).default('month'),
          })
          .strict(),
      )
      .output(
        z
          .object({
            effective: z.enum(['now', 'period_end']),
            effectiveAt: z.date().nullable(),
          })
          .strict(),
      )
      .mutation(({ input, ctx }) => billing.changePlan(deps, ctx.principal.org.orgId, input)),

    /** Cancels at the end of the paid period — never immediately. */
    cancelPlan: route({ permission: 'org:billing' })
      .output(z.object({ endsAt: z.date().nullable() }).strict())
      .mutation(({ ctx }) => billing.cancelPlan(deps, ctx.principal.org.orgId)),

    /** Clears a pending cancellation. */
    resumePlan: route({ permission: 'org:billing' })
      .output(z.object({ resumed: z.literal(true) }).strict())
      .mutation(async ({ ctx }) => {
        await billing.resumePlan(deps, ctx.principal.org.orgId);
        return { resumed: true as const };
      }),

    createPortalSession: route({ permission: 'org:billing' })
      .output(z.object({ url: z.string() }))
      .mutation(async ({ ctx }) => {
        const profile = await people.getProfile(ctx.principal.userId);
        return billing.createPortalSession(deps, ctx.principal.org.orgId, {
          userId: ctx.principal.userId,
          email: profile.email,
        });
      }),
  });
}
