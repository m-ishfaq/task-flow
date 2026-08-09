import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
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
import { users } from './identity.js';
import { orgs } from './tenancy.js';

/**
 * Voice & Messaging tables — the Wave 1 safety rails (PLAN.md §3.4, §8.5;
 * ai/phase-7-voice.md §3.1–§3.4, §3.11; migration 0032).
 *
 * As with every other schema file here, this is the TypeScript MIRROR of the
 * migration and not its source. If the two disagree, the migration wins and
 * this file is the bug.
 *
 * The schema is `comms`, created by 0001_schemas. The Phase 7 spec's draft said
 * `telephony.*`; its status header records the correction.
 *
 * Two things this file cannot express, both documented on the migration:
 *
 *   - `subaccountOrgs` has **no RLS**, deliberately. It is the pre-tenant
 *     lookup an unauthenticated webhook needs to find its org before any scope
 *     can be opened, and it holds no secrets so that reading all of it teaches
 *     an attacker nothing but that one opaque id maps to another.
 *   - The `spendLedger` uniqueness on `(org_id, provider_sid)` is PARTIAL
 *     (`WHERE provider_sid IS NOT NULL`), which is what makes the carrier's
 *     billing correction idempotent while still allowing rows that have not
 *     been assigned a carrier id yet.
 */

const comms = pgSchema('comms');

/** `bytea` — Drizzle has no built-in Postgres binary column type. */
const bytea = customType<{ data: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

/**
 * The per-org carrier subaccount (§3.1) — "a leaked credential's blast radius
 * is one tenant" (PLAN.md §8.5).
 *
 * `authTokenCiphertext` is envelope-encrypted under this org's data key. It is
 * NOT how outbound calls authenticate — those use the subaccount SID with the
 * master auth token — it is the key that verifies webhooks Twilio signed with
 * this subaccount's own token. Never select it into a route's output.
 */
export const subaccounts = comms.table(
  'subaccounts',
  {
    orgId: uuid('org_id')
      .primaryKey()
      .references(() => orgs.id, { onDelete: 'cascade' }),

    provider: text('provider').notNull().default('twilio'),
    subaccountSid: text('subaccount_sid').notNull(),

    authTokenCiphertext: bytea('auth_token_ciphertext').notNull(),
    dataKeyWrapped: bytea('data_key_wrapped').notNull(),
    dataKeyMasterId: text('data_key_master_id').notNull(),

    status: text('status').notNull().default('active'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('subaccounts_sid_key').on(table.subaccountSid),
    check('subaccounts_provider_valid', sql`${table.provider} IN ('twilio')`),
    check('subaccounts_status_valid', sql`${table.status} IN ('active', 'suspended', 'closed')`),
  ],
);

/**
 * Carrier SID → org id. No RLS, no secrets (§3.11).
 *
 * Exists to break the chicken-and-egg an inbound webhook creates: the org is
 * only knowable from the AccountSid inside a payload whose signature cannot be
 * checked until the org's token has been read, which needs the org. See the
 * migration's own header for why this beat a dedicated database role.
 */
export const subaccountOrgs = comms.table('subaccount_orgs', {
  subaccountSid: text('subaccount_sid').primaryKey(),
  orgId: uuid('org_id')
    .notNull()
    .references(() => orgs.id, { onDelete: 'cascade' }),
});

/**
 * The per-org spend cap (§3.3, §7.2): 2500 cents over 30 ROLLING days.
 *
 * Rolling rather than calendar, because a calendar reset hands an attacker a
 * fresh budget on a date they can read off a calendar.
 */
export const spendPolicy = comms.table(
  'spend_policy',
  {
    orgId: uuid('org_id')
      .primaryKey()
      .references(() => orgs.id, { onDelete: 'cascade' }),

    capCents: bigint('cap_cents', { mode: 'number' }).notNull().default(2500),
    windowDays: integer('window_days').notNull().default(30),

    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (table) => [
    check('spend_policy_cap_nonnegative', sql`${table.capCents} >= 0`),
    check('spend_policy_window_sane', sql`${table.windowDays} BETWEEN 1 AND 365`),
  ],
);

/**
 * What the cap is computed from (§3.4). Written in the same transaction as the
 * action it prices, never inferred later from the carrier's billing API.
 *
 * `actualCents` is null until the carrier's asynchronous billing callback
 * reports a real figure. The gate sums `COALESCE(actual, estimated)`, so an
 * unreconciled row counts at its conservative estimate rather than as zero —
 * which is the difference between a cap and a report.
 */
export const spendLedger = comms.table(
  'spend_ledger',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),

    kind: text('kind').notNull(),
    estimatedCents: bigint('estimated_cents', { mode: 'number' }).notNull(),
    actualCents: bigint('actual_cents', { mode: 'number' }),

    providerSid: text('provider_sid'),

    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('spend_ledger_org_window_idx').on(table.orgId, table.occurredAt.desc()),
    check(
      'spend_ledger_kind_valid',
      sql`${table.kind} IN ('call', 'sms', 'number_purchase', 'verification')`,
    ),
    check('spend_ledger_estimate_nonnegative', sql`${table.estimatedCents} >= 0`),
    check(
      'spend_ledger_actual_nonnegative',
      sql`${table.actualCents} IS NULL OR ${table.actualCents} >= 0`,
    ),
  ],
);

/* -------------------------------------------------------------------------- *
 * Wave 2 — numbers, calls, recordings, transcripts (migration 0033)
 * -------------------------------------------------------------------------- */

/**
 * The org's own numbers.
 *
 * `e164` is PLAINTEXT, unlike a call's counterparty. These are business numbers
 * the org publishes; they identify a tenant, not a person — and an inbound
 * webhook resolves its org FROM this column, before any scope exists to decrypt
 * within. See migration 0033's header for the full asymmetry.
 */
export const phoneNumbers = comms.table(
  'phone_numbers',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),

    e164: text('e164').notNull(),
    providerSid: text('provider_sid').notNull(),
    isoCountry: text('iso_country').notNull(),

    /** IVR / routing config. Parsed by a Zod schema at both boundaries. */
    inboundRoute: jsonb('inbound_route'),

    purchasedBy: uuid('purchased_by').references(() => users.id, { onDelete: 'set null' }),
    purchasedAt: timestamp('purchased_at', { withTimezone: true }).notNull().defaultNow(),
    releasedAt: timestamp('released_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('phone_numbers_org_id_key').on(table.orgId, table.id),
    index('phone_numbers_org_live_idx').on(table.orgId, table.e164),
  ],
);

/**
 * The call log, and the consent record (§3.5).
 *
 * Two things this file cannot express, both in the migration:
 *
 *   - `counterparty_ciphertext` / `counterparty_index` are a randomized
 *     ciphertext plus a keyed one-way index. The index is what makes equality
 *     lookup possible without storing the number in plaintext or encrypting it
 *     deterministically — both of which are the mistakes it exists to avoid.
 *   - `calls_recording_after_announcement` is a CHECK making it impossible to
 *     record before a required announcement played. A service can be careful
 *     about that ordering; a constraint makes the illegal state unrepresentable.
 */
export const calls = comms.table(
  'calls',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),

    direction: text('direction').notNull(),
    phoneNumberId: uuid('phone_number_id'),

    counterpartyCiphertext: bytea('counterparty_ciphertext').notNull(),
    counterpartyIndex: bytea('counterparty_index').notNull(),

    status: text('status').notNull().default('queued'),
    providerSid: text('provider_sid'),

    placedBy: uuid('placed_by').references(() => users.id, { onDelete: 'set null' }),

    startedAt: timestamp('started_at', { withTimezone: true }),
    answeredAt: timestamp('answered_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    durationSeconds: integer('duration_seconds'),

    consentRule: text('consent_rule'),
    consentBasis: text('consent_basis'),
    announcementRequired: boolean('announcement_required').notNull().default(true),
    announcementPlayedAt: timestamp('announcement_played_at', { withTimezone: true }),
    recordingStartedAt: timestamp('recording_started_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('calls_org_id_key').on(table.orgId, table.id),
    index('calls_org_recent_idx').on(table.orgId, table.createdAt.desc()),
    index('calls_counterparty_idx').on(table.orgId, table.counterpartyIndex),
  ],
);

/**
 * Recordings, ingested into this org's own storage (§3.6).
 *
 * `status` is the same shape as `work.attachments`' scan pipeline and for the
 * same reason: `presignDownload` is called for exactly ONE value of it. What
 * differs is the direction of trust — a recording arrives from the carrier over
 * a signed callback rather than from an untrusted browser, so there is no
 * magic-byte or AV step. A presigned URL being the only door carries over.
 */
export const recordings = comms.table(
  'recordings',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    callId: uuid('call_id').notNull(),

    providerSid: text('provider_sid').notNull(),
    /** The carrier's copy. Read once by the ingest sweep, never sent to a client. */
    providerUrl: text('provider_url'),

    status: text('status').notNull().default('pending'),
    storageKey: text('storage_key'),
    bytes: bigint('bytes', { mode: 'number' }),
    durationSeconds: integer('duration_seconds'),

    lastError: text('last_error'),
    attempts: integer('attempts').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    storedAt: timestamp('stored_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('recordings_org_id_key').on(table.orgId, table.id),
    uniqueIndex('recordings_provider_sid_key').on(table.orgId, table.providerSid),
  ],
);

/**
 * Transcripts — redacted BEFORE the insert (§3.7).
 *
 * There is no `rawText` column, and its absence is the control: a schema with
 * somewhere to put the unredacted text is a schema where somebody eventually
 * does, and the window between writing it and redacting it is exactly what
 * "before storage" forbids.
 */
export const transcripts = comms.table(
  'transcripts',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    recordingId: uuid('recording_id').notNull(),

    text: text('text').notNull(),
    language: text('language'),
    /** Which rules fired and how often — never what they matched. */
    redactionCounts: jsonb('redaction_counts').notNull().default({}),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('transcripts_recording_key').on(table.orgId, table.recordingId)],
);

/* -------------------------------------------------------------------------- *
 * Wave 3 — SMS threads, suppressions, recording attachments (migration 0034)
 * -------------------------------------------------------------------------- */

/**
 * An SMS conversation with someone who is not a user of this system (§3.8).
 *
 * NOT a `chat.channels` row, and the migration's header explains at length why:
 * a channel assumes every participant is an org member with a `UserId` and a
 * relationship tuple, and an SMS thread's other party is a phone number. The
 * Chat inbox reads BOTH tables to render one merged list — a read-side
 * aggregation, not a write-side reuse.
 *
 * `channel` allows only `'sms'` today. WhatsApp is deferred (§7.3) because Meta
 * approval is outside this codebase's control, but the column exists now so
 * adding it later widens one CHECK rather than retrofitting a discriminator.
 */
export const messageThreads = comms.table(
  'message_threads',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),

    channel: text('channel').notNull().default('sms'),
    phoneNumberId: uuid('phone_number_id').notNull(),

    counterpartyCiphertext: bytea('counterparty_ciphertext').notNull(),
    counterpartyIndex: bytea('counterparty_index').notNull(),

    lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
    /** Recomputed, never incremented — work/counters.ts' reasoning. */
    unreadCount: integer('unread_count').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /* THE threading key. Without it two inbound messages arriving close
       together each create their own thread, and the symptom is a duplicated
       conversation that reads as a UI bug. */
    uniqueIndex('message_threads_participant_key').on(
      table.orgId,
      table.phoneNumberId,
      table.counterpartyIndex,
      table.channel,
    ),
    uniqueIndex('message_threads_org_id_key').on(table.orgId, table.id),
    index('message_threads_inbox_idx').on(table.orgId, table.lastMessageAt.desc()),
  ],
);

/**
 * One SMS.
 *
 * `body` is PLAINTEXT while the thread's counterparty number is encrypted, and
 * the asymmetry is deliberate — see migration 0034's header. Short version: a
 * phone number is an identifier monetizable on its own and in a predictable
 * format; a body is content the org must read, list, and search, and its
 * protection is RLS plus `sms:read` — the same protection the chat message next
 * to it in the same inbox has.
 */
/**
 * Exported as `smsMessages`, not `messages` — `chat.js` already exports a
 * `messages` table (Phase 5), and `export *`-ing both from
 * `schema/index.ts` under the same name is an ambiguity `tsc` refuses to
 * resolve silently (TS2308). The underlying table name stays `messages`;
 * only the JS binding differs, so the migration is unaffected.
 */
export const smsMessages = comms.table(
  'messages',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    threadId: uuid('thread_id').notNull(),

    direction: text('direction').notNull(),
    body: text('body').notNull(),
    status: text('status').notNull().default('queued'),
    providerSid: text('provider_sid'),
    segments: integer('segments').notNull().default(1),

    sentBy: uuid('sent_by').references(() => users.id, { onDelete: 'set null' }),
    errorCode: text('error_code'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  },
  (table) => [index('messages_thread_idx').on(table.orgId, table.threadId, table.createdAt.desc())],
);

/**
 * STOP/UNSUBSCRIBE, honored permanently and at ORG level (§8.5).
 *
 * Org-level rather than per-thread: someone who texts STOP has opted out of
 * hearing from the organization, not from one of its numbers — keying it on the
 * thread would let the next number the org buys start messaging them again.
 *
 * There is no expiry and nothing deletes a row. An opt-back-in sets
 * `revokedAt`, so the record that someone once opted out survives the moment
 * they changed their mind.
 */
export const suppressions = comms.table(
  'suppressions',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),

    counterpartyCiphertext: bytea('counterparty_ciphertext').notNull(),
    counterpartyIndex: bytea('counterparty_index').notNull(),

    reason: text('reason').notNull().default('stop_keyword'),
    suppressedAt: timestamp('suppressed_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [index('suppressions_lookup_idx').on(table.orgId, table.counterpartyIndex)],
);

/**
 * Recordings attached to Work cards (§3.9, §7.5 — resolved as MANY).
 *
 * Both sides carry `org_id` and reference COMPOSITE keys in the migration, so a
 * recording can never be attached to another tenant's card even if application
 * code got it wrong. §3.9's point exactly: the FK is the enforcement, not a
 * service-level lookup a second call site could forget.
 */
export const recordingCards = comms.table(
  'recording_cards',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    recordingId: uuid('recording_id').notNull(),
    cardId: uuid('card_id').notNull(),

    attachedBy: uuid('attached_by').references(() => users.id, { onDelete: 'set null' }),
    attachedAt: timestamp('attached_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.recordingId, table.cardId] }),
    index('recording_cards_card_idx').on(table.orgId, table.cardId),
  ],
);

/**
 * Webhook replay protection (§3.11).
 *
 * Recorded on SUCCESS, inside the handler's own transaction — not on receipt.
 * Twilio retries a webhook when we answer 5xx, and a retry carries a
 * byte-identical signature, so a nonce written on receipt would reject the
 * very retry that exists to recover the event.
 */
export const webhookNonces = comms.table(
  'webhook_nonces',
  {
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    signature: text('signature').notNull(),
    seenAt: timestamp('seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.signature] }),
    index('webhook_nonces_seen_at_idx').on(table.seenAt),
  ],
);
