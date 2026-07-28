import { sql } from 'drizzle-orm';
import {
  index,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
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
  },
  (table) => [uniqueIndex('orgs_slug_key').on(table.slug)],
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
