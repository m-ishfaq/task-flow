import { z } from 'zod';
import type { EventBus } from '@taskflow/events';
import { OrgIdSchema, UserIdSchema } from '@taskflow/contracts';
import { isPlatformOperator } from './operator.js';
import { FLAG_NAMES, type FlagName } from '@taskflow/feature-flags';
import { platformRoute, router, selfRoute } from '../trpc/builder.js';
import type { SubaccountDeps } from '../telephony/subaccount.service.js';
import * as directory from './org-directory.service.js';
import * as users from './user-directory.service.js';
import * as flags from './flags.service.js';
import * as billing from './billing-directory.service.js';
import * as operations from './operations.js';
import * as plans from './plan-catalog.service.js';
import * as detail from './org-detail.service.js';
import { readOperatorAudit, recordOperatorAction } from './audit.js';
import type { PaymentProvider } from '@taskflow/contracts';

/**
 * Platform-admin routes (Phase 12 Wave 1, ai/phase-12-admin.md §3.6).
 *
 * Every route except ONE is `platformRoute`: authenticated, step-up
 * unconditionally (cross-tenant by definition, §3.2), and checked against
 * `isPlatformOperator` — never against an org membership, because there is no
 * org. A non-operator reaching any of them gets the ordinary FORBIDDEN, not a
 * disguised 404.
 *
 * The one exception is `self.check`, and §3.2's correction is why: it exists
 * so the account menu can decide whether to render a link to /platform-admin,
 * which means EVERY logged-in user calls it on every page load just to hear
 * "no". Routing it through `platformRoute` would force every ordinary member
 * through a step-up re-authentication for that. It uses `selfRoute` instead —
 * authenticated, no permission, no step-up — and its answer (`{ isOperator }`)
 * is not sensitive on its own.
 */
export interface PlatformAdminRouterDeps {
  readonly events: EventBus;
  /**
   * The carrier subaccount sync for §9 — present only when a carrier is
   * configured, so `suspendOrg`/`reactivateOrg` freeze or unfreeze the
   * org's Twilio subaccount alongside the org-status write. See
   * `org-directory.service.ts`'s `syncSubaccountStatus`.
   */
  readonly subaccounts?: SubaccountDeps;
  /**
   * The payment processor, for the plan catalog (Phase 12 Wave 4).
   *
   * REQUIRED, unlike `subaccounts` — `PAYMENTS_PROVIDER` defaults to `fake`
   * rather than to an absent credential, so every instance has one and the
   * Plans tab works end to end with no Stripe account. The same reasoning
   * `buildBillingDeps` gives for never returning undefined.
   */
  readonly payments: PaymentProvider;
}

const ListInput = z
  .object({
    cursor: z.string().nullable().default(null),
    limit: z.number().int().min(1).max(100).default(25),
  })
  .strict();

const OrgRow = z
  .object({
    orgId: z.string(),
    name: z.string(),
    slug: z.string(),
    status: z.string(),
    createdAt: z.date(),
    memberCount: z.number().int().nonnegative(),
    /* Wave 4: the three questions the directory could not answer without
       cross-referencing the Billing tab — which plan, are they paying, and
       who is there to contact. */
    planId: z.string().nullable(),
    billingStatus: z.string(),
    trialEndsAt: z.date().nullable(),
    billingGraceEndsAt: z.date().nullable(),
    ownerEmail: z.string().nullable(),
    ownerName: z.string().nullable(),
  })
  .strict();

const UserRow = z
  .object({
    userId: z.string(),
    email: z.string(),
    /* From people.profiles, and nullable because a profile row is lazy —
       see user-directory.service.ts's own note on why not
       identity.users.display_name. */
    name: z.string().nullable(),
    emailVerifiedAt: z.date().nullable(),
    status: z.string(),
    orgCount: z.number().int().nonnegative(),
    createdAt: z.date(),
  })
  .strict();

/** Mirrors `platform.operational_events`' own CHECK constraint (migration 0061). */
const OperationalEventKind = z.enum(['mail', 'billing_webhook', 'billing_sweep']);

const OperationsListInput = z
  .object({
    cursor: z.string().nullable().default(null),
    limit: z.number().int().min(1).max(100).default(25),
    /** Null means every kind — the console's default view. */
    kind: OperationalEventKind.nullable().default(null),
  })
  .strict();

const OperationalEventRow = z
  .object({
    id: z.string(),
    kind: z.string(),
    outcome: z.string(),
    target: z.string().nullable(),
    detail: z.unknown(),
    occurredAt: z.date(),
  })
  .strict();

const FlagRow = z
  .object({
    flagName: z.string(),
    description: z.string(),
    phase: z.number().int(),
    perOrg: z.boolean(),
    defaultValue: z.boolean(),
    value: z.boolean(),
    source: z.enum(['override', 'default']),
    overrideSetAt: z.date().nullable(),
  })
  .strict();

/**
 * A plan id is a slug the operator chooses, and it is written into
 * `identity.orgs.plan_id` — so it is validated here against exactly the CHECK
 * constraint migration 0062 carries, rather than left to the database to
 * refuse with a constraint-violation 500. The two must stay in step; the
 * migration is the one that actually enforces it.
 */
const PlanIdSchema = z
  .string()
  .regex(
    /^[a-z][a-z0-9_-]{1,30}$/,
    'Lowercase letters, digits, hyphen and underscore; 2-31 chars.',
  );

/**
 * The ceilings, shared by create (required, so a new plan states every bound
 * deliberately) and update (each optional, so a patch touches only what it
 * names).
 *
 * `null` is UNLIMITED and `0` is none-at-all — two different states, both
 * real, and the reason these are nullable rather than defaulted to a number.
 */
const PlanLimitFields = {
  telephonyCapCents: z.number().int().nonnegative().nullable().default(null),
  automationRunsPerHour: z.number().int().nonnegative().nullable().default(null),
  turnIssuancePerDay: z.number().int().nonnegative().nullable().default(null),
  telephonyIncludedCents: z.number().int().nonnegative().default(0),
  telephonyMarkupPct: z.number().int().min(0).max(1000).default(0),
} as const;

const PlanPriceRow = z
  .object({
    id: z.string(),
    interval: z.enum(['month', 'year']),
    amountCents: z.number().int().nonnegative(),
    currency: z.string(),
    stripePriceId: z.string().nullable(),
    stripePriceUrl: z.string().nullable(),
    isCurrent: z.boolean(),
    archivedAt: z.date().nullable(),
    createdAt: z.date(),
  })
  .strict();

/** The drill-down's payload. See `org-detail.service.ts` for what each read costs. */
const OrgDetailRow = z
  .object({
    orgId: z.string(),
    name: z.string(),
    slug: z.string(),
    status: z.string(),
    createdAt: z.date(),

    planId: z.string().nullable(),
    planName: z.string().nullable(),
    billingStatus: z.string(),
    trialEndsAt: z.date().nullable(),
    billingGraceEndsAt: z.date().nullable(),
    stripeCustomerId: z.string().nullable(),
    stripeSubscriptionId: z.string().nullable(),

    override: z
      .object({
        featuresAdd: z.array(z.string()).readonly(),
        featuresRemove: z.array(z.string()).readonly(),
        reason: z.string(),
        expiresAt: z.date().nullable(),
        setAt: z.date(),
      })
      .strict()
      .nullable(),

    features: z
      .array(
        z
          .object({
            flagName: z.string(),
            description: z.string(),
            enabled: z.boolean(),
            /* The provenance that makes an override reviewable — see
               `OrgFeatureRow.source`'s own comment. */
            source: z.enum(['plan', 'override', 'default']),
          })
          .strict(),
      )
      .readonly(),

    limits: z
      .object({
        telephonyCapCents: z.number().int().nullable(),
        automationRunsPerHour: z.number().int().nullable(),
        turnIssuancePerDay: z.number().int().nullable(),
      })
      .strict(),

    telephonySpendCents: z.number().int().nonnegative(),

    members: z
      .array(
        z
          .object({
            userId: z.string(),
            email: z.string(),
            name: z.string().nullable(),
            role: z.string(),
            status: z.string(),
            joinedAt: z.date(),
          })
          .strict(),
      )
      .readonly(),
    memberCount: z.number().int().nonnegative(),

    invoices: z
      .array(
        z
          .object({
            providerInvoiceId: z.string(),
            number: z.string().nullable(),
            status: z.string(),
            amountDueCents: z.number().int().nonnegative(),
            currency: z.string(),
            hostedInvoiceUrl: z.string().nullable(),
            issuedAt: z.date(),
          })
          .strict(),
      )
      .readonly(),
  })
  .strict();

const PlanRow = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    sortOrder: z.number().int(),
    isActive: z.boolean(),
    isDefault: z.boolean(),
    stripeProductId: z.string().nullable(),
    stripeProductUrl: z.string().nullable(),
    features: z.array(z.string()).readonly(),
    currentPrices: z.array(PlanPriceRow).readonly(),
    orgCount: z.number().int().nonnegative(),
    telephonyCapCents: z.number().int().nullable(),
    automationRunsPerHour: z.number().int().nullable(),
    turnIssuancePerDay: z.number().int().nullable(),
    telephonyIncludedCents: z.number().int(),
    telephonyMarkupPct: z.number().int(),
    updatedAt: z.date(),
  })
  .strict();

export function createPlatformAdminRouter(deps: PlatformAdminRouterDeps) {
  const operatorOf = (ctx: {
    principal: { userId: string };
    requestId: string;
  }): directory.PlatformOperator => ({
    userId: ctx.principal.userId as directory.PlatformOperator['userId'],
    requestId: ctx.requestId as directory.PlatformOperator['requestId'],
  });

  /* The catalog service takes the processor alongside the bus, because a plan
     is defined in two places at once and neither is authoritative alone. */
  const catalogDeps = (): plans.PlanCatalogDeps => ({
    events: deps.events,
    payments: deps.payments,
  });

  return router({
    self: router({
      check: selfRoute({
        selfReason:
          'Tells the account menu whether to render a link to /platform-admin. Answers for every logged-in user, operator or not, with no step-up — §3.2.',
      })
        .output(z.object({ isOperator: z.boolean() }).strict())
        .query(async ({ ctx }) => ({ isOperator: await isPlatformOperator(ctx.principal.userId) })),
    }),

    orgs: router({
      list: platformRoute({
        platformReason:
          'The org directory — cross-tenant by definition; no org permission can describe it.',
      })
        .input(ListInput)
        .output(
          z
            .object({ orgs: z.array(OrgRow).readonly(), nextCursor: z.string().nullable() })
            .strict(),
        )
        .query(({ input, ctx }) => directory.listOrgs(operatorOf(ctx), input)),

      /**
       * One org, in full — the drill-down behind a clickable name (§5).
       *
       * Its own route rather than a wider `list`, because this is six reads
       * and an entitlement resolution: fine for one org, ruinous multiplied
       * by a page of a hundred.
       */
      detail: platformRoute({
        platformReason:
          "One org's full record, including another tenant's members and billing — cross-tenant by definition.",
      })
        .input(z.object({ orgId: OrgIdSchema }).strict())
        .output(OrgDetailRow)
        .query(({ input, ctx }) => detail.getOrgDetail(operatorOf(ctx), input.orgId)),

      /** What operators have done to this org, from the global chain. */
      history: platformRoute({
        platformReason:
          'The operator chain filtered to one org — the accountability record of this tier itself.',
      })
        .input(
          z
            .object({ orgId: OrgIdSchema, limit: z.number().int().min(1).max(100).default(25) })
            .strict(),
        )
        .output(
          z
            .array(z.object({ action: z.string(), at: z.date(), by: z.string() }).strict())
            .readonly(),
        )
        .query(({ input, ctx }) =>
          detail.getOrgOperatorHistory(operatorOf(ctx), input.orgId, input.limit),
        ),

      suspend: platformRoute({
        platformReason:
          'Suspending an org is a cross-tenant state change on identity.orgs — no org-scoped permission can authorize it.',
      })
        .input(z.object({ orgId: OrgIdSchema }).strict())
        .output(z.object({ orgId: z.string(), status: z.literal('suspended') }).strict())
        .mutation(({ input, ctx }) => directory.suspendOrg(deps, operatorOf(ctx), input.orgId)),

      reactivate: platformRoute({
        platformReason:
          'Reversing a suspension is the same cross-tenant state change, for the same reason.',
      })
        .input(z.object({ orgId: OrgIdSchema }).strict())
        .output(z.object({ orgId: z.string(), status: z.literal('active') }).strict())
        .mutation(({ input, ctx }) => directory.reactivateOrg(deps, operatorOf(ctx), input.orgId)),

      /* Phase 12 Wave 2 §3.5 — org deletion, the one operator action with no
         undo. `platformRoute` already implies step-up; the two gates are the
         org already being suspended and the operator typing the slug, both
         enforced in the service. */
      delete: platformRoute({
        platformReason:
          'Deleting an org removes every tenant row it owns — cross-tenant and irreversible; no org-scoped permission can authorize it.',
      })
        .input(z.object({ orgId: OrgIdSchema, confirmSlug: z.string().min(1).max(100) }).strict())
        .output(z.object({ orgId: z.string(), slug: z.string() }).strict())
        .mutation(({ input, ctx }) =>
          directory.deleteOrg(deps, operatorOf(ctx), {
            orgId: input.orgId,
            confirmSlug: input.confirmSlug,
          }),
        ),
    }),

    users: router({
      list: platformRoute({
        platformReason:
          'The user directory — cross-tenant by definition; no org permission can describe it.',
      })
        .input(ListInput)
        .output(
          z
            .object({ users: z.array(UserRow).readonly(), nextCursor: z.string().nullable() })
            .strict(),
        )
        .query(({ input, ctx }) => users.listUsers(operatorOf(ctx), input)),

      /* Wave 1 shipped this sub-router read-only (§7 decision 5); Wave 2 §3.1
         takes that deferral back up. An account is not an org, so these take a
         bare UserIdSchema and write no tenant audit chain — see
         user-directory.service.ts. */
      /**
       * One account, with WHICH orgs it belongs to and in what role.
       *
       * The directory could only say how MANY, which made the count the least
       * useful number on the page — an operator handling "why can't this
       * person see anything" needs the membership row and the org's own
       * status, not its cardinality.
       */
      detail: platformRoute({
        platformReason:
          "One account's memberships across every tenant — cross-tenant by definition; a person may belong to several orgs or none.",
      })
        .input(z.object({ userId: UserIdSchema }).strict())
        .output(
          z
            .object({
              userId: z.string(),
              email: z.string(),
              name: z.string().nullable(),
              status: z.string(),
              emailVerifiedAt: z.date().nullable(),
              createdAt: z.date(),
              memberships: z
                .array(
                  z
                    .object({
                      orgId: z.string(),
                      orgName: z.string(),
                      orgSlug: z.string(),
                      role: z.string(),
                      status: z.string(),
                      joinedAt: z.date(),
                      orgStatus: z.string(),
                      orgBillingStatus: z.string(),
                    })
                    .strict(),
                )
                .readonly(),
            })
            .strict(),
        )
        .query(({ input, ctx }) => detail.getUserDetail(operatorOf(ctx), input.userId)),

      suspend: platformRoute({
        platformReason:
          'Suspending an account is a change to identity.users, a table no org owns — no org-scoped permission can authorize it.',
      })
        .input(z.object({ userId: UserIdSchema }).strict())
        .output(z.object({ userId: z.string(), status: z.literal('suspended') }).strict())
        .mutation(({ input, ctx }) => users.suspendUser(deps, operatorOf(ctx), input.userId)),

      reactivate: platformRoute({
        platformReason:
          'Reversing an account suspension is the same cross-tenant state change, for the same reason.',
      })
        .input(z.object({ userId: UserIdSchema }).strict())
        .output(z.object({ userId: z.string(), status: z.literal('active') }).strict())
        .mutation(({ input, ctx }) => users.reactivateUser(deps, operatorOf(ctx), input.userId)),
    }),

    flags: router({
      /* No input, like tenancy.orgs.list — nothing to validate, and an empty
         `z.object({}).strict()` would make the client pass `{}` instead of the
         undefined every no-input route in this codebase passes. */
      list: platformRoute({
        platformReason: 'Flag overrides are global by design — no org permission applies.',
      })
        .output(z.array(FlagRow).readonly())
        .query(({ ctx }) => flags.listFlags(operatorOf(ctx))),

      set: platformRoute({
        platformReason:
          'A global flag override changes every tenant — the one capability the operator tier exists for.',
      })
        .input(
          z
            .object({
              flagName: z
                .string()
                .refine((value): value is FlagName => FLAG_NAMES.includes(value as FlagName), {
                  message: 'Unknown flag.',
                }),
              value: z.boolean().nullable(),
            })
            .strict(),
        )
        .output(z.object({ flagName: z.string(), value: z.boolean().nullable() }).strict())
        .mutation(({ input, ctx }) => flags.setFlag(deps, operatorOf(ctx), input)),
    }),

    /**
     * The plan catalog (Phase 12 Wave 4 §3.2). The tab that replaces opening
     * the Stripe dashboard.
     *
     * Every route is `platformRoute` for the plainest reason in this file:
     * a plan belongs to no tenant, so there is no org whose permission could
     * describe editing one. Note what is NOT here — no `delete`. Plans and
     * prices are archived, never removed; `identity.orgs.plan_id` references
     * a plan and every retired price is what a grandfathered subscriber is
     * still billed against, so no role holds DELETE on either table (0062).
     */
    plans: router({
      list: platformRoute({
        platformReason:
          'The plan catalog — global by definition; a plan belongs to no tenant, so no org permission can describe it.',
      })
        .output(z.array(PlanRow).readonly())
        .query(({ ctx }) => plans.listPlans(catalogDeps(), operatorOf(ctx))),

      /** Every price a plan has ever had — the grandfathering ledger (§3.2). */
      listPrices: platformRoute({
        platformReason: 'Price history for a global catalog entry; no org permission applies.',
      })
        .input(z.object({ planId: PlanIdSchema }).strict())
        .output(z.array(PlanPriceRow).readonly())
        .query(({ input, ctx }) => plans.listPrices(catalogDeps(), operatorOf(ctx), input.planId)),

      create: platformRoute({
        platformReason:
          'Creating a plan defines what every tenant may buy — the operator tier is the only one that can.',
      })
        .input(
          z
            .object({
              id: PlanIdSchema,
              name: z.string().min(1).max(80),
              description: z.string().max(500).nullable().default(null),
              sortOrder: z.number().int().min(0).max(1000).default(0),
              features: z.array(z.string()).max(64).default([]),
              /* False creates a plan with no processor product — the free
                 tier. Not inferable from `features` or from a zero price:
                 "this tier is never charged for" is a decision, and a plan
                 created without a product cannot grow one later (see
                 `CreatePlanInput.withProduct`). */
              withProduct: z.boolean().default(true),
              ...PlanLimitFields,
            })
            .strict(),
        )
        .output(PlanRow)
        .mutation(({ input, ctx }) =>
          plans.createPlan(catalogDeps(), operatorOf(ctx), {
            ...input,
            telephonyCapCents: input.telephonyCapCents,
          }),
        ),

      update: platformRoute({
        platformReason:
          "Changing a plan's feature set or ceilings changes what every tenant on it receives.",
      })
        .input(
          z
            .object({
              planId: PlanIdSchema,
              name: z.string().min(1).max(80).optional(),
              description: z.string().max(500).nullable().optional(),
              sortOrder: z.number().int().min(0).max(1000).optional(),
              features: z.array(z.string()).max(64).optional(),
              isActive: z.boolean().optional(),
              telephonyCapCents: z.number().int().nonnegative().nullable().optional(),
              automationRunsPerHour: z.number().int().nonnegative().nullable().optional(),
              turnIssuancePerDay: z.number().int().nonnegative().nullable().optional(),
              telephonyIncludedCents: z.number().int().nonnegative().optional(),
              telephonyMarkupPct: z.number().int().min(0).max(1000).optional(),
            })
            .strict(),
        )
        .output(PlanRow)
        .mutation(({ input, ctx }) => plans.updatePlan(catalogDeps(), operatorOf(ctx), input)),

      /**
       * Sets the current price at one interval, grandfathering the previous.
       *
       * Named `setPrice` rather than `updatePrice` because the processor's
       * prices are immutable: this creates a new one and retires the old, and
       * a name promising an update would describe something no implementation
       * can do (see `PaymentProvider`'s own note on the absent `updatePrice`).
       */
      setPrice: platformRoute({
        platformReason:
          'Repricing a plan changes what new customers are charged — global, and no org permission applies.',
      })
        .input(
          z
            .object({
              planId: PlanIdSchema,
              interval: z.enum(['month', 'year']),
              /* Minor units, integer. Never a float and never a formatted
                 string — nothing in this path does decimal arithmetic on
                 money. The ceiling is a typo guard: $1,000,000/month is far
                 more likely a misplaced decimal in a console field than a
                 real plan. */
              amountCents: z.number().int().min(0).max(100_000_000),
              currency: z
                .string()
                .regex(/^[a-z]{3}$/, 'Lowercase ISO 4217, e.g. "usd".')
                .default('usd'),
            })
            .strict(),
        )
        .output(PlanRow)
        .mutation(({ input, ctx }) => plans.setPrice(catalogDeps(), operatorOf(ctx), input)),

      archive: platformRoute({
        platformReason:
          'Retiring a plan removes it from sale for every tenant — global by definition.',
      })
        .input(z.object({ planId: PlanIdSchema }).strict())
        .output(PlanRow)
        .mutation(({ input, ctx }) =>
          plans.archivePlan(catalogDeps(), operatorOf(ctx), input.planId),
        ),

      /**
       * Moves ONE org onto a plan.
       *
       * Lives under `plans.*` rather than `orgs.*` because it is a catalog
       * question — "what is this tenant entitled to" — and the answer is a
       * plan id that only this sub-router knows how to validate. It writes
       * `plan_id` and nothing else: not `billing_status`, not the
       * subscription. See the service's own header on why touching those
       * would rebuild the collision migration 0059 exists to prevent.
       */
      setOrgPlan: platformRoute({
        platformReason:
          "Changing one org's plan is a cross-tenant write on identity.orgs — no org-scoped permission can authorize it.",
      })
        .input(
          z
            .object({
              orgId: OrgIdSchema,
              planId: PlanIdSchema,
              /* Required, like an entitlement override's: moving a tenant off
                 what they signed up for is a support decision, and a decision
                 with no recorded reason is one nobody can review later. */
              reason: z.string().min(1).max(500),
            })
            .strict(),
        )
        .output(
          z
            .object({
              orgId: z.string(),
              planId: z.string(),
              previousPlanId: z.string().nullable(),
            })
            .strict(),
        )
        .mutation(({ input, ctx }) => plans.setOrgPlan(catalogDeps(), operatorOf(ctx), input)),

      /**
       * Sets or clears one org's entitlement override — tier 1 of four.
       *
       * Outranks the plan, which is why every guard is on it: a required
       * reason that lands in the hash-chained operator log, an optional
       * expiry so a temporary grant does not become permanent by being
       * forgotten, and a clear path (send no deltas and no limits) so
       * "no override" is one state rather than two.
       */
      setOrgEntitlements: platformRoute({
        platformReason:
          "Overriding one org's entitlements outranks its plan — a cross-tenant capability no org-scoped permission can authorize.",
      })
        .input(
          z
            .object({
              orgId: OrgIdSchema,
              featuresAdd: z.array(z.string()).max(64).default([]),
              featuresRemove: z.array(z.string()).max(64).default([]),
              telephonyCapCents: z.number().int().nonnegative().nullable().default(null),
              automationRunsPerHour: z.number().int().nonnegative().nullable().default(null),
              turnIssuancePerDay: z.number().int().nonnegative().nullable().default(null),
              reason: z.string().min(1).max(500),
              /* A date, not a duration: "until 2026-09-01" survives being read
                 back six weeks later, where "30 days" only means something
                 relative to a moment nobody recorded. */
              expiresAt: z.date().nullable().default(null),
            })
            .strict(),
        )
        .output(z.object({ orgId: z.string(), cleared: z.boolean() }).strict())
        .mutation(({ input, ctx }) =>
          plans.setOrgEntitlements(catalogDeps(), operatorOf(ctx), input),
        ),

      /** Where an expiring trial lands (§3.6). Its own route, never a field on create. */
      setDefault: platformRoute({
        platformReason:
          'The default plan is where every expiring trial and canceled subscription lands.',
      })
        .input(z.object({ planId: PlanIdSchema }).strict())
        .output(PlanRow)
        .mutation(({ input, ctx }) =>
          plans.setDefaultPlan(catalogDeps(), operatorOf(ctx), input.planId),
        ),
    }),

    /**
     * The operator-facing billing view (Phase 12 Wave 3 §3.6). Deliberately
     * separate from `billing.*` (the owner-facing router) — see
     * `billing-directory.service.ts`'s own header on why the same word
     * names two different questions here.
     */
    billing: router({
      list: platformRoute({
        platformReason:
          "Every org's billing state — cross-tenant by definition; no org permission can describe it.",
      })
        .input(ListInput)
        .output(
          z
            .object({
              orgs: z
                .array(
                  z
                    .object({
                      orgId: z.string(),
                      name: z.string(),
                      slug: z.string(),
                      billingStatus: z.string(),
                      planId: z.string().nullable(),
                      trialEndsAt: z.date().nullable(),
                      billingGraceEndsAt: z.date().nullable(),
                      stripeCustomerId: z.string().nullable(),
                      planName: z.string().nullable(),
                      currentPeriodEnd: z.date().nullable(),
                      currentPriceCents: z.number().int().nullable(),
                      currentPriceInterval: z.string().nullable(),
                      pendingPlanId: z.string().nullable(),
                      pendingPlanEffectiveAt: z.date().nullable(),
                      lastInvoice: z
                        .object({
                          status: z.string(),
                          amountDueCents: z.number().int().nonnegative(),
                          currency: z.string(),
                          issuedAt: z.date(),
                          hostedInvoiceUrl: z.string().nullable(),
                        })
                        .strict()
                        .nullable(),
                    })
                    .strict(),
                )
                .readonly(),
              nextCursor: z.string().nullable(),
            })
            .strict(),
        )
        .query(({ input, ctx }) => billing.listBilling(operatorOf(ctx), input)),

      grantExtension: platformRoute({
        platformReason:
          'Extending a grace period is a cross-tenant write on identity.orgs — no org-scoped permission can authorize it.',
      })
        .input(
          z.object({ orgId: OrgIdSchema, extendByDays: z.number().int().min(1).max(90) }).strict(),
        )
        .output(z.object({ orgId: z.string(), billingGraceEndsAt: z.date() }).strict())
        .mutation(({ input, ctx }) => billing.grantExtension(deps, operatorOf(ctx), input)),
    }),

    /**
     * The operations dashboard (the "did a system action succeed or fail"
     * question `operations.ts`'s own header distinguishes from the operator
     * audit chain below). Read-only in this wave — no retry action yet.
     */
    operations: router({
      list: platformRoute({
        platformReason:
          'System-action outcomes across every process — mail delivery, billing webhooks, the billing sweep — global by definition; no org permission can describe it.',
      })
        .input(OperationsListInput)
        .output(
          z
            .object({
              events: z.array(OperationalEventRow).readonly(),
              nextCursor: z.string().nullable(),
            })
            .strict(),
        )
        .query(({ input, ctx }) => operations.listOperationalEvents(operatorOf(ctx), input)),
    }),

    audit: router({
      list: platformRoute({
        platformReason:
          'The operator chain — the accountability record of this tier itself; reading it is an operator action.',
      })
        .input(
          z
            .object({
              limit: z.number().int().min(1).max(200).default(50),
              before: z.string().regex(/^\d+$/).nullable().default(null),
            })
            .strict(),
        )
        .output(
          z
            .object({
              entries: z
                .array(
                  z
                    .object({
                      seq: z.string(),
                      operatorId: z.string(),
                      operatorEmail: z.string(),
                      action: z.string(),
                      target: z.unknown(),
                      occurredAt: z.date(),
                    })
                    .strict(),
                )
                .readonly(),
            })
            .strict(),
        )
        .query(async ({ input, ctx }) => {
          const operator = operatorOf(ctx);
          const entries = await readOperatorAudit(input);
          /* The read is itself an operator action, recorded like every other —
             the acceptance criterion is that EVERY platformAdmin.* call lands
             in the chain, including the one that reads it. */
          await recordOperatorAction(operator.userId, 'audit.list', null);
          return { entries };
        }),
    }),
  });
}
