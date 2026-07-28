import {
  bigint,
  customType,
  index,
  inet,
  jsonb,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Audit tables (migration 0007, PLAN.md §8.6).
 *
 * Append-only and hash-chained. Nothing in this file can express an UPDATE or a
 * DELETE that would succeed: the grants forbid both for every role, which is
 * the actual control — an "append-only" flag in application code is not one.
 *
 * `seq`, `prevHash`, and `hash` are assigned by a BEFORE INSERT trigger, never
 * by the caller, so a writer cannot choose its own position or digest. Inserts
 * omit them.
 */

const audit = pgSchema('audit');

/** Postgres `bytea`, which Drizzle has no first-class column type for. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

export const auditLog = audit.table(
  'audit_log',
  {
    id: uuid('id').notNull(),
    orgId: uuid('org_id').notNull(),

    /** Per-org monotonic position. Assigned by the trigger. */
    seq: bigint('seq', { mode: 'bigint' }).notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),

    /** Null for the system — a retention sweep, a scheduled automation. */
    actorId: uuid('actor_id'),

    /** The domain event name that produced this entry, e.g. `member.role_changed`. */
    action: text('action').notNull(),
    resourceType: text('resource_type'),
    resourceId: uuid('resource_id'),

    changes: jsonb('changes'),
    /** The policy decision trace on a denial (§8.2). */
    decision: jsonb('decision'),

    ip: inet('ip'),
    userAgent: text('user_agent'),
    sessionId: uuid('session_id'),
    requestId: text('request_id'),

    /** Null only for the first entry in an org's chain. Assigned by the trigger. */
    prevHash: bytea('prev_hash'),
    hash: bytea('hash').notNull(),
  },
  (table) => [
    // occurred_at is in the key because it is the partition key.
    primaryKey({ columns: [table.orgId, table.occurredAt, table.id] }),
    index('audit_log_chain_idx').on(table.orgId, table.seq),
    index('audit_log_resource_idx').on(
      table.orgId,
      table.resourceType,
      table.resourceId,
      table.occurredAt.desc(),
    ),
    index('audit_log_actor_idx').on(table.orgId, table.actorId, table.occurredAt.desc()),
  ],
);

/**
 * The tip of each org's chain.
 *
 * Locked `FOR UPDATE` by the trigger, which is what serializes concurrent
 * inserts for one org into a chain rather than a tree.
 */
export const chainHeads = audit.table('chain_heads', {
  orgId: uuid('org_id').primaryKey(),
  seq: bigint('seq', { mode: 'bigint' }).notNull(),
  hash: bytea('hash').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
