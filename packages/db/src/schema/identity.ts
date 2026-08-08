import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  inet,
  integer,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Identity tables (migration 0002, PLAN.md §8.1).
 *
 * These definitions are the TypeScript mirror of the migration — Drizzle is used
 * as a query builder here, never to generate or push schema. The migration files
 * are the source of truth, because they are what CI runs up -> down -> up
 * against real Postgres, and because a generated diff cannot express the things
 * that matter (the CHECK constraints, the partial index, the reasoning).
 *
 * If these two ever disagree, the migration wins and this file is the bug.
 */

const identity = pgSchema('identity');

export const users = identity.table(
  'users',
  {
    id: uuid('id').primaryKey(),
    email: text('email').notNull(),
    emailNormalized: text('email_normalized').notNull(),

    /**
     * What to call this person (migration 0019). Null until they set one.
     *
     * Deliberately NOT unique and never an identifier: two people are often
     * called the same thing. Nothing looks a user up by this, and no
     * authorization decision reads it — the unique identifier is
     * `emailNormalized`, and the key every decision uses is `id`.
     *
     * The fallback to the email address lives in the read path rather than in a
     * backfill, so a guessed name never gets written into a column that looks
     * authored. See the migration.
     */
    displayName: text('display_name'),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),

    /** Null for a passkey-only account — never treat null as "no password needed". */
    passwordHash: text('password_hash'),
    passwordUpdatedAt: timestamp('password_updated_at', { withTimezone: true }),

    status: text('status').notNull().default('active'),

    failedLoginCount: integer('failed_login_count').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('users_email_normalized_key').on(table.emailNormalized)],
);

export const sessions = identity.table(
  'sessions',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    /**
     * When a credential was last PROVEN. Refreshing must not advance it, or a
     * stolen refresh token would keep a session permanently eligible for
     * step-up-protected operations.
     */
    authenticatedAt: timestamp('authenticated_at', { withTimezone: true }).notNull(),

    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),

    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: text('revoked_reason'),

    userAgent: text('user_agent'),
    ip: inet('ip'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('sessions_user_active_idx')
      .on(table.userId)
      .where(sql`revoked_at IS NULL`),
  ],
);

export const refreshTokens = identity.table(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    /** SHA-256 of the token. The token itself exists only in the response that issued it. */
    tokenHash: text('token_hash').notNull(),

    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),

    /** Set when exchanged. A rotated token presented again is a replay (§8.1). */
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('refresh_tokens_hash_key').on(table.tokenHash),
    index('refresh_tokens_session_idx').on(table.sessionId),
  ],
);

export const emailVerifications = identity.table(
  'email_verifications',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    /** The address being proven, captured at issue time. */
    email: text('email').notNull(),

    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('email_verifications_hash_key').on(table.tokenHash),
    index('email_verifications_user_idx').on(table.userId),
  ],
);

export const passwordResets = identity.table(
  'password_resets',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),

    requestedIp: inet('requested_ip'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('password_resets_hash_key').on(table.tokenHash),
    index('password_resets_user_idx').on(table.userId),
  ],
);

/**
 * Notification delivery preferences — a category x channel matrix (migration
 * 0027, ai/phase-9-notifications.md §3.3).
 *
 * GLOBAL PER USER, NOT PER ORG, and living in `identity` rather than
 * `platform` because of it — see the migration's own header for why the
 * org-keyed draft did not survive contact with the router (every route
 * reading this needs to be `selfRoute`, and `selfRoute` resolves no org).
 * The shape is `display_name`'s: "yours alone... the same wherever you sign
 * in."
 *
 * `category` groups kinds the same way `PROJECT_SCOPED_PREFIXES` groups
 * events in `apps/realtime/src/event-rooms.ts` — a short, closed, reviewed
 * list (`direct`: mentions, DMs, assignments; `activity`: replies, comments,
 * due reminders), never one row per kind. Absence of a row means the coded
 * default, exactly like `FLAGS`' `defaultValue`.
 *
 * In-app is not in this matrix at all: turning off your own bell is not a
 * preference this phase supports, and leaving it out removes the "every
 * channel is off" edge case entirely.
 */
export const notificationPrefs = identity.table(
  'notification_prefs',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    /** 'direct' | 'activity' — a CHECK, not an enum; see `platform.notifications.kind`. */
    category: text('category').notNull(),
    /** 'email' | 'push' | 'sms' — a CHECK, not an enum. */
    channel: text('channel').notNull(),
    enabled: boolean('enabled').notNull(),

    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.category, table.channel] })],
);
