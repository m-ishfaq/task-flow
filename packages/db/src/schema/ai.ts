import {
  bigint,
  index,
  integer,
  pgSchema,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { memberships, orgs } from './tenancy.js';

/**
 * The tenant-scoped side of the AI provider foundation (migration 0099,
 * Phase 15 §3). As with every other schema file here, this is the
 * TypeScript MIRROR of the migration and not its source — if the two
 * disagree, the migration wins and this file is the bug.
 *
 * Deliberately its own schema rather than a `platform.*` table: the ledger
 * records what one org's members spent, and CLAUDE.md's rule 1 bans
 * `WHERE org_id = ...` in application code — this table is RLS-protected
 * precisely like `comms.spend_ledger` instead. See the migration's own
 * header for the full reasoning.
 */

const ai = pgSchema('ai');

/**
 * One row per model call (§3.1). Unlike `comms.spend_ledger`, there is no
 * `estimated`/`actual` split: an LLM completion's token usage is returned
 * synchronously in the same response that carries the content, so there is
 * no asynchronous billing callback to reconcile against later — the numbers
 * here are final the moment they are written.
 */
export const aiUsageLedger = ai.table(
  'usage_ledger',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    membershipId: uuid('membership_id').references(() => memberships.id, {
      onDelete: 'set null',
    }),

    feature: text('feature').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),

    inputTokens: integer('input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    costCents: bigint('cost_cents', { mode: 'number' }).notNull(),

    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('usage_ledger_org_window_idx').on(table.orgId, table.occurredAt.desc())],
);
