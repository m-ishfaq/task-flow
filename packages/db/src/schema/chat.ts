import { sql } from 'drizzle-orm';
import {
  boolean,
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

    /** Archive, not delete (§7.1). Retention is separate — see below. */
    archivedAt: timestamp('archived_at', { withTimezone: true }),

    /** Delete messages older than this many days. NULL means keep forever —
        never a default, see migration 0021. */
    retentionDays: integer('retention_days'),
    /** Blanket legal hold: exempts every message here, including later ones. */
    retentionHold: boolean('retention_hold').notNull().default(false),

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

    /** Auto-created placeholder messages that an upload attaches to. When a
        synthetic carrier is deleted after a failed upload it is excluded from
        messages.list entirely — no tombstone for any participant, ever. */
    isSynthetic: boolean('is_synthetic').notNull().default(false),

    /** Legal hold. Null means not held; a timestamp answers "since when", which
        is the first question asked about one. Checked INSIDE the retention
        delete's WHERE clause, never as a read before it — see migration 0021. */
    heldAt: timestamp('held_at', { withTimezone: true }),
    heldBy: uuid('held_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (table) => [
    uniqueIndex('messages_org_channel_id_key').on(table.orgId, table.channelId, table.id),
    index('messages_channel_idx').on(table.orgId, table.channelId, table.id),
    index('messages_parent_idx')
      .on(table.orgId, table.parentMessageId, table.id)
      .where(sql`parent_message_id IS NOT NULL`),
  ],
);

/**
 * Wave 2 tables (migration 0018, ai/phase-5-chat.md §5).
 *
 * Same composite-FK caveat as `messages` above: each of these ties
 * `(orgId, channelId, messageId)` together against `messages`' own composite
 * unique index in the migration, which Drizzle's single-column `references()`
 * cannot express. Read these as pointing at a message, not as independently
 * enforcing which channel that message is in.
 */
export const messageReactions = chat.table(
  'message_reactions',
  {
    orgId: uuid('org_id').notNull(),
    channelId: uuid('channel_id').notNull(),
    messageId: uuid('message_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    /** A short unicode string — bounded, not restricted to a fixed set (see the migration). */
    emoji: text('emoji').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /* ONE current reaction per person per message (migration 0076): the PK is
       (message_id, user_id), so reacting with a second emoji REPLACES the
       first — a row is a person's reaction slot, not one of their reactions.
       Same-emoji toggle-off and replace-both directions live in the service;
       the constraint is what makes two reactions ever coexisting impossible. */
    primaryKey({ columns: [table.messageId, table.userId] }),
    index('message_reactions_message_idx').on(table.orgId, table.messageId),
  ],
);

export const messageHidden = chat.table(
  'message_hidden',
  {
    orgId: uuid('org_id').notNull(),
    channelId: uuid('channel_id').notNull(),
    messageId: uuid('message_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('message_hidden_user_idx').on(table.orgId, table.userId, table.messageId)],
);

export const pinnedMessages = chat.table(
  'pinned_messages',
  {
    orgId: uuid('org_id').notNull(),
    channelId: uuid('channel_id').notNull(),
    messageId: uuid('message_id').notNull(),

    /** Null once the pinner's account is deleted; the pin survives. */
    pinnedBy: uuid('pinned_by').references(() => users.id, { onDelete: 'set null' }),
    pinnedAt: timestamp('pinned_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.channelId, table.messageId] }),
    index('pinned_messages_channel_idx').on(table.orgId, table.channelId, table.pinnedAt),
  ],
);

/**
 * One row per (channel, user) — "how far this person has read". Deliberately
 * the one write in this phase whose domain event is excluded from the audit
 * projection; see the migration's header comment and
 * `apps/api/src/tenancy/audit.projection.ts`'s `NEVER_AUDITED` set.
 */
export const readCursors = chat.table(
  'read_cursors',
  {
    orgId: uuid('org_id').notNull(),
    channelId: uuid('channel_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    lastReadMessageId: uuid('last_read_message_id').notNull(),
    lastReadAt: timestamp('last_read_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.channelId, table.userId] })],
);

/**
 * Link previews (migration 0020).
 *
 * Every value here except the ids came from a THIRD-PARTY SERVER, fetched
 * because someone pasted a link. Rendered as text, never as markup, and
 * `imageUrl` is re-checked against the outbound-URL rules before a browser is
 * asked to load it. The migration argues both at length.
 */
export const messageUnfurls = chat.table(
  'message_unfurls',
  {
    orgId: uuid('org_id').notNull(),
    channelId: uuid('channel_id').notNull(),
    messageId: uuid('message_id').notNull(),

    url: text('url').notNull(),
    /** 'ok' | 'refused' | 'failed' — see the migration. */
    status: text('status').notNull(),

    title: text('title'),
    description: text('description'),
    imageUrl: text('image_url'),
    siteName: text('site_name'),

    fetchedAt: timestamp('fetched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.messageId, table.url] }),
    index('message_unfurls_channel_idx').on(table.orgId, table.channelId, table.messageId),
  ],
);

/**
 * Saved messages (migration 0022) — personal, invisible to everyone else.
 *
 * Not a pin: a pin is CHANNEL state the whole channel sees. Separate tables
 * because merging them would mean one row whose audience depends on a column,
 * and every read path would have to filter on it correctly every time.
 */
export const savedMessages = chat.table(
  'saved_messages',
  {
    orgId: uuid('org_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    channelId: uuid('channel_id').notNull(),
    messageId: uuid('message_id').notNull(),
    savedAt: timestamp('saved_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.orgId, table.userId, table.messageId] }),
    index('saved_messages_user_idx').on(table.orgId, table.userId, table.savedAt),
  ],
);
