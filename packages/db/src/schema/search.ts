import { boolean, jsonb, pgSchema, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { orgs } from './tenancy.js';

/**
 * Search tables (migration 0045, ai/phase-8-search.md §2).
 *
 * `documents` is a PROJECTION, not a copy of record: the indexer rebuilds it
 * from domain events and the source tables at any time (the backfill path is
 * that rebuild), and the search route reads it — never the four heterogeneous
 * source tables joined. That is what makes one query span cards, messages,
 * pages and comments at all.
 *
 * `id` is the projection row's own id; the (org_id, entity_type, entity_id)
 * triple is what a redelivered event upserts against — the idempotency that
 * makes the at-least-once claim contract harmless, the same role
 * `notifications_event_user_key` plays for the notification projection.
 */

const search = pgSchema('search');

export const documents = search.table(
  'documents',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    /** 'card' | 'message' | 'page' | 'comment' — a CHECK in the migration, closed to Wave 2's four kinds (transcripts widen it in Wave 3). */
    entityType: text('entity_type').notNull(),
    /** The source row's id. */
    entityId: uuid('entity_id').notNull(),
    title: text('title'),
    /** Flattened searchable text; NULL for pages until the Wave 2 §2.4 follow-up indexes bodies. */
    body: text('body'),
    authorId: uuid('author_id'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    /** Normalized across sources — cards archive via archived_at, messages via deleted_at, pages via archived_at. */
    archived: boolean('archived').notNull().default(false),
    /** { board_id, project_id } | { channel_id } | { space_id } | { card_id, board_id } | { page_id } — permalink + per-hit can() context. */
    metadata: jsonb('metadata'),
  },
  (table) => [
    // Mirror of the migration's `documents_org_entity_key` UNIQUE constraint —
    // the idempotency the at-least-once claim contract needs, and the target
    // of the indexer's onConflictDoUpdate upsert. The migration is the source;
    // this declaration is what lets Drizzle express `ON CONFLICT` at all.
    uniqueIndex('documents_org_entity_key').on(table.orgId, table.entityType, table.entityId),
    // The tsvector and trgm GIN indexes exist only in the migration — Drizzle
    // has no expression-index builder for `USING gin`.
  ],
);
