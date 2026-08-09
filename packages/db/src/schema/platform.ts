import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  customType,
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

/**
 * In-app notifications (migration 0022, widened by 0027 for Phase 9).
 *
 * ## No longer chat-only
 *
 * PLAN.md put digests, per-channel preferences, and email/push delivery in a
 * later phase, and this table shipped deliberately narrow ahead of it: a
 * record that somebody was mentioned or sent a direct message, so they can
 * find out without opening every channel. Migration 0027 is Phase 9 doing the
 * ADDING 0022's own header anticipated — Work (`card.assigned`,
 * `card.comment_mention`) and Docs (`page.comment_mention`) kinds, on the same
 * row shape, for the identical reasons chat needed it.
 *
 * ## One row per RECIPIENT
 *
 * A message naming three people writes three rows. A single row with a
 * recipients array would make "mark as read" a rewrite of a row two people
 * share, and "my unread count" a query that cannot use an index.
 *
 * ## `subject_id` has no foreign key, on purpose
 *
 * A notification about a message (or a card, or a page) must survive that
 * subject being deleted — otherwise a retention sweep or an archive silently
 * erases the record that somebody was told something, which is the opposite
 * of what a notification is for. The `title`/`excerpt` snapshot exists for the
 * same reason, and for a second one: rendering the list must not re-read a
 * channel or board the person has since been removed from.
 */
export const notifications = platform.table(
  'notifications',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id').notNull(),
    userId: uuid('user_id').notNull(),

    /**
     * 'chat.mention' | 'chat.direct' | 'chat.thread_reply' | 'card.assigned' |
     * 'card.comment_mention' | 'card.due_soon' | 'page.comment_mention' — a
     * CHECK, not an enum (0027 widened it; a widened CHECK is one constraint
     * swap, an enum would need its own migration ceremony per value).
     */
    kind: text('kind').notNull(),

    /** Polymorphic, like `attachments`. No FK — see the note above. */
    subjectType: text('subject_type').notNull(),
    subjectId: uuid('subject_id').notNull(),

    /**
     * Where clicking a CHAT notification should navigate. No FK, for the same
     * reason `subjectId` has none — a channel can be archived without erasing
     * the record that someone was told something. Null for every non-chat
     * kind.
     */
    channelId: uuid('channel_id'),

    /**
     * Where clicking a CARD notification should navigate (0027). The board
     * route is `/boards/$boardId?card=$cardId` — `boardId` is a path param,
     * not derivable from `subjectId` (the card id) alone client-side, so it
     * is stored the same way `channelId` already is. Docs needs no equivalent
     * column: `/docs?page=$pageId` opens a page from its id alone. Null for
     * every non-card kind.
     */
    boardId: uuid('board_id'),

    /** A snapshot of what the recipient was entitled to see when they were told. */
    title: text('title').notNull(),
    excerpt: text('excerpt'),

    actorId: uuid('actor_id'),

    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('notifications_user_idx').on(table.orgId, table.userId, table.createdAt),
    index('notifications_unread_idx')
      .on(table.orgId, table.userId)
      .where(sql`read_at IS NULL`),
    /* One per person per event. The projection is an at-least-once consumer and
       CAN redeliver a batch after a crash; this is what makes that harmless
       rather than duplicating somebody's bell. */
    uniqueIndex('notifications_event_user_key').on(
      table.orgId,
      table.subjectId,
      table.userId,
      table.kind,
    ),
  ],
);

/**
 * Delivery tracking, one row per (notification, channel) (migration 0027,
 * ai/phase-9-notifications.md §3.2).
 *
 * Separate from `notifications.readAt` on purpose: "did the recipient open
 * the bell entry" and "did the email send" are independent facts with
 * independent failure modes — an email can bounce after the in-app row is
 * already correctly marked unread, and marking the bell read must never look
 * like a resend. `status` is a state machine on one column, the same shape
 * `attachments.status` already uses for its own pipeline; `suppressed` is its
 * own state rather than silence, because "why didn't I get an email" needs to
 * see that a decision was made.
 *
 * The in-app channel gets no row here — the `notifications` insert itself IS
 * the in-app delivery, in the same transaction.
 */
export const notificationDeliveries = platform.table(
  'notification_deliveries',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    notificationId: uuid('notification_id')
      .notNull()
      .references(() => notifications.id, { onDelete: 'cascade' }),

    /** 'email' | 'push' | 'sms' — a CHECK, not an enum. */
    channel: text('channel').notNull(),
    /** 'pending' | 'sent' | 'failed' | 'suppressed' — a CHECK, not an enum. */
    status: text('status').notNull().default('pending'),
    /** Set only when `status = 'suppressed'`. Null otherwise. */
    reason: text('reason'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('notification_deliveries_notification_idx').on(table.notificationId),
    index('notification_deliveries_pending_idx')
      .on(table.orgId, table.userId, table.channel)
      .where(sql`status = 'pending'`),
    uniqueIndex('notification_deliveries_once').on(table.notificationId, table.channel),
  ],
);

/**
 * Web-push device rows (migration 0029, ai/phase-9-notifications.md §3.7).
 *
 * Shaped as a DEVICE row, not a bare `(endpoint, keys)` credential, because
 * PLAN.md §13's Phase 12 row names this table as a source for its
 * device/session inventory screen — `userAgentLabel`, `createdAt` and
 * `lastSeenAt` are what that screen reads, and shipping them now means Phase
 * 12 starts from this table rather than building a parallel device concept.
 *
 * The key material (`endpoint`, `p256dh`, `auth`) is protected by RLS and by
 * being unreachable without a valid session only — the §7.3 decision, made
 * 2026-08-08: an attacker who can read these rows already holds the VAPID
 * private key the server signs with, so envelope-encrypting them with the
 * same server-held master key defends against a threat the system cannot
 * survive anyway. See the migration's own header for the full argument.
 *
 * Global per user, like `identity.notification_prefs` — a subscription
 * belongs to a person, not to an org, so the self-scoped RLS policies key on
 * `app.user_id` (the `push_subscriptions_self_*` pair, mirroring 0027's
 * prefs policies). `taskflow_audit` holds SELECT/UPDATE/DELETE here for the
 * push relay: read endpoints to send, touch `lastSeenAt`, drop endpoints the
 * push service reports gone. No INSERT — registering a device is always a
 * person's own act through the application role.
 */
export const pushSubscriptions = platform.table(
  'push_subscriptions',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    /** The browser's subscription endpoint (e.g. an FCM or Mozilla push URL). */
    endpoint: text('endpoint').notNull(),
    /** base64url, 65 bytes — the P-256 public key in uncompressed point form. */
    p256dh: text('p256dh').notNull(),
    /** base64url, 16 bytes — the subscription's authentication secret. */
    auth: text('auth').notNull(),

    /** Parsed at registration into something a person recognizes, e.g. "Chrome on macOS". */
    userAgentLabel: text('user_agent_label'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Touched on every successful push — Phase 12's "is this device alive" answer. */
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('push_subscriptions_user_endpoint_key').on(table.userId, table.endpoint)],
);

/**
 * Platform operators (migration 0032, Phase 12 §3.1).
 *
 * A flat flag, not a role: everyone in this table can do everything the
 * platform-admin console offers. No RLS — this is not tenant data, the same
 * reasoning `identity.users` rests on. `taskflow_app` holds SELECT only
 * (`isPlatformOperator`'s own read); no role reachable from application code
 * holds INSERT/UPDATE/DELETE, ever — see migration 0032's own header for why
 * that is a stricter answer than every other cross-tenant role in this
 * system gets.
 */
export const operators = platform.table('operators', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  grantedBy: uuid('granted_by')
    .notNull()
    .references(() => users.id),
  grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
  note: text('note').notNull(),
});

/**
 * The global feature-flag override store (migration 0032, Phase 12 §3.8).
 *
 * `packages/feature-flags`' evaluator has always modelled `orgOverrides` as
 * its highest-precedence input; nothing ever persisted one anywhere. This is
 * that missing store — global only, no per-org row shape yet (a real,
 * named, out-of-scope follow-up, not an oversight).
 */
export const flagOverrides = platform.table('flag_overrides', {
  flagName: text('flag_name').primaryKey(),
  value: boolean('value').notNull(),
  setBy: uuid('set_by')
    .notNull()
    .references(() => users.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Postgres `bytea`, which Drizzle has no first-class column type for — the identical
 *  helper `schema/audit.ts` defines for its own hash columns, module-private there
 *  and so redefined here rather than imported. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

/**
 * The operator audit chain's singleton head row (migration 0032, Phase 12
 * §4) — mirrors `audit.chain_heads`' shape but keyed on nothing, because
 * there is exactly one operator population to account for, not one per org.
 */
export const operatorChainHead = platform.table('operator_chain_head', {
  id: boolean('id').primaryKey().default(true),
  seq: bigint('seq', { mode: 'bigint' }).notNull(),
  hash: bytea('hash').notNull(),
});

/**
 * The operator accountability log (migration 0032, Phase 12 §4).
 *
 * Every `platformAdmin.*` call — read or write, org-scoped or not — writes a
 * row here, in addition to whatever it writes into the target org's own
 * `audit.audit_log` (§3.10's Audit tab is this table). `seq`, `prev_hash`
 * and `hash` are assigned by `platform.operator_chain_entry()` under the
 * head-row lock above, so a writer cannot choose its own position or digest
 * — the identical guarantee `audit.audit_log`'s trigger gives migration
 * 0007's chain.
 */
export const operatorAuditLog = platform.table(
  'operator_audit_log',
  {
    /** Assigned entirely by the trigger, under the head-row lock — see migration 0032's own note. */
    seq: bigint('seq', { mode: 'bigint' }).primaryKey(),
    operatorId: uuid('operator_id')
      .notNull()
      .references(() => users.id),
    action: text('action').notNull(),
    /** `{ orgId }` or `{ userId }`, or null for a bare list call. */
    target: jsonb('target'),
    prevHash: bytea('prev_hash'),
    hash: bytea('hash').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('operator_audit_log_operator_idx').on(table.operatorId, table.occurredAt.desc())],
);
