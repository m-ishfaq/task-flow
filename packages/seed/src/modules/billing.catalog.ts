import { InMemoryEventBus } from '@taskflow/events';
import { unsafeAsId, type RequestId, type UserId } from '@taskflow/contracts';
import {
  createPlan,
  updatePlan,
  setPrice,
  listPlans,
} from '@taskflow/api/platform-admin/plan-catalog';
import { FLAG_NAMES } from '@taskflow/feature-flags';
import { defineSeedModule } from '../registry.js';
import { adminModule } from './platform.admin.js';

/**
 * The plan catalog — built by calling the OPERATOR CONSOLE'S OWN service
 * functions, not by inserting rows (Phase 12 Wave 4).
 *
 * ## Why the real flow rather than INSERTs
 *
 * Every other module in this package writes rows directly, and that is right
 * for them: a card is a row, and reproducing `createCard`'s transaction would
 * be duplicating logic to get the same bytes. A plan is not. A plan row is
 * only half of a plan — the other half is a Product and a Price at the
 * processor, and `billing.plan_prices.stripe_price_id` is the join between
 * them. Seeding the row alone produces a catalog that renders perfectly and
 * cannot be checked out against, which is precisely the "data that is a lie"
 * this package's own comments argue against for attachments and telephony.
 *
 * So this module calls `createPlan` and `setPrice`. Whatever an operator would
 * get by using the console, a seed run gets — including the ordering those
 * functions are careful about (product first, then our row; price created
 * before the old one is archived) and the feature-name validation against the
 * live registry.
 *
 * ## Which processor
 *
 * `ctx.payments`, built in `cli.ts`. Normally the in-memory fake, which is a
 * completely honest thing to seed against: a fake price id is only ever read
 * back by the same fake. Against a real Stripe key the CLI warns first,
 * because that run creates real objects in a real account.
 *
 * ## Idempotent by necessity, not by politeness
 *
 * `billing.plans` grants DELETE to nobody — not `taskflow_app`, not
 * `taskflow_platform_admin` — because `identity.orgs.plan_id` references it
 * and every historical price row is what a grandfathered subscriber is still
 * billed against (migration 0062). So the reset that precedes a seed run
 * CANNOT clear this table, and a second run necessarily meets the first run's
 * plans. Existing ids are skipped rather than recreated; without that, run two
 * fails on `createPlan`'s duplicate check and takes the whole seed with it.
 *
 * That also keeps the Stripe side sane: skipping the plan skips the product,
 * so re-seeding against a live key does not multiply Products.
 *
 * ## `--reseed-plans` is the deliberate exception to "existing ids are skipped"
 *
 * The skip above is right for an ORDINARY run: `pnpm seed` is invoked far
 * more often than the CATALOG literal changes, and a plain run must never
 * silently overwrite a price or feature list an operator set by hand in the
 * console. But that same default means a correction made to CATALOG never
 * reaches a database that already has the row — which is what made fixing
 * Pro's stray `analytics` grant (inherited from migration 0063, written
 * before this module existed) or the telephony caps below need a one-off
 * migration instead of just editing this file, the exact "why is this a
 * migration and not the seeder" question CLAUDE.md's own commit history
 * should not have to keep answering.
 *
 * `ctx.reseedPlans` (`--reseed-plans`, off by default) is that door: when
 * set, an EXISTING plan is also reconciled to the literal, through
 * `updatePlan` — the same function `PATCH /platformAdmin/plans` calls, so a
 * reconciliation gets the same feature-registry validation, audit-log entry
 * and domain event a console edit gets, never a raw write. Pricing is
 * unaffected by this flag because it was never guarded by it: `setPrice`
 * already runs unconditionally on every tier, every run (see below).
 *
 * ## No `tables` entry, deliberately
 *
 * For the same reason — nothing may delete these rows, so declaring them for
 * reset would ask `reset.ts` to run a DELETE the database refuses.
 */

/**
 * The tiers, in display order.
 *
 * A literal, like every other structural declaration in this package: a
 * catalog with plausible names and prices is what a marketing screenshot
 * needs, and a generated one produces "Plan 3 — $73/month".
 *
 * The limits are the interesting part and are NOT uniform. Free has a zero
 * telephony cap (spend nothing at all — a real, different state from
 * unlimited); the markup climbs down while the included allowance climbs up
 * faster as tiers rise, which is the shape a real usage-billing ladder has.
 *
 * `telephonyCapCents` is deliberately NOT scaled to price. It is real
 * carrier spend — paid to Twilio in near-real-time, independent
 * of whether the org ever pays the overage invoice for usage past
 * `telephonyIncludedCents` — so a cap sized as a multiple of the
 * subscription price means the platform's worst-case exposure on a single
 * bad signup (stolen card, chargeback, simple non-payment) comfortably
 * exceeds what it collected. That was true for every paid tier at
 * launch — Starter's $50 cap against a $19/mo price, Business genuinely
 * `null` (unlimited) behind the exact same unvetted, self-serve Stripe
 * checkout as the other two — and none of it had been weighed against
 * dollars actually at risk. The corrected caps are a flat, small, per-tier
 * FRAUD BACKSTOP instead: enough to cover real small-team usage, small
 * enough that the worst case stays bounded. `telephonyIncludedCents` (the
 * prepaid allowance) and the markup percentages are unchanged — those were
 * already sized as a fraction of what a plan collects and hold up.
 */
export const CATALOG = [
  {
    id: 'free',
    name: 'Free',
    description: 'For trying things out. Boards, chat, docs and the AI assistant for a small team.',
    sortOrder: 0,
    features: ['chat', 'docs', 'aiAssistant'],
    withProduct: false,
    monthlyCents: null,
    annualCents: null,
    limits: {
      telephonyCapCents: 0,
      automationRunsPerHour: 0,
      turnIssuancePerDay: 0,
      telephonyIncludedCents: 0,
      telephonyMarkupPct: 0,
      // A flat fraud backstop, the identical convention as telephonyCapCents
      // just above it — not a multiple of price, since Free has none. $2 is
      // enough to try the assistant (a handful of real completions, per
      // packages/ai/rates.ts's own per-model prices) without leaving a free
      // tier's AI spend genuinely unbounded.
      aiTokenBudgetMonthlyCents: 200,
    },
  },
  {
    id: 'starter',
    name: 'Starter',
    description: 'For a team that has outgrown spreadsheets. Adds search and voice.',
    sortOrder: 1,
    features: ['chat', 'docs', 'tqlTextSyntax', 'telephony', 'aiAssistant'],
    withProduct: true,
    monthlyCents: 1900,
    annualCents: 19_000,
    limits: {
      // Flat fraud backstop, not a multiple of price — see this file's
      // header. $15 covers real small-team usage; the prepaid $5
      // (telephonyIncludedCents below) is what's actually "free."
      telephonyCapCents: 1500,
      automationRunsPerHour: 60,
      turnIssuancePerDay: 200,
      telephonyIncludedCents: 500,
      telephonyMarkupPct: 20,
      aiTokenBudgetMonthlyCents: 1000,
    },
  },
  {
    id: 'pro',
    name: 'Pro',
    description: 'For teams that run on it. Automation, the public API and higher limits.',
    sortOrder: 2,
    features: [
      'chat',
      'docs',
      'tqlTextSyntax',
      'telephony',
      'automation',
      'publicApi',
      'aiAssistant',
    ],
    withProduct: true,
    monthlyCents: 4900,
    annualCents: 49_000,
    limits: {
      // Flat fraud backstop, not a multiple of price.
      telephonyCapCents: 5000,
      automationRunsPerHour: 600,
      turnIssuancePerDay: 2000,
      telephonyIncludedCents: 2500,
      telephonyMarkupPct: 15,
      aiTokenBudgetMonthlyCents: 3000,
    },
  },
  {
    id: 'business',
    name: 'Business',
    description: 'Everything, with generous usage limits and priority support.',
    sortOrder: 3,
    /* `analytics` is the one feature this tier has that `pro` does not — every
       other entry below is identical to `pro`'s list, so without it Business
       would differ from Pro on limits and price alone. Dashboards aggregate
       activity across the whole org, which fits "the top tier that removes
       every ceiling" better than a mid tier still bounded by run-rate limits. */
    features: [
      'chat',
      'docs',
      'tqlTextSyntax',
      'telephony',
      'automation',
      'publicApi',
      'analytics',
      'aiAssistant',
    ],
    withProduct: true,
    monthlyCents: 14_900,
    annualCents: 149_000,
    limits: {
      /* NULL is UNLIMITED, and 0 is none-at-all — both real, reachable
         states elsewhere in this catalog (Free's telephonyCapCents is 0,
         automationRunsPerHour/turnIssuancePerDay stay null/unlimited here).
         telephonyCapCents does NOT get that treatment (this file's header):
         Business is the same unvetted, self-serve Stripe
         checkout as Starter and Pro, just a higher price, so "no ceiling on
         spend" was payment-risk exposure nobody had priced in, not a
         deliberately unlimited allowance. $100 is still enormous for any
         real team's usage — it just stops being infinite. */
      telephonyCapCents: 10_000,
      automationRunsPerHour: null,
      turnIssuancePerDay: null,
      telephonyIncludedCents: 10_000,
      telephonyMarkupPct: 10,
      // Bounded for the IDENTICAL reason telephonyCapCents is bounded on this
      // tier rather than null/unlimited like automationRunsPerHour/
      // turnIssuancePerDay above — an LLM completion is real third-party
      // spend (Anthropic/OpenAI/Gemini), the same unvetted self-serve
      // checkout risk a phone call is, not an internal cost like an
      // automation run or a TURN credential issuance. $100 matches
      // telephonyCapCents's own business-tier number exactly.
      aiTokenBudgetMonthlyCents: 10_000,
    },
  },
] as const;

export interface CatalogOutput {
  /** Plan ids that exist and are sellable, in display order. */
  readonly planIds: readonly string[];
  readonly created: number;
  /** Existing, left untouched (the default — `ctx.reseedPlans` is false). */
  readonly reused: number;
  /** Existing, reconciled to CATALOG via `updatePlan` (`ctx.reseedPlans` is true). */
  readonly reconciled: number;
}

/**
 * A recognizable request id for the operator-audit rows this module produces.
 *
 * `createPlan` writes to the GLOBAL operator audit chain, so a seed run leaves
 * a real trail there — which is correct (the plans genuinely were created by
 * that operator) and worth being able to pick out afterwards.
 */
const SEED_REQUEST_ID = '00000000-0000-0000-0000-00000000cafe';

export const catalogModule = defineSeedModule({
  name: 'billing.catalog',
  /* The operator is the actor every one of these calls is attributed to. */
  requires: [adminModule],
  /* Deliberately empty — see the file header on why reset cannot own these. */
  tables: [],

  async seed(ctx): Promise<CatalogOutput> {
    if (ctx.payments === null) {
      ctx.log('billing.catalog: no payment provider — skipped.');
      return { planIds: [], created: 0, reused: 0, reconciled: 0 };
    }

    const { operator } = ctx.use(adminModule);
    /* Every call below is attributed to the operator as an actor, in a REAL
       operator-audit row (SEED_REQUEST_ID's own comment) — there is no
       "seeded by nobody" actor to fall back to, and inventing one would
       write an audit entry that lies about who acted. Same skip as the
       payments check above: SEED_PLATFORM_ADMIN_EMAIL/PASSWORD unset means
       there is no operator to be the actor, so the catalog goes unseeded
       along with the console that would have managed it. */
    if (operator === null) {
      ctx.log('billing.catalog: no platform operator — skipped.');
      return { planIds: [], created: 0, reused: 0, reconciled: 0 };
    }

    const deps = { events: new InMemoryEventBus(), payments: ctx.payments };
    const actor = {
      userId: unsafeAsId<'UserId'>(operator.id) as UserId,
      requestId: unsafeAsId<'RequestId'>(SEED_REQUEST_ID) as RequestId,
    };

    /* What is already here, including migration 0063's own `free` and `pro`
       seeds — which exist in every database before this module ever runs. */
    const existing = new Set((await listPlans(deps, actor)).map((plan) => plan.id));

    /* Checked BEFORE the first provider call, not per plan as the loop reaches
       it. `createPlan` validates its own features and throws — but by then it
       has already created a Stripe Product for an earlier tier, so a typo in
       the LAST plan leaves orphaned objects behind and a half-built catalog.
       Failing here costs nothing and names every bad flag at once.

       Not paranoia about a literal: the first version of CATALOG used
       'search' and 'public_api', neither of which the registry has (they are
       'tqlTextSyntax' and 'publicApi'), and the run died three plans in —
       after creating two real Stripe Products. */
    const unknown = CATALOG.flatMap((tier) =>
      tier.features.filter((flag) => !FLAG_NAMES.includes(flag)),
    );
    if (unknown.length > 0) {
      throw new Error(
        `billing.catalog: unknown feature flag(s) ${unknown.join(', ')}. ` +
          `Registered: ${FLAG_NAMES.join(', ')}.`,
      );
    }

    /* Never grantable through a plan — it authorizes REAL CARRIER SPEND, so a
       pricing table must not be able to hand it out. `createPlan` refuses it
       too; this only says so before anything has been created. */
    const spendFlag = 'telephonyLiveCredentials';
    if (CATALOG.some((tier) => (tier.features as readonly string[]).includes(spendFlag))) {
      throw new Error(`billing.catalog: ${spendFlag} is not grantable through a plan.`);
    }

    let created = 0;
    let reused = 0;
    let reconciled = 0;

    for (const tier of CATALOG) {
      if (existing.has(tier.id)) {
        if (ctx.reseedPlans) {
          /* `updatePlan` diffs against what's stored and only writes (and
             only audits/emits) the fields that actually changed — see its
             own `assign` helper — so passing the full desired shape here on
             every reconciling run is safe: a plan already matching CATALOG
             is a genuine no-op, not a no-op audit log entry. */
          await updatePlan(deps, actor, {
            planId: tier.id,
            name: tier.name,
            description: tier.description,
            sortOrder: tier.sortOrder,
            features: [...tier.features],
            ...tier.limits,
          });
          reconciled += 1;
        } else {
          reused += 1;
        }
      } else {
        await createPlan(deps, actor, {
          id: tier.id,
          name: tier.name,
          description: tier.description,
          sortOrder: tier.sortOrder,
          features: [...tier.features],
          withProduct: tier.withProduct,
          ...tier.limits,
        });
        created += 1;
      }

      /* Prices are set for every tier on every run, new or reused, and that is
         the one place this module is deliberately NOT a no-op on a re-seed.
         `setPrice` archives the previous current price and creates a new one —
         which is exactly what makes a re-seed produce a catalog matching the
         literal above even if somebody edited a price in the console, while
         leaving every existing subscription billing at the amount it was sold
         at (§3.2's grandfathering). A skip here would let the console and the
         seed disagree with no way to reconcile them. */
      if (tier.monthlyCents !== null) {
        await setPrice(deps, actor, {
          planId: tier.id,
          interval: 'month',
          amountCents: tier.monthlyCents,
          currency: 'usd',
        });
      }
      if (tier.annualCents !== null) {
        await setPrice(deps, actor, {
          planId: tier.id,
          interval: 'year',
          amountCents: tier.annualCents,
          currency: 'usd',
        });
      }
    }

    const planIds = CATALOG.map((tier) => tier.id);
    ctx.log(
      `billing.catalog: ${String(created)} plan(s) created, ${String(reused)} reused, ` +
        `${String(reconciled)} reconciled, ` +
        `${String(planIds.length)} priced (${ctx.payments.isLive ? 'LIVE processor' : 'fake processor'})`,
    );

    return { planIds, created, reused, reconciled };
  },
});
