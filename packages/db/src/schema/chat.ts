import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from './identity.js';
import { orgs } from './tenancy.js';

/**
 * Chat tables (migration 0017, PLAN.md §3.2; ai/phase-5-chat.md §3.1).
 *
 * As with every schema file here, this is the TypeScript MIRROR of the
 * migration and not its source. Where the two disagree, the migration wins and
 * this file is the bug.
 *
 * Two things this file cannot express, both of which are the point of the
 * migration:
 *
 * 1. The COMPOSITE foreign keys. `messages.channelId` is constrained together
 *    with `orgId` against a unique index on `channels`, and a threaded reply is
 *    constrained on all three of (org, channel, parent) — so a reply cannot be
 *    planted under a message in a different channel even when both ids are
 *    known. Drizzle's `references()` is single-column and represents none of
 *    it. Reading `parentMessageId` below as an ordinary self-reference is
 *    reading the weaker half of the truth.
 *
 * 2. `channels_name_matches_type`, which ties `name` to `type` in one CHECK so
 *    there is no state where a DM carries a name. A named DM is precisely the
 *    row that would let a private conversation appear in a channel browser.
 *
 * ## A DM is a channel, and there is no membership table
 *
 * There is no `dms` table, deliberately (§3.1): a DM is a `channels` row with
 * `type = 'dm'`. A second table would mean a second read path, and the read path
 * for the most private surface in the product would become the least-exercised
 * authorization code in it.
 *
 * There is no `channel_members` table either. Membership is a relation tuple in
 * `authz.relationship_tuples` — (user, 'member', channel:{id}) — so that
 * `can()` decides it, Phase 4's revocation path evicts on it, and Wave 4's guest
 * tuples reuse it. The migration argues this at length; it is the single most
 * surprising thing about this schema and the reason to read that file first.
 */

const chat = pgSchema('chat');

/**
 * Channel types.
 *
 * Mirrors the `channels_type_valid` CHECK in migration 0017, which is the
 * enforcement — this constant is for the router's Zod schema and the service's
 * branching, and it is a copy. Stated that way round on purpose: a value added
 * here without the migration is a write the database refuses at runtime, which
 * is the failure mode worth having.
 */
export const CHANNEL_TYPES = ['public', 'private', 'dm', 'group_dm'] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

export const channels = chat.table(
  'channels',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => orgs.id, { onDelete: 'cascade' }),

    /** One of CHANNEL_TYPES. A CHECK, not an enum — see the migration. */
    type: text('type').notNull(),

    /** Null for DMs, which are named by their participants at render time. */
    name: text('name'),
    topic: text('topic'),

    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),

    /** Archive, not delete (§7.1). Retention is a separate Wave 4 decision. */
    archivedAt: timestamp('archived_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('channels_org_id_key').on(table.orgId, table.id),
    uniqueIndex('channels_org_name_key')
      .on(table.orgId, sql`lower(name)`)
      .where(sql`name IS NOT NULL AND archived_at IS NULL`),
    index('channels_org_type_idx')
      .on(table.orgId, table.type, sql`lower(name)`)
      .where(sql`archived_at IS NULL`),
  ],
);

export const messages = chat.table(
  'messages',
  {
    id: uuid('id').primaryKey(),
    orgId: uuid('org_id').notNull(),
    channelId: uuid('channel_id').notNull(),

    /** Null for a top-level message. One level of nesting, enforced by the
        service — see the migration on why not a trigger. */
    parentMessageId: uuid('parent_message_id'),

    /** Null once the author's account is deleted; the message survives. */
    authorId: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),

    /** TipTap JSON, never HTML — CLAUDE.md rule 4. Validated against the closed
        node/mark whitelist before it reaches this column. */
    body: jsonb('body').notNull(),

    /** The same content flattened, so a notification consumer resolving
        @mentions never has to walk TipTap JSON. Never rendered. */
    bodyText: text('body_text').notNull(),

    editedAt: timestamp('edited_at', { withTimezone: true }),

    /** A tombstone, not a row removal: a thread that loses its middle becomes
        incoherent. */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    /** Whether the author withdrew it or a moderator removed it. Constrained
        with `deletedAt` in the migration so the two cannot disagree. */
    deletedByAuthor: boolean('deleted_by_author'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('messages_org_channel_id_key').on(table.orgId, table.channelId, table.id),
    index('messages_channel_idx').on(table.orgId, table.channelId, table.id),
    index('messages_parent_idx')
      .on(table.orgId, table.parentMessageId, table.id)
      .where(sql`parent_message_id IS NOT NULL`),
  ],
);
