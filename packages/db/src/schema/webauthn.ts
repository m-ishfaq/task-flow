import {
  bigint,
  boolean,
  customType,
  index,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './identity.js';

/**
 * Passkey tables (migration 0003, PLAN.md §8.1).
 *
 * As with identity.ts, the MIGRATION is the source of truth and this is its
 * TypeScript mirror. If they disagree, this file is the bug.
 */

const identity = pgSchema('identity');

/**
 * `bytea` as a `Uint8Array`.
 *
 * Drizzle has no first-class bytea column, and the alternatives are worse than
 * ten lines here: storing base64 in a `text` column means an encode/decode on
 * every read of a value that goes straight into signature verification, and
 * `node-postgres` already hands back a Buffer.
 */
const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType: () => 'bytea',
  fromDriver: (value) => new Uint8Array(value),
  toDriver: (value) => Buffer.from(value),
});

/** Postgres `text[]`. Advisory browser hints; nothing is authorized on them. */
const textArray = customType<{ data: string[]; driverData: string[] }>({
  dataType: () => 'text[]',
});

export const webauthnCredentials = identity.table(
  'webauthn_credentials',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    /** Base64URL as the browser reports it — stored unmodified so no comparison re-encodes. */
    credentialId: text('credential_id').notNull(),

    /** COSE public key. Public by construction; this row's security is its integrity. */
    publicKey: bytea('public_key').notNull(),

    /**
     * Signature counter.
     *
     * Read as a number rather than as bigint's default string: the value is
     * compared arithmetically on every assertion, and a silent string
     * comparison would make '9' > '10'. Well inside Number.MAX_SAFE_INTEGER —
     * an authenticator emitting 2^53 signatures is not a scenario.
     */
    signCount: bigint('sign_count', { mode: 'number' }).notNull().default(0),

    transports: textArray('transports').notNull().default([]),
    aaguid: text('aaguid'),

    /** 'singleDevice' | 'multiDevice'. Constrained by a CHECK in the migration. */
    deviceType: text('device_type').notNull(),
    backedUp: boolean('backed_up').notNull().default(false),

    /** User-chosen label. Shown back to its owner as TEXT, never as HTML. */
    name: text('name'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('webauthn_credentials_credential_id_key').on(table.credentialId),
    index('webauthn_credentials_user_id_idx').on(table.userId),
  ],
);

export const webauthnChallenges = identity.table(
  'webauthn_challenges',
  {
    id: uuid('id').primaryKey(),
    challenge: text('challenge').notNull(),

    /** Null for sign-in: discoverable credentials mean the user is unknown until the assertion. */
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),

    purpose: text('purpose').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),

    /** Set by a conditional UPDATE, so a challenge is usable exactly once. */
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('webauthn_challenges_challenge_key').on(table.challenge)],
);
