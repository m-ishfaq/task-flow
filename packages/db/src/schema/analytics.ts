import { boolean, pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core';
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
