import {
  bigint,
  index,
  integer,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './identity.js';
import { orgs } from './tenancy.js';

/**
 * In-app voice tables (migration 0041; ai/phase-13-webrtc.md §3.5–§3.7).
 *
 * As with every schema file here, this is the TypeScript MIRROR of the migration
 * and not its source. Where the two disagree, the migration wins and this file
 * is the bug.
 *
 * Three things this file cannot express, and all three are the point of the
 * migration:
 *
 * 1. **The participant cap is a CHECK.** `joined_count <= max_participants` is
 *    enforced by Postgres, so the (N+1)th concurrent join is refused by the
 *    database rather than by a count-then-insert two callers can both pass.
 *    Drizzle shows two integers with no relationship between them.
 *
 * 2. **The COMPOSITE foreign keys.** A session references
 *    `chat.channels (org_id, id)`, and participants and issuance rows reference
 *    `rtc.sessions (org_id, id)`. Drizzle's `references()` is single-column, so
 *    reading `channelId` below as a plain uuid is reading the weaker half of the
 *    truth: what the database actually refuses is a session naming a channel in
 *    another tenant.
 *
 * 3. **`sessions_one_live_per_channel`** — a PARTIAL unique index
 *    (`WHERE status <> 'ended'`), which is what stops two people pressing "call"
 *    in the same DM from creating two sessions that ring past each other.
 *
 * ## `participants` is a record, not an authorization input
 *
 * §1 of the spec, and the most important sentence in this phase: a call is
 * joinable by precisely those who can read its channel, decided by `can()`
 * against a `channelTarget`. Reading this table to answer "may this person join"
 * would be the `participantIds.includes(userId)` shortcut Phase 5 §3.3 forbids,
 * rebuilt in a new schema. It answers "what happened", never "what is allowed".
 */

const rtc = pgSchema('rtc');

/**
 * Session kinds. Mirrors the `sessions_kind_valid` CHECK in 0041, which is the
 * enforcement — this constant is for Zod schemas and service branching, and it
 * is a copy. `video` is accepted by the database already so Wave 3 is a route
 * change rather than a migration on a live table.
 */
export const RTC_SESSION_KINDS = ['audio', 'video'] as const;
export type RtcSessionKind = (typeof RTC_SESSION_KINDS)[number];

/** Mirrors `sessions_status_valid`. `ended` is terminal. */
export const RTC_SESSION_STATUSES = ['ringing', 'active', 'ended'] as const;
export type RtcSessionStatus = (typeof RTC_SESSION_STATUSES)[number];

/** Mirrors `participants_state_valid`. */
/**
 * Mirrors `sessions_recording_state_valid` (migration 0042).
 *
 * `active` is reachable only when every joined participant has consented —
 * `sessions_recording_needs_consent` is a CHECK, so that is a property of the
 * database rather than of the service that writes it.
 */
export const RTC_RECORDING_STATES = ['none', 'pending', 'active', 'stopped'] as const;
export type RtcRecordingState = (typeof RTC_RECORDING_STATES)[number];

/** The ringtones `identity.call_prefs.ringtone` accepts. Synthesized, never files. */
export const RINGTONES = ['classic', 'chime', 'pulse', 'marimba', 'digital'] as const;
export type Ringtone = (typeof RINGTONES)[number];

export const RTC_PARTICIPANT_STATES = [
  'invited',
  'joined',
  'left',
  'declined',
  'missed',
] as const;
export type RtcParticipantState = (typeof RTC_PARTICIPANT_STATES)[number];

export const rtcSessions = rtc.table(
  'sessions',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),

    /**
     * The channel this call belongs to. Composite-referenced with `orgId` in the
     * migration — see note 2 above; this declaration alone does not say so.
     */
    channelId: uuid('channel_id').notNull(),

    /** One of RTC_SESSION_KINDS. */
    kind: text('kind').notNull().default('audio'),
    /** One of RTC_SESSION_STATUSES. */
    status: text('status').notNull().default('ringing'),

    initiatedBy: uuid('initiated_by')
      .notNull()
      .references(() => users.id),

    /** The mesh cap for THIS session, fixed at creation. */
    maxParticipants: integer('max_participants').notNull(),
    /** Bounded by `maxParticipants` in the database — see note 1 above. */
    joinedCount: integer('joined_count').notNull().default(0),

    /**
     * Recording state (migration 0042). One of RTC_RECORDING_STATES.
     *
     * `active` is unreachable unless `consentCount >= joinedCount` — a CHECK
     * constraint, not a service branch. Drizzle shows three unrelated columns;
     * the migration is where the relationship between them lives.
     */
    recordingState: text('recording_state').notNull().default('none'),
    recordingRequestedBy: uuid('recording_requested_by').references(() => users.id),
    recordingStartedAt: timestamp('recording_started_at', { withTimezone: true }),
    /** How many CURRENTLY JOINED participants have agreed to be recorded. */
    consentCount: integer('consent_count').notNull().default(0),

    /** When it became a conversation, not when it started ringing. */
    startedAt: timestamp('started_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    /** 'hung_up' | 'declined' | 'no_answer' | 'empty' | 'org_suspended' */
    endReason: text('end_reason'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('sessions_org_created_idx').on(table.orgId, table.createdAt)],
);

export const rtcParticipants = rtc.table(
  'participants',
  {
    sessionId: uuid('session_id').notNull(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    /** One of RTC_PARTICIPANT_STATES. */
    state: text('state').notNull().default('invited'),

    invitedAt: timestamp('invited_at', { withTimezone: true }).notNull().defaultNow(),
    joinedAt: timestamp('joined_at', { withTimezone: true }),
    leftAt: timestamp('left_at', { withTimezone: true }),

    /**
     * This person's own recording decision (migration 0042).
     *
     * Three-valued by construction: both null is "not asked / not answered",
     * a consent timestamp is "agreed", a declined timestamp is "refused". A
     * single boolean would collapse the first and third, and those are the two
     * a compliance review most needs to tell apart.
     */
    recordingConsentAt: timestamp('recording_consent_at', { withTimezone: true }),
    recordingDeclinedAt: timestamp('recording_declined_at', { withTimezone: true }),
  },
  (table) => [primaryKey({ columns: [table.sessionId, table.userId] })],
);

/**
 * Every TURN credential this deployment has minted (§3.4).
 *
 * The durable half of the gate. One row per credential MINTED — never one per
 * request, so a refused request cannot consume the budget it was refused
 * against. In Postgres rather than in process because an in-memory counter
 * forgives everyone on restart, which is the state an attacker restarts you to
 * reach; the same relationship `comms.spend_ledger` has to the telephony
 * velocity limiter.
 */
export const rtcTurnIssuance = rtc.table(
  'turn_issuance',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    /**
     * How long the minted credential was good for. Recorded so an incident
     * review can bound the window a leaked credential was usable in without
     * having to know what the configured TTL was on the day it was issued.
     */
    ttlSeconds: integer('ttl_seconds').notNull(),

    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('turn_issuance_org_window_idx').on(table.orgId, table.issuedAt)],
);

/**
 * One stored capture of a call (migration 0042).
 *
 * `storageKey` is SERVER-GENERATED and nothing from a client reaches it — the
 * identical rule Phase 3's attachments settled, because a filename in a key
 * would need path escaping, which is a traversal this design removes rather
 * than mitigates.
 *
 * `status` is the attachment pipeline's state machine for the attachment
 * pipeline's reason: the object exists in storage the moment the browser's PUT
 * finishes and nothing can prevent that, so what the service controls is
 * whether anyone is ever handed a URL to it.
 */
export const rtcRecordings = rtc.table(
  'recordings',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),
    sessionId: uuid('session_id').notNull(),

    /** 'pending' | 'stored' | 'failed'. */
    status: text('status').notNull().default('pending'),

    storageKey: text('storage_key').notNull(),
    contentType: text('content_type').notNull(),
    bytes: bigint('bytes', { mode: 'number' }),
    durationSeconds: integer('duration_seconds'),

    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    storedAt: timestamp('stored_at', { withTimezone: true }),
  },
  (table) => [index('recordings_org_session_idx').on(table.orgId, table.sessionId)],
);
