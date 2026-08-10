import { sql } from 'drizzle-orm';
import {
  boolean,
  customType,
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

/** `bytea` — Drizzle has no built-in mapping; mirrors packages/db/src/schema/platform.ts's own. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

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

/**
 * Ringing preferences (migration 0042, ai/phase-13-webrtc.md §7).
 *
 * GLOBAL PER USER and in `identity` rather than `rtc`, for the reason
 * `notificationPrefs` above gives at length: every route reading it must be a
 * `selfRoute` (no permission describes "choose your own ringtone", and a guest
 * must be able to), and `selfRoute` resolves no org — so an org-keyed row would
 * have no org to key it by.
 *
 * `ringtone` names one of a closed set the CLIENT synthesizes with Web Audio
 * oscillators. There is deliberately no audio file anywhere in this system: no
 * asset to host, no upload path to secure, and no way for this column to become
 * a URL somebody's browser fetches.
 */
export const callPrefs = identity.table('call_prefs', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** One of RINGTONES — a CHECK, not an enum. See the migration. */
  ringtone: text('ringtone').notNull().default('classic'),
  /**
   * Ring audibly at all.
   *
   * Distinct from muting notifications: somebody in an open-plan office wants
   * the popup and not the sound, and folding the two together would make "stop
   * the noise" mean "stop telling me".
   */
  ringEnabled: boolean('ring_enabled').notNull().default(true),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * The identity-scoped data key (Phase 12 Wave 2, migration 0040, §3.2).
 *
 * A singleton row, created by application code at boot — never by a
 * migration, which has no access to KeyProvider or the master key a real
 * wrap requires. Encrypts identity.totp_credentials.secret_encrypted and
 * (once OAuth ships) an OAuth refresh token, if one is ever stored.
 */
export const secretKeys = identity.table('secret_keys', {
  id: boolean('id').primaryKey().default(true),
  wrappedKey: bytea('wrapped_key').notNull(),
  masterKeyId: text('master_key_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * TOTP as a second factor (migration 0040, §3.2).
 *
 * `confirmedAt IS NULL` means enrolled but never proven with a real code —
 * unusable for login or step-up. `secretEncrypted` is ciphertext under
 * `secretKeys`' data key, never plaintext.
 */
export const totpCredentials = identity.table('totp_credentials', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  secretEncrypted: bytea('secret_encrypted').notNull(),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** One-time TOTP recovery codes, Argon2id-hashed like `users.passwordHash`. */
export const totpRecoveryCodes = identity.table(
  'totp_recovery_codes',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('totp_recovery_codes_user_idx').on(table.userId)],
);

/**
 * OAuth account linking (migration 0040, §3.3).
 *
 * `providerUserId` is the provider's own stable subject id, never the email
 * — an email can change at the provider, a subject id does not.
 */
export const oauthIdentities = identity.table(
  'oauth_identities',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** 'google' | 'github' — a CHECK, not an enum. */
    provider: text('provider').notNull(),
    providerUserId: text('provider_user_id').notNull(),
    /** Captured at link time, display only — never re-derives `users.email`. */
    email: text('email').notNull(),
    linkedAt: timestamp('linked_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('oauth_identities_provider_key').on(table.provider, table.providerUserId),
    uniqueIndex('oauth_identities_user_provider_key').on(table.userId, table.provider),
  ],
);
