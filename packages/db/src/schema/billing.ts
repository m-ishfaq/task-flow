import {
  bigint,
  boolean,
  index,
  integer,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { orgs } from './tenancy.js';
import { users } from './identity.js';

/**
 * Billing tables (migration 0059, Phase 12 Wave 3, ai/phase-12-wave3.md §3.2,
 * §3.5; migrations 0062–0063, Phase 12 Wave 4, ai/phase-12-wave4-plans.md
 * §3.2). As with every other schema file, this is the TypeScript mirror; the
 * migration is the source and carries the RLS policies, the CHECK constraints
 * and the reasoning no generated diff can express.
 *
 * `customerOrgs` has **no RLS**, deliberately — the identical shape and
 * reasoning as `comms.subaccountOrgs`: the pre-tenant lookup an
 * unauthenticated Stripe webhook needs to find its org before any scope can
 * be opened, holding nothing but the mapping itself.
 *
 * `plans` and `planPrices` have no RLS either, for a different reason: they
 * carry no `org_id` at all. A plan belongs to no tenant — it is the thing
 * tenants are on. `orgEntitlements` is the per-org one and is RLS'd normally.
 *
 * **`identity.orgs.plan_id` references `plans.id` and this file cannot say
 * so.** The foreign key is real (0063) but expressing it here would make
 * `tenancy.ts` import this module while this module imports `tenancy.ts`.
 * Same class of gap as `work.ts`'s composite foreign keys, and the same
 * answer: the migration is the source, and the weaker half of the truth here
 * is a mirror limitation rather than a missing constraint.
 */

const billing = pgSchema('billing');

export const customerOrgs = billing.table('customer_orgs', {
  stripeCustomerId: text('stripe_customer_id').primaryKey(),
  orgId: uuid('org_id')
    .notNull()
    .references(() => orgs.id, { onDelete: 'cascade' }),
});

export const webhookEvents = billing.table(
  'webhook_events',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    providerEventId: text('provider_event_id').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.providerEventId] }),
    index('billing_webhook_events_received_at_idx').on(table.receivedAt),
  ],
);

/**
 * Recorded invoices (migration 0065) — a MIRROR of the processor's own.
 *
 * The processor stays authoritative for what a customer was actually charged;
 * this exists so the billing page works during a processor incident, survives
 * a processor swap, and reads in one indexed query instead of a network round
 * trip. `hostedInvoiceUrl` is the path back to the original, stored rather
 * than constructed because the URL format is Stripe's to change.
 *
 * The PROCESSOR's invoice id is the primary key: a retried webhook carries the
 * same invoice, so recording it twice is an idempotent upsert rather than a
 * duplicate row nothing dedupes.
 */
export const invoices = billing.table(
  'invoices',
  {
    providerInvoiceId: text('provider_invoice_id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    /** The printed number. Null on a draft, which can arrive before finalization. */
    number: text('number'),
    status: text('status')
      .notNull()
      .$type<'draft' | 'open' | 'paid' | 'uncollectible' | 'void'>(),
    amountDueCents: bigint('amount_due_cents', { mode: 'number' }).notNull(),
    amountPaidCents: bigint('amount_paid_cents', { mode: 'number' }).notNull().default(0),
    currency: text('currency').notNull(),
    periodStart: timestamp('period_start', { withTimezone: true }),
    periodEnd: timestamp('period_end', { withTimezone: true }),
    hostedInvoiceUrl: text('hosted_invoice_url'),
    invoicePdfUrl: text('invoice_pdf_url'),
    /** When the PROCESSOR issued it — never our clock; a retry can arrive late. */
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('invoices_org_issued_at_idx').on(table.orgId, table.issuedAt)],
);

/**
 * Durable "already warned" markers (migration 0067).
 *
 * The usage alerts fire from a check that runs on every outbound call, so
 * without this an org sitting at 81% of its cap emails its owner on every
 * call for the rest of the month. An in-process Set would work until the next
 * deploy and then forgive everyone — the same reasoning rtc.turn_issuance
 * gives for counting in Postgres rather than in memory.
 *
 * `periodStart` is what makes it self-resetting: the cap is a ROLLING window
 * with no billing boundary to reset on, so each alert records the window it
 * was sent for and a new window simply has no row. Nothing has to sweep this
 * table for next month's warning to fire.
 */
export const alertsSent = billing.table(
  'alerts_sent',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    alert: text('alert').notNull().$type<'usage_80' | 'usage_100' | 'usage_over' | 'trial_ending'>(),
    periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.orgId, table.alert, table.periodStart] })],
);

/**
 * One overage charge per (org, closed period) — migration 0068.
 *
 * The composite primary key is the double-charge guard rather than mere
 * identity: the period-close job claims the row with ON CONFLICT DO NOTHING
 * BEFORE calling the processor, so two workers racing on the same period
 * produce exactly one charge. See the migration's header for the failure
 * direction that leaves and why it is not retried automatically.
 *
 * The four input columns are stored rather than recomputed because the plan is
 * mutable: raising an allowance next week would silently change what last
 * month's invoice "should have been".
 */
export const usageCharges = billing.table(
  'usage_charges',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),

    periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
    periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),

    usageCents: bigint('usage_cents', { mode: 'number' }).notNull(),
    includedCents: bigint('included_cents', { mode: 'number' }).notNull(),
    markupPct: integer('markup_pct').notNull(),
    billableCents: bigint('billable_cents', { mode: 'number' }).notNull(),

    providerInvoiceItemId: text('provider_invoice_item_id'),
    failedReason: text('failed_reason'),

    claimedAt: timestamp('claimed_at', { withTimezone: true }).notNull().defaultNow(),
    chargedAt: timestamp('charged_at', { withTimezone: true }),
  },
  (table) => [primaryKey({ columns: [table.orgId, table.periodStart] })],
);

/**
 * The plan catalog (migration 0062).
 *
 * `id` is a slug rather than a uuid on purpose: it is written into
 * `identity.orgs.plan_id`, read back in the console and in logs, and quoted in
 * support conversations. A uuid would mean every plan reference has to be
 * joined before a human can read it.
 *
 * The three ceilings are nullable, and NULL means UNLIMITED where 0 means
 * none-at-all — two different states, both real. `telephonyCapCents` is a
 * CEILING on `comms.spendPolicy.capCents`, never the value itself: it replaces
 * `TELEPHONY_MAX_SPEND_CAP_CENTS` as the bound a compromised Owner credential
 * cannot move (ai/phase-12-wave4-plans.md §3.1).
 */
export const plans = billing.table(
  'plans',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description'),
    sortOrder: integer('sort_order').notNull().default(0),
    /** Sellable. An inactive plan keeps working for orgs already on it. */
    isActive: boolean('is_active').notNull().default(true),
    /** Where an expiring trial lands. At most one row, by partial unique index. */
    isDefault: boolean('is_default').notNull().default(false),
    /** NULL for a plan with no paid price — the free tier reaches no checkout. */
    stripeProductId: text('stripe_product_id'),
    /**
     * `FlagName[]`, validated against `FLAG_NAMES` in the service rather than
     * by a CHECK, because the database cannot know the registry — the same
     * reasoning `packages/seed/src/modules/platform.admin.ts` states for its
     * own override list.
     */
    features: text('features').array().notNull().default(sql`'{}'`),
    telephonyCapCents: bigint('telephony_cap_cents', { mode: 'number' }),
    automationRunsPerHour: integer('automation_runs_per_hour'),
    turnIssuancePerDay: integer('turn_issuance_per_day'),
    /** What the subscription already covers; past it, overage accrues (§3.8). */
    telephonyIncludedCents: bigint('telephony_included_cents', { mode: 'number' })
      .notNull()
      .default(0),
    /** 0 is passthrough at cost. Pricing policy, never a gate. */
    telephonyMarkupPct: integer('telephony_markup_pct').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (table) => [
    uniqueIndex('plans_stripe_product_id_key').on(table.stripeProductId),
    index('plans_active_sort_idx').on(table.sortOrder),
  ],
);

/**
 * Prices, append-and-archive (migration 0062).
 *
 * Many rows per `(plan, interval)`; exactly one current, enforced by the
 * migration's `plan_prices_current_key` partial unique index — which is the
 * whole grandfathering mechanism. Repricing archives the old row and inserts a
 * new one; an existing subscription keeps billing against the archived Stripe
 * Price, which Stripe honours indefinitely, so nothing about a live customer's
 * charge changes because a number was edited in a console.
 *
 * Drizzle cannot express a partial unique index's WHERE clause, so the
 * uniqueness declared here is narrower than the database's. The migration is
 * the source.
 */
export const planPrices = billing.table(
  'plan_prices',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    planId: text('plan_id')
      .notNull()
      .references(() => plans.id, { onDelete: 'restrict' }),
    interval: text('interval').notNull().$type<'month' | 'year'>(),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    currency: text('currency').notNull().default('usd'),
    stripePriceId: text('stripe_price_id'),
    isCurrent: boolean('is_current').notNull().default(true),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('plan_prices_stripe_price_id_key').on(table.stripePriceId),
    index('plan_prices_plan_id_idx').on(table.planId),
  ],
);

/**
 * The operator override — tier 1 of four (migration 0062, §3.1).
 *
 * Outranks the plan, which is what makes it useful and what makes it
 * dangerous: "every Pro org has Docs" becomes "unless somebody decided
 * otherwise". `reason` is therefore NOT NULL and `expiresAt` exists so a
 * temporary grant does not become permanent by being forgotten.
 *
 * **Deltas, not a replacement set.** A full `features` override would freeze
 * the org at the feature list it had the day the override was written — add a
 * module to Business six months later and the one org with an override
 * silently does not get it, with nothing reporting that it did not. The
 * migration's `org_entitlements_no_contradiction` CHECK forbids a feature
 * appearing in both arrays, because picking a winner silently would make
 * precedence depend on which branch of the resolver was written first.
 *
 * Every scalar is nullable and NULL means "inherit the plan", independently
 * per field — an override that had to restate every ceiling would drift from
 * the plan the moment the plan changed.
 */
export const orgEntitlements = billing.table(
  'org_entitlements',
  {
    orgId: uuid('org_id')
      .primaryKey()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    featuresAdd: text('features_add').array().notNull().default(sql`'{}'`),
    featuresRemove: text('features_remove').array().notNull().default(sql`'{}'`),
    telephonyCapCents: bigint('telephony_cap_cents', { mode: 'number' }),
    telephonyIncludedCents: bigint('telephony_included_cents', { mode: 'number' }),
    telephonyMarkupPct: integer('telephony_markup_pct'),
    automationRunsPerHour: integer('automation_runs_per_hour'),
    turnIssuancePerDay: integer('turn_issuance_per_day'),
    reason: text('reason').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    setBy: uuid('set_by').references(() => users.id, { onDelete: 'set null' }),
    setAt: timestamp('set_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('org_entitlements_expires_at_idx').on(table.expiresAt)],
);
