import { sql } from 'drizzle-orm';
import {
  index,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  bigint,
  boolean,
} from 'drizzle-orm/pg-core';
import { users } from './identity.js';

/**
 * Tenancy tables (migration 0004, PLAN.md §7, §8.2).
 *
 * As with identity.ts, these are the TypeScript mirror of the migration and not
 * its source. Drizzle is a query builder here; the migration files are what CI
 * runs up -> down -> up against real Postgres, and they carry the RLS policies,
 * the CHECK constraints, and the reasoning that no generated diff can express.
 *
 * If these two disagree, the migration wins and this file is the bug.
 */

const identity = pgSchema('identity');

/**
 * An organization — the tenant itself.
 *
 * Note there is no `orgId` column: the tenant column on this one table is `id`,
 * which is why its RLS policy is written with an explicit column rather than
 * generated from the default.
 */
export const orgs = identity.table(
  'orgs',
  {
    id: uuid('id').primaryKey(),
    name: text('name').notNull(),
    /** URL-facing, unique across the whole system — it appears in paths and mail. */
    slug: text('slug').notNull(),
    status: text('status').notNull().default('active'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),

    /**
     * Billing state (Phase 12 Wave 3, migration 0059) — deliberately
     * INDEPENDENT of `status` above. `status` is Wave 1's operator kill
     * switch; `billingStatus` is written only by the billing worker sweep
     * and the Stripe webhook handler, so an automated billing recovery can
     * never silently undo a manual operator suspension, or vice versa. See
     * `ai/phase-12-wave3.md` §3.2.
     */
    billingStatus: text('billing_status').notNull().default('trialing'),
    planId: text('plan_id'),
    trialEndsAt: timestamp('trial_ends_at', { withTimezone: true }),
    billingGraceEndsAt: timestamp('billing_grace_ends_at', { withTimezone: true }),
    stripeCustomerId: text('stripe_customer_id'),
    stripeSubscriptionId: text('stripe_subscription_id'),
    /**
     * When the paid period renews, mirrored from the processor (0066).
     *
     * NULL for any org that has never had a subscription — most of them.
     * Can be stale if a webhook was missed, so it is INFORMATION and never an
     * authorization input; nothing gates on it.
     */
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
    currentPriceCents: bigint('current_price_cents', { mode: 'number' }),
    currentPriceInterval: text('current_price_interval').$type<'month' | 'year'>(),
    /**
     * A DOWNGRADE parked until the paid period ends (0066).
     *
     * An upgrade applies immediately — they pay the difference now. A
     * downgrade waits, because removing features someone already paid for is
     * a refund conversation rather than a plan change. Both columns are set
     * together or not at all, enforced by a CHECK.
     */
    pendingPlanId: text('pending_plan_id'),
    pendingPlanEffectiveAt: timestamp('pending_plan_effective_at', { withTimezone: true }),

    /**
     * The subscription is set to STOP at `currentPeriodEnd` rather than renew
     * (migration 0069).
     *
     * A separate fact from `billingStatus`, and the reason this column exists
     * at all: an org here is fully active and paying, and may still change its
     * mind. Encoding it as a status value would read as "ended" to every path
     * that consults the status.
     */
    cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
  },
  (table) => [
    uniqueIndex('orgs_slug_key').on(table.slug),
    uniqueIndex('orgs_stripe_customer_id_key')
      .on(table.stripeCustomerId)
      .where(sql`${table.stripeCustomerId} IS NOT NULL`),
    uniqueIndex('orgs_stripe_subscription_id_key')
      .on(table.stripeSubscriptionId)
      .where(sql`${table.stripeSubscriptionId} IS NOT NULL`),
  ],
);

/**
 * The join between a user and an organization, and the only place a role lives.
 *
 * Not a column on users, and deliberately not a claim in the access token: a
 * claim would mean the caller's own credential asserted their role, so a
 * demotion would not take effect until the token expired.
 */
export const memberships = identity.table(
  'memberships',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    /** One of ROLES from @taskflow/policy. The migration's CHECK is the enforcement. */
    role: text('role').notNull(),
    status: text('status').notNull().default('active'),

    /** Null for the founding owner, who was invited by nobody. */
    invitedBy: uuid('invited_by').references(() => users.id, { onDelete: 'set null' }),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('memberships_org_user_key').on(table.orgId, table.userId),
    index('memberships_user_idx')
      .on(table.userId)
      .where(sql`status = 'active'`),
  ],
);

export const teams = identity.table(
  'teams',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('teams_org_slug_key').on(table.orgId, table.slug),
    // Target of team_members' composite foreign key, not a query index.
    uniqueIndex('teams_org_id_key').on(table.orgId, table.id),
  ],
);

/**
 * Team membership.
 *
 * `orgId` is denormalized from teams because RLS filters on a column of THIS
 * table — a policy that joined to teams would depend on another table's policy.
 * The migration's composite foreign key `(org_id, team_id)` is what keeps the
 * copy honest, and it has no equivalent here: Drizzle's `references()` is
 * single-column, so the migration is the only place that constraint exists.
 */
export const teamMembers = identity.table(
  'team_members',
  {
    orgId: uuid('org_id').notNull(),
    teamId: uuid('team_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.teamId, table.userId] }),
    index('team_members_user_idx').on(table.orgId, table.userId),
  ],
);

/**
 * An outstanding invitation to join the org by email (migration 0107) — what
 * `addMember` deliberately does not cover: an address with no TaskFlow
 * account yet. See `apps/api/src/tenancy/invitation.service.ts`.
 */
export const invitations = identity.table('invitations', {
  id: uuid('id').primaryKey(),
  orgId: uuid('org_id')
    .notNull()
    .references(() => orgs.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  role: text('role').notNull(),
  status: text('status').notNull().default('pending'),
  tokenHash: text('token_hash').notNull(),
  invitedBy: uuid('invited_by').references(() => users.id, { onDelete: 'set null' }),
  acceptedUserId: uuid('accepted_user_id').references(() => users.id, { onDelete: 'set null' }),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * The pre-tenant `token -> org` lookup an invitation-accept call needs before
 * it can open a scope — the identical shape and reasoning as
 * `comms.subaccount_orgs`/`billing.customer_orgs`. NO RLS: see migration
 * 0107's own header and `scripts/check-migration-rls.mjs`'s RLS_EXEMPT.
 */
export const invitationLookup = identity.table('invitation_lookup', {
  tokenHash: text('token_hash').primaryKey(),
  orgId: uuid('org_id')
    .notNull()
    .references(() => orgs.id, { onDelete: 'cascade' }),
});
