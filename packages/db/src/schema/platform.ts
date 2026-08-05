import { sql } from 'drizzle-orm';
import {
  bigint,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { orgs } from './tenancy.js';
import { users } from './identity.js';

/**
 * Platform tables (migration 0006, PLAN.md §10.6).
 */

const platform = pgSchema('platform');

/**
 * The transactional outbox — the seam between a mutation and everything
 * reactive (audit, notifications, realtime, search, automation).
 *
 * Rows are written by `appendToOutbox` inside the mutation's own transaction,
 * so the event and the change it describes commit or roll back together.
 *
 * `publishedAt`, `attempts` and `lastError` below are RETIRED as of migration
 * 0015 — superseded by `outboxDispatch`, which tracks dispatch per (event,
 * consumer) instead of one global flag. They are not yet dropped
 * (expand-migrate-contract, PLAN.md §7.4): nothing in this codebase writes
 * them anymore, but a contract migration removing them is a separate,
 * later change so a mid-deploy instance still running old code does not
 * fail against a missing column.
 */
export const outbox = platform.table(
  'outbox',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),

    name: text('name').notNull(),
    version: integer('version').notNull(),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    requestId: text('request_id'),
    payload: jsonb('payload').notNull(),

    /** @deprecated Superseded by `outboxDispatch`. See the table comment above. */
    publishedAt: timestamp('published_at', { withTimezone: true }),
    /** @deprecated Superseded by `outboxDispatch.attempts`. */
    attempts: integer('attempts').notNull().default(0),
    /** @deprecated Superseded by `outboxDispatch.lastError`. */
    lastError: text('last_error'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Partial, so it tracks the backlog rather than the history. Retained
    // even though nothing queries `published_at` anymore — dropping the
    // index is part of the contract migration that drops the column.
    index('outbox_pending_idx')
      .on(table.occurredAt, table.id)
      .where(sql`published_at IS NULL`),
    index('outbox_org_idx').on(table.orgId, table.occurredAt.desc()),
  ],
);

/**
 * Per-(event, consumer) dispatch state — the fan-out seam Phase 4 needs
 * (migration 0015, PLAN.md §10.6).
 *
 * `outbox`'s original design had ONE reader draining the whole table, so a
 * single `publishedAt` flag was correct: once dispatched, an event was done,
 * full stop. That stops being true the moment a second consumer exists —
 * `published_at` set by audit makes the row invisible to realtime's own scan,
 * because both would have been reading the exact same flag. This table
 * replaces "dispatched" (one boolean) with "dispatched to CONSUMER X" (one
 * row per consumer that has claimed the event), so audit finishing first
 * no longer erases the event for anyone dispatched after it.
 *
 * `dispatchedAt IS NULL` is deliberately an EXISTENCE scan, not a position
 * cursor. A cursor recording "processed up through position N" would skip
 * any transaction that commits late with an occurredAt earlier than N — the
 * exact failure `outbox_pending_idx` above was built to avoid for the single
 * consumer, and turning it into a per-consumer cursor would reintroduce it
 * once for every consumer instead of once for the whole table.
 */
export const outboxDispatch = platform.table(
  'outbox_dispatch',
  {
    eventId: uuid('event_id')
      .notNull()
      .references(() => outbox.id, { onDelete: 'cascade' }),
    /** A short, stable name — `'audit'`, `'realtime'` — never user input. */
    consumer: text('consumer').notNull(),

    /** Null until THIS consumer has dispatched the event. */
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
  },
  (table) => [
    primaryKey({ columns: [table.eventId, table.consumer] }),
    // Every consumer's claim query, proportional to ITS OWN backlog rather
    // than the union of every consumer's — same reasoning as
    // `outbox_pending_idx`.
    index('outbox_dispatch_pending_idx')
      .on(table.consumer, table.eventId)
      .where(sql`dispatched_at IS NULL`),
  ],
);

/**
 * Attachments (migration 0010, PLAN.md §7, §8.4).
 *
 * `status` is the upload pipeline from §8.4 expressed as a column:
 * `pending -> scanning -> clean | infected | rejected`. The security argument
 * of the whole feature is that a download URL is only ever issued for a row
 * reading `clean` — the object exists in storage from the moment the browser
 * finishes its PUT, and this table controls whether anyone is handed a way to
 * reach it.
 *
 * There is deliberately no foreign key to cards: attachments hang off cards
 * today and off messages and pages from Phase 5, so `(parentType, parentId)` is
 * polymorphic. Same reasoning as `authz.relationship_tuples` — the service
 * owning the parent handles cleanup, and a dangling attachment grants access to
 * nothing because the parent lookup fails first.
 */
export const attachments = platform.table(
  'attachments',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id').notNull(),

    parentType: text('parent_type').notNull(),
    parentId: uuid('parent_id').notNull(),

    /** Server-generated. No part of this ever comes from a client. */
    storageKey: text('storage_key').notNull(),

    /** Shown to the user and sent in Content-Disposition. Escaped at use. */
    filename: text('filename').notNull(),

    /** Declared at presign and pinned into the upload signature. */
    contentType: text('content_type').notNull(),
    declaredBytes: bigint('declared_bytes', { mode: 'number' }).notNull(),

    /** What HEAD reported after the upload landed. Null until confirm runs. */
    sizeBytes: bigint('size_bytes', { mode: 'number' }),

    status: text('status').notNull().default('pending'),

    /** Signature name for a detection, or the reason for a rejection. */
    scanResult: text('scan_result'),
    scannedAt: timestamp('scanned_at', { withTimezone: true }),

    uploadedBy: uuid('uploaded_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('attachments_storage_key_key').on(table.storageKey),
    index('attachments_parent_idx')
      .on(table.orgId, table.parentType, table.parentId)
      .where(sql`deleted_at IS NULL`),
  ],
);
