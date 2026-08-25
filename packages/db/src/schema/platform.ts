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
    /**
     * How many automation hops produced this event (migration 0048).
     *
     * Envelope metadata, in its own column beside the other envelope fields
     * rather than inside `payload` — payloads are per-event `.strict()` schemas
     * owned by their slices, and none of them should have to learn about
     * automation. 0 for every human-initiated mutation.
     */
    causationDepth: integer('causation_depth').notNull().default(0),
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
 * Global feature-flag overrides (migration 0035, ai/phase-12-admin.md §3.8).
 *
 * The store the evaluator never had: `FeatureFlags.evaluate()` takes per-org
 * overrides as an input and nothing persisted them. This is the deliberate
 * narrow first cut — a single GLOBAL override table, no per-org row shape —
 * and the evaluator's `orgOverrides` context parameter stays unused by this
 * wave. `flag_name` is a PRIMARY KEY rather than a foreign key into
 * `FLAGS` (which lives in TypeScript): a row for a retired flag would just
 * be ignored, and the registry is the place flags are removed.
 */
export const flagOverrides = platform.table('flag_overrides', {
  flagName: text('flag_name').primaryKey(),
  value: boolean('value').notNull(),
  setBy: uuid('set_by')
    .notNull()
    .references(() => users.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Platform-wide branding (migration 0073) — one row for the whole
 * deployment. `updatedBy` is nullable, unlike `flagOverrides.setBy`: the row
 * is seeded by the migration itself, before any user exists to reference,
 * and stays NULL until the first real `branding.set` call.
 *
 * `paletteId` names one of a small set of pre-audited accent-color triples
 * defined in application code, never a raw color value — see the migration's
 * own comment on why `apps/web/src/styles.css`'s accent trio is hand-tuned
 * rather than formula-derived.
 */
export const branding = platform.table('branding', {
  id: boolean('id').primaryKey().default(true),
  productName: text('product_name').notNull().default('TaskFlow'),
  logoKey: text('logo_key'),
  faviconKey: text('favicon_key'),
  paletteId: text('palette_id').notNull().default('default'),
  updatedBy: uuid('updated_by').references(() => users.id),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Postgres `bytea`, which Drizzle has no first-class column type for. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

/**
 * The global operator chain (migration 0035, ai/phase-12-admin.md §4).
 *
 * The platform-wide sibling of `audit.auditLog`: every operator action is
 * recorded here, hash-chained under one global head lock. `seq`, `prevHash`
 * and `hash` are assigned by the BEFORE INSERT trigger, never by the caller
 * — the same rule `audit.auditLog`'s own comment states. Inserts omit them.
 */
export const operatorAuditLog = platform.table('operator_audit_log', {
  seq: bigint('seq', { mode: 'number' }).primaryKey(),
  operatorId: uuid('operator_id')
    .notNull()
    .references(() => users.id),
  action: text('action').notNull(),
  target: jsonb('target'),
  /** Null only for the first entry in the chain. Assigned by the trigger. */
  prevHash: bytea('prev_hash'),
  hash: bytea('hash').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One row per operator broadcast send (migration 0083) — the tracking record
 * `broadcast.service.ts` writes alongside the `notifications`/
 * `notificationDeliveries` rows it fans out to the resolved audience.
 */
export const operatorBroadcasts = platform.table('operator_broadcasts', {
  id: uuid('id').primaryKey(),
  operatorId: uuid('operator_id').references(() => users.id, { onDelete: 'set null' }),
  orgId: uuid('org_id')
    .notNull()
    .references(() => orgs.id, { onDelete: 'cascade' }),

  /** 'all' | 'role' | 'user' — a CHECK, not an enum. */
  audienceTarget: text('audience_target').notNull(),
  /** 'owner' | 'admin' | 'member' | 'guest'. Set iff audienceTarget === 'role'. */
  audienceRole: text('audience_role'),
  /** Set iff audienceTarget === 'user'. */
  audienceUserId: uuid('audience_user_id').references(() => users.id, { onDelete: 'set null' }),

  subject: text('subject').notNull(),
  body: text('body').notNull(),

  sendPush: boolean('send_push').notNull().default(true),
  sendEmail: boolean('send_email').notNull().default(false),
  includedInOrgAudit: boolean('included_in_org_audit').notNull().default(true),

  /** The dry-run count, persisted rather than re-derived — see migration 0083. */
  recipientCount: integer('recipient_count').notNull(),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

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
 * Native mobile push (migration 0082, ai/phase-14-mobile.md §9) — the
 * `ExpoPushProvider` counterpart to `pushSubscriptions` above. See that
 * migration's own header for why this is a separate table rather than a
 * widened `pushSubscriptions`: an Expo push token is one opaque string, not
 * a (endpoint, p256dh, auth) triple, and the server holds no key material
 * for it at all.
 */
export const expoPushTokens = platform.table(
  'expo_push_tokens',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    /** Expo's own opaque token format, e.g. "ExponentPushToken[xxxxxxxxxxxx]". */
    expoPushToken: text('expo_push_token').notNull(),

    /** Parsed at registration into something a person recognizes, e.g. "iPhone 15". */
    deviceLabel: text('device_label'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Touched on every successful push — Phase 12's "is this device alive" answer. */
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('expo_push_tokens_user_token_key').on(table.userId, table.expoPushToken)],
);

/**
 * Automation rules (migration 0047, ai/phase-10-automation.md Wave 1).
 *
 * `triggerEvent` is a domain event NAME validated against the live registry at
 * the route, never by a CHECK — a constraint here would be a second copy of the
 * event catalog, and its drift produces a rule that saves cleanly and never
 * fires.
 *
 * `condition` is a `FilterNode` tree stored UNRESOLVED, exactly as
 * `work.views.filter` and `search.searches.query` are, and re-validated on
 * read. `@me` is refused at WRITE time rather than stored: a rule has no
 * viewer, so the symbol would either throw at execution or silently resolve to
 * whoever saved it.
 *
 * `createdBy` is whose permissions the actions run with — re-resolved at
 * EXECUTION, never trusted from save time (§2). Its `ON DELETE CASCADE` is a
 * control rather than housekeeping: a rule outliving its owner is a credential
 * that never expires.
 */
export const automations = platform.table(
  'automations',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),

    name: text('name').notNull(),
    description: text('description'),

    /** A registered domain event name, e.g. `card.status_changed`. */
    triggerEvent: text('trigger_event').notNull(),
    /** A `FilterNode`, or null for "fire on every occurrence". */
    condition: jsonb('condition'),
    /** An array of typed action objects — never a script. 1..10, by CHECK. */
    actions: jsonb('actions').notNull(),

    /** The per-rule half of the kill switch; the org-wide half is `identity.orgs.status`. */
    enabled: boolean('enabled').notNull().default(true),

    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('automations_trigger_idx').on(table.orgId, table.triggerEvent, table.enabled),
    uniqueIndex('automations_org_name_key').on(table.orgId, table.name),
    // Mirrors the migration's `automations_org_id_key` — what the runs table's
    // composite FK references. The migration is the source; this declaration is
    // what lets Drizzle express the relationship at all.
    uniqueIndex('automations_org_id_key').on(table.orgId, table.id),
  ],
);

/**
 * What happened on every rule execution (migration 0047, §3).
 *
 * A row is written even when the condition did NOT match (`skipped`), because
 * "my rule did not fire" is the question this table exists to answer and a
 * history of successes cannot answer it.
 *
 * `eventId` is deliberately NOT a foreign key into `platform.outbox`: Phase 11
 * prunes that table on a retention window, and an FK would either block the
 * prune or cascade away run history it has no business deleting.
 */
export const automationRuns = platform.table(
  'automation_runs',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),

    automationId: uuid('automation_id').notNull(),

    /** The triggering event. Not an FK — see the header. */
    eventId: uuid('event_id').notNull(),
    triggerEvent: text('trigger_event').notNull(),

    /** 'succeeded' | 'failed' | 'refused' | 'skipped' — a CHECK in the migration. */
    status: text('status').notNull(),
    /** Why a run did not proceed, e.g. 'condition_not_met', 'depth_exceeded'. */
    reason: text('reason'),

    /** Per-action outcomes in order: `[{ index, type, status, error? }]`. */
    actionResults: jsonb('action_results').notNull().default([]),

    /** Loop-protection depth at this run — so "why did my chain stop" has an answer. */
    depth: integer('depth').notNull().default(0),

    durationMs: integer('duration_ms'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('automation_runs_recent_idx').on(table.orgId, table.createdAt),
    index('automation_runs_rule_idx').on(table.orgId, table.automationId, table.createdAt),
  ],
);

/**
 * The durable per-org hourly execution budget (migration 0047, §4 layer 3).
 *
 * In Postgres rather than in process, because an in-process counter forgives
 * everyone on restart — which is the state an attacker restarts you to reach.
 * The same argument Phase 13's TURN issuance budget makes.
 *
 * A fixed hour bucket rather than a rolling window, because a bucket is a
 * single upsert under concurrency where a rolling window needs a
 * count-then-write that two workers both pass.
 */
export const automationBudget = platform.table(
  'automation_budget',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    windowHour: timestamp('window_hour', { withTimezone: true }).notNull(),
    executions: integer('executions').notNull().default(0),
  },
  (table) => [primaryKey({ columns: [table.orgId, table.windowHour] })],
);

/**
 * Registered outbound-webhook endpoints (migration 0049,
 * ai/phase-10-automation.md Wave 2).
 *
 * The SIGNING secret is stored encrypted at rest under a PER-WEBHOOK data key
 * (the comms.subaccounts pattern) — the delivery loop must be able to sign,
 * so a hash would make signing impossible, and the secret is shown to the org
 * exactly once at creation. `signingKeyWrapped` + `signingKeyMasterId` name
 * the wrapped key and the master key that unwraps it.
 *
 * `enabled`/`disabledAt` are the endpoint kill switch: the delivery loop
 * auto-disables a dead-lettered endpoint and records when, so an operator can
 * tell an operator's pause from an automated one. `failureCount` is the
 * endpoint's health, kept off the (prunable) delivery history.
 */
export const webhooks = platform.table(
  'webhooks',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),

    name: text('name').notNull(),
    url: text('url').notNull(),

    enabled: boolean('enabled').notNull().default(true),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    failureCount: integer('failure_count').notNull().default(0),

    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    signingKeyCiphertext: bytea('signing_key_ciphertext').notNull(),
    signingKeyWrapped: bytea('signing_key_wrapped').notNull(),
    signingKeyMasterId: text('signing_key_master_id').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('webhooks_org_name_key').on(table.orgId, table.name),
    // Mirrors the migration's `webhooks_org_id_key` — what the deliveries
    // table's composite FK references.
    uniqueIndex('webhooks_org_id_key').on(table.orgId, table.id),
  ],
);

/**
 * The delivery queue behind `call_webhook` (migration 0049).
 *
 * Written by the action's service-layer enqueue (emitting
 * `webhook.delivery_queued`) and drained by a loop in apps/worker. The engine
 * is at-least-once, so the dedupe key `(org_id, webhook_id, event_id)` is what
 * makes a redelivered event harmless — the second insert is a no-op.
 *
 * `status` is a small state machine on one column: `pending -> (succeeded |
 * dead)`. There is deliberately no 'in_flight': the claim is a conditional
 * UPDATE on `attempts` (the recording-ingest pattern), so a worker that dies
 * mid-attempt simply retries — at-least-once, told to deduplicate on the
 * event id. `nextAttemptAt` is the backoff, set on failure, so a dead endpoint
 * stops costing a claim per tick long before it is dead-lettered.
 */
export const webhookDeliveries = platform.table(
  'webhook_deliveries',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    webhookId: uuid('webhook_id').notNull(),

    /** The triggering event. Not an FK — the outbox is pruned in Phase 11. */
    eventId: uuid('event_id').notNull(),
    eventName: text('event_name').notNull(),

    /** The canonical JSON body sent to the receiver, signed with the secret. */
    payload: jsonb('payload').notNull(),

    /** 'pending' | 'succeeded' | 'dead' — a CHECK in the migration. */
    status: text('status').notNull().default('pending'),
    /** Both the retry budget and the claim's optimistic-concurrency token. */
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),

    lastStatusCode: integer('last_status_code'),
    lastError: text('last_error'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('webhook_deliveries_dedupe_key').on(table.orgId, table.webhookId, table.eventId),
    index('webhook_deliveries_due_idx').on(table.status, table.nextAttemptAt, table.createdAt),
  ],
);

/**
 * Programmatic-access tokens (migration 0050, ai/phase-10-automation.md
 * Wave 3, §6).
 *
 * The `tf_pat` credential: long-lived, hashed at rest — `tokenHash` is the
 * lookup key and the plaintext exists exactly once, in the mint response —
 * shown once, and soft-deleted by `revokedAt`. `tokenPrefix` is the first ten
 * characters of the token body, stored at mint so the list view can tell two
 * tokens both called "CI" apart without ever seeing a full token.
 *
 * `scopes` are permission strings from the closed catalog, validated at the
 * route against the minting user's LIVE `can()` (§6.3) and enforced per
 * request as the intersection of this list and the re-resolved `can()`
 * answer (§6.4). A bogus stored scope is inert — which is why the migration
 * puts no CHECK on content: the catalog lives in TypeScript.
 */
export const apiTokens = platform.table(
  'api_tokens',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull(),
    tokenPrefix: text('token_prefix').notNull(),
    scopes: text('scopes').array().notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    /* When the token stops authenticating; NULL = never (migration 0079).
       Enforced at the auth lookup, alongside revocation. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
  },
  (table) => [uniqueIndex('api_tokens_hash_key').on(table.tokenHash)],
);

/**
 * Org↔provider connector rows (migration 0056, ai/phase-10-automation.md §7).
 *
 * One row per (org, provider, provider_scope) — a Slack workspace or a GitHub
 * repository the org has authorized. The row carries the OUTBOUND credential
 * envelope-encrypted under a per-org data key (the webhook secret's recipe:
 * ciphertext + wrapped key + master key id) and, for GitHub only, the per-org
 * inbound verify secret (D4); Slack inbound verification uses the
 * deployment-wide signing secret, so `verify*` stays null there.
 *
 * `status` flips between 'connected'/'disconnected' — a disconnect never
 * deletes the row (migration 0056's REVOKE DELETE, the api_tokens soft-delete
 * shape). The inbound lookup runs as `taskflow_integration_auth`, whose
 * column-level grant excludes `token*` — the role that resolves "who is this
 * webhook for" cannot read anyone's outbound credential.
 */
export const integrations = platform.table(
  'integrations',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),

    /** 'slack' | 'github' — a CHECK, not an enum. */
    provider: text('provider').notNull(),
    /** Human label for the list view: the workspace/repository name. */
    name: text('name').notNull(),
    /** Slack team_id, or GitHub repository full_name. */
    providerScope: text('provider_scope').notNull(),
    /** 'connected' | 'disconnected' — a CHECK, not an enum. */
    status: text('status').notNull().default('connected'),

    /* Nullable since 0057: a disconnect wipes them, and the credential's
       PRESENCE is what tells 'disconnected' (pending repo choice) apart
       from 'disconnected' (revoked). */
    tokenCiphertext: bytea('token_ciphertext'),
    tokenWrapped: bytea('token_wrapped'),
    tokenMasterId: text('token_master_id'),

    verifyCiphertext: bytea('verify_ciphertext'),
    verifyWrapped: bytea('verify_wrapped'),
    verifyMasterId: text('verify_master_id'),

    /** SET NULL, not CASCADE — the row is the org's, not the person's. */
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Mirrors the migration's `integrations_one_scope` UNIQUE constraint.
    uniqueIndex('integrations_one_scope_key').on(table.orgId, table.provider, table.providerScope),
  ],
);

/**
 * The inbound connector delivery dedupe (migration 0058,
 * ai/phase-10-automation.md §7.4).
 *
 * GitHub's replay control: GitHub puts no timestamp inside its webhook
 * signature, so a captured request can be replayed forever — the
 * `X-GitHub-Delivery` id is the ONLY control, and the row is written on
 * SUCCESS inside the handler's own transaction (the nonce-on-success lesson,
 * so a failed attempt rolls the row back and GitHub's retry — which reuses
 * the same delivery id — proceeds normally). Append-only: migration 0058
 * revokes UPDATE and DELETE from `taskflow_app`.
 *
 * Slack does not use this table (its replay control is the five-minute
 * freshness window inside `verifySlackSignature`); the `provider` CHECK
 * restricts it to 'github' so the excluded-provider intent is a database
 * fact.
 */
export const integrationDeliveries = platform.table(
  'integration_deliveries',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    /** 'github' — a CHECK, not an enum; see the header. */
    provider: text('provider').notNull().default('github'),
    /** The raw `X-GitHub-Delivery` header, verbatim. */
    deliveryId: text('delivery_id').notNull(),
    createdAt: timestamp('seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Mirrors the migration's `integration_deliveries_one` UNIQUE constraint.
    uniqueIndex('integration_deliveries_one_key').on(table.orgId, table.provider, table.deliveryId),
  ],
);

/**
 * The operations dashboard's own log (migration 0061).
 *
 * "Did a system action succeed or fail" — mail delivery, a billing webhook,
 * a sweep tick — the different question from `operatorAuditLog` above,
 * which answers "what did a human operator do". No hash chain: nothing
 * here is a decision to hold anyone accountable for. No `orgId` column at
 * all — mail delivery frequently has no org yet (a password reset before
 * one exists), and this table is GLOBAL for the identical reason
 * `operators`/`operatorAuditLog` are.
 */
export const operationalEvents = platform.table(
  'operational_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: text('kind').notNull(),
    outcome: text('outcome').notNull(),
    target: text('target'),
    detail: jsonb('detail'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('operational_events_occurred_at_idx').on(table.occurredAt.desc()),
    index('operational_events_kind_occurred_at_idx').on(table.kind, table.occurredAt.desc()),
  ],
);
