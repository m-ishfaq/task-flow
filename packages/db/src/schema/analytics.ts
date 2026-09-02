import { boolean, date, doublePrecision, integer, pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { orgs } from './tenancy.js';

/**
 * Analytics tables (migration 0091, ai/phase-11-analytics.md §1-§2).
 *
 * `cardTransitions` is a PROJECTION, not a copy of record: the analytics relay
 * writes one append-only row per `card.status_changed` event (plus synthetic
 * creation rows the backfill mints), and the rollups (Wave 2) read it — never
 * the transactional tables. It exists because every analytics metric is a
 * question about the PAST (when did this card reach Done, how long was it in
 * Active) and `work.cards` only stores the PRESENT.
 *
 * The from/to CATEGORY is frozen at write time on purpose: re-categorizing a
 * status later must not rewrite last quarter's velocity. And there is no FK to
 * `work.cards` — a deleted card keeps its history (§7 decision 6). Only `orgId`
 * is a real FK, with cascade.
 */

const analytics = pgSchema('analytics');

export const cardTransitions = analytics.table('card_transitions', {
  /** The projection row's own id. */
  id: uuid('id').primaryKey(),
  orgId: uuid('org_id')
    .notNull()
    .references(() => orgs.id, { onDelete: 'cascade' }),
  /** The source row's id — bare, no FK, so a deleted card keeps its history. */
  cardId: uuid('card_id').notNull(),
  boardId: uuid('board_id').notNull(),
  projectId: uuid('project_id').notNull(),
  /** Status category ('not_started' | 'active' | 'done') at transition time. NULL only for a synthetic creation row. */
  fromCategory: text('from_category'),
  toCategory: text('to_category').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
  /** true when SYNTHESIZED (a card's creation, real or backfilled) rather than read from a real event (§2.2). */
  synthetic: boolean('synthetic').notNull().default(false),
  /**
   * The source outbox event id, for idempotency: a redelivered event conflicts
   * on the migration's `card_transitions_event_key` partial-unique and inserts
   * nothing. NULL for a synthetic row (its idempotency is the per-card unique).
   */
  sourceEventId: uuid('source_event_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
// The partial-unique and query indexes live only in the migration (0091):
// Drizzle needs the column definitions above to build the projection's inserts
// and the rollups' reads, but the `ON CONFLICT DO NOTHING` the relay uses names
// no target, so it does not need the index declared here.

/* -------------------------------------------------------------------------- *
 * Rollup tables (migration 0092, ai/phase-11-analytics.md §1, §6).
 *
 * Pre-computed aggregations over card_transitions, refreshed on a schedule by
 * a worker loop. Dashboards read these instead of computing on-the-fly from the
 * fact table. Regular tables (not materialized views) so RLS applies.
 * -------------------------------------------------------------------------- */

/**
 * §3.1 — Velocity: daily done counts per board.
 * One row per (org, board, day).
 */
export const rollupVelocity = analytics.table('rollup_velocity', {
  orgId: uuid('org_id')
    .notNull()
    .references(() => orgs.id, { onDelete: 'cascade' }),
  boardId: uuid('board_id').notNull(),
  day: date('day').notNull(),
  doneCount: integer('done_count').notNull().default(0),
});

/**
 * §3.3 — CFD: daily category counts per board.
 * One row per (org, board, day, category).
 */
export const rollupCfd = analytics.table('rollup_cfd', {
  orgId: uuid('org_id')
    .notNull()
    .references(() => orgs.id, { onDelete: 'cascade' }),
  boardId: uuid('board_id').notNull(),
  day: date('day').notNull(),
  category: text('category').notNull(),
  cardCount: integer('card_count').notNull().default(0),
});

/**
 * §3.4 — Cycle Time: per-card cycle time.
 * One row per (org, card_id). NULL cycle_time_hours means the card never reached done.
 */
export const rollupCycleTime = analytics.table('rollup_cycle_time', {
  orgId: uuid('org_id')
    .notNull()
    .references(() => orgs.id, { onDelete: 'cascade' }),
  cardId: uuid('card_id').notNull(),
  boardId: uuid('board_id').notNull(),
  projectId: uuid('project_id').notNull(),
  cycleTimeHours: doublePrecision('cycle_time_hours'),
  firstActiveAt: timestamp('first_active_at', { withTimezone: true }),
  firstDoneAt: timestamp('first_done_at', { withTimezone: true }),
});

/**
 * §3.6 — Volume: daily message/call counts.
 * One row per (org, day).
 */
export const rollupVolume = analytics.table('rollup_volume', {
  orgId: uuid('org_id')
    .notNull()
    .references(() => orgs.id, { onDelete: 'cascade' }),
  day: date('day').notNull(),
  messageCount: integer('message_count').notNull().default(0),
  callCount: integer('call_count').notNull().default(0),
  callDurationMin: doublePrecision('call_duration_min').notNull().default(0),
  inAppCallCount: integer('in_app_call_count').notNull().default(0),
});

/**
 * §3.2 — Burndown: daily done/undone counts per project.
 * One row per (org, project, day). Date-range mode reads from here;
 * sprint mode reads card_transitions directly.
 */
export const rollupBurndown = analytics.table('rollup_burndown', {
  orgId: uuid('org_id')
    .notNull()
    .references(() => orgs.id, { onDelete: 'cascade' }),
  projectId: uuid('project_id').notNull(),
  day: date('day').notNull(),
  doneCount: integer('done_count').notNull().default(0),
  undoneCount: integer('undone_count').notNull().default(0),
});
