import { sql } from 'drizzle-orm';
import {
  bigint,
  index,
  integer,
  jsonb,
  pgSchema,
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
 * so the event and the change it describes commit or roll back together. One
 * relay drains the table and fans out downstream, which is why a single
 * `publishedAt` is sufficient rather than a cursor per consumer.
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

    /** Null until the relay has dispatched it. Not a deletion — history stays. */
    publishedAt: timestamp('published_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Partial, so it tracks the backlog rather than the history.
    index('outbox_pending_idx')
      .on(table.occurredAt, table.id)
      .where(sql`published_at IS NULL`),
    index('outbox_org_idx').on(table.orgId, table.occurredAt.desc()),
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
