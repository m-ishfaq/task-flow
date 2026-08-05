import { z } from 'zod';
import { ChannelIdSchema, MessageIdSchema, UserIdSchema } from '@taskflow/contracts';
import { route, router } from '../trpc/builder.js';
import { subjectOf } from '../trpc/context.js';
import { RichTextDocument } from '../work/richtext.js';
import type { ChatActor } from './shared.js';
import * as channels from './channel.service.js';
import * as messages from './message.service.js';
import * as reactions from './reaction.service.js';
import * as pins from './pin.service.js';
import * as readCursors from './read-cursor.service.js';

/**
 * Chat routes (PLAN.md §3.2, §13 phase 5).
 *
 * Every route here is permission-bearing — no `publicRoute`, no `selfRoute`, and
 * there should never be one. Nothing in Chat can be done by someone who is not
 * already acting inside an organization.
 *
 * ## The permission on a route is layer 1, and for chat it is unusually weak
 *
 * `route({ permission })` is the ORG-LEVEL gate. For Work that gate does most of
 * the work, because a member holding `card:read` really can read the org's
 * cards. For Chat it barely narrows anything: every member holds `channel:read`
 * and `message:create`, because they hold them for PUBLIC channels — so the gate
 * passes for a private channel and a DM too.
 *
 * Layer 2 is where chat is actually decided, in the service, once the channel
 * row is loaded and `can()` can be told the channel is closed (§3.3). Reading a
 * permission here and concluding that a member may post in any channel would be
 * reading layer 1 as though it were the whole check. That is worth stating
 * loudly because on this router it is a much more tempting misreading than it
 * was on Work's.
 */

const ChannelName = z
  .string()
  .trim()
  .min(1)
  .max(80)
  /* Mirrors nothing in the database — the CHECK constraint bounds length, not
     shape. A leading '#' is stripped rather than rejected because people type
     it out of habit from every other chat product, and a form that refuses is
     annoying where a form that normalizes is not. */
  .transform((value) => value.replace(/^#+/, '').trim())
  .pipe(z.string().min(1, 'A channel needs a name.').max(80));

const ChannelTopic = z.string().trim().max(500).nullable().default(null);

/**
 * The message list's shape.
 *
 * `body` is `z.unknown()` rather than `RichTextDocument`. The document was
 * validated on the way IN and stored; re-validating on the way out would mean a
 * document written by an older build with a node this build has since removed
 * makes the whole channel unreadable rather than one message unrenderable.
 * Input is where a closed whitelist belongs.
 */
const MessageOutput = z
  .array(
    z.object({
      messageId: z.string(),
      channelId: z.string(),
      parentMessageId: z.string().nullable(),
      authorId: z.string().nullable(),
      body: z.unknown(),
      bodyText: z.string(),
      editedAt: z.date().nullable(),
      deletedAt: z.date().nullable(),
      createdAt: z.date(),
    }),
  )
  .readonly();

export function createChatRouter() {
  const actorOf = (ctx: {
    principal: Parameters<typeof subjectOf>[0];
    requestId: ChatActor['requestId'];
  }): ChatActor => ({ subject: subjectOf(ctx.principal), requestId: ctx.requestId });

  return router({
    channels: router({
      /**
       * Every channel the caller may see.
       *
       * Takes no input: the scope is entirely the principal's. That also means
       * the tenancy fuzz harness reports it `not-applicable` rather than passing
       * — there is no id to substitute — which is correct and is covered by the
       * RLS tests instead.
       */
      list: route({ permission: 'channel:read' })
        .output(
          z
            .array(
              z.object({
                channelId: z.string(),
                type: z.string(),
                name: z.string().nullable(),
                topic: z.string().nullable(),
                archivedAt: z.date().nullable(),
                createdAt: z.date(),
                joined: z.boolean(),
                participantIds: z.array(z.string()).readonly(),
              }),
            )
            .readonly(),
        )
        .query(({ ctx }) => channels.listChannels(actorOf(ctx))),

      get: route({ permission: 'channel:read' })
        .input(z.object({ channelId: ChannelIdSchema }).strict())
        .output(
          z.object({
            channelId: z.string(),
            type: z.string(),
            name: z.string().nullable(),
            topic: z.string().nullable(),
            archivedAt: z.date().nullable(),
            memberIds: z.array(z.string()).readonly(),
            /* The server's own decision, not a hint the client may override.
               See `capabilitiesFor` on why this is sent rather than recomputed. */
            capabilities: z.object({
              manage: z.boolean(),
              moderate: z.boolean(),
              post: z.boolean(),
            }),
          }),
        )
        .query(({ input, ctx }) => channels.getChannel(actorOf(ctx), input)),

      create: route({ permission: 'channel:create' })
        .input(
          z
            .object({
              /* Only the two NAMED types. A DM is opened, not created — see
                 `openDirect` below — and letting this route mint one would let a
                 caller create a `dm` row with a single participant, which is a
                 private channel nobody can ever be added to. */
              type: z.enum(['public', 'private']),
              name: ChannelName,
              topic: ChannelTopic,
            })
            .strict(),
        )
        .output(z.object({ channelId: z.string() }))
        .mutation(({ input, ctx }) => channels.createChannel(actorOf(ctx), input)),

      /**
       * Find-or-create the DM with these people.
       *
       * `channel:read` rather than `channel:create`, deliberately. Starting a
       * conversation with a colleague is not the same capability as creating a
       * channel the whole organization sees, and a role that can do the second
       * is not the set of people who should be able to do the first. The
       * response says whether a conversation was created or reopened.
       */
      openDirect: route({ permission: 'channel:read' })
        .input(
          z
            .object({ userIds: z.array(UserIdSchema).min(1).max(20).readonly() })
            .strict(),
        )
        .output(z.object({ channelId: z.string(), created: z.boolean() }))
        .mutation(({ input, ctx }) => channels.openDirectMessage(actorOf(ctx), input)),

      update: route({ permission: 'channel:manage' })
        .input(
          z
            .object({
              channelId: ChannelIdSchema,
              name: ChannelName,
              topic: ChannelTopic,
            })
            .strict(),
        )
        .output(z.object({ updated: z.boolean() }))
        .mutation(({ input, ctx }) => channels.updateChannel(actorOf(ctx), input)),

      archive: route({ permission: 'channel:manage' })
        .input(
          z.object({ channelId: ChannelIdSchema, restored: z.boolean().default(false) }).strict(),
        )
        .output(z.object({ archived: z.boolean() }))
        .mutation(({ input, ctx }) => channels.archiveChannel(actorOf(ctx), input)),

      /**
       * Add someone, or join a public channel yourself.
       *
       * The layer-1 permission is `channel:read` because self-joining a public
       * channel must be possible for anyone who can read it. Adding SOMEONE ELSE
       * is re-checked as `channel:manage` in the service, once the row is loaded
       * and it is known which of the two this is — a distinction the route
       * builder cannot make, because it runs before anything is read.
       */
      addMember: route({ permission: 'channel:read' })
        .input(z.object({ channelId: ChannelIdSchema, userId: UserIdSchema }).strict())
        .output(z.object({ added: z.boolean() }))
        .mutation(({ input, ctx }) => channels.addChannelMember(actorOf(ctx), input)),

      /** Remove someone, or leave. Same layer-1/layer-2 split as `addMember`. */
      removeMember: route({ permission: 'channel:read' })
        .input(z.object({ channelId: ChannelIdSchema, userId: UserIdSchema }).strict())
        .output(z.object({ removed: z.boolean() }))
        .mutation(({ input, ctx }) => channels.removeChannelMember(actorOf(ctx), input)),

      /**
       * Advances the caller's own read cursor. `channel:read` — reading is not
       * participating, so a read-only tuple must be able to mark itself caught
       * up same as a full member (§3.6).
       */
      markRead: route({ permission: 'channel:read' })
        .input(z.object({ channelId: ChannelIdSchema, messageId: MessageIdSchema }).strict())
        .output(z.object({ advanced: z.boolean() }))
        .mutation(({ input, ctx }) => readCursors.markRead(actorOf(ctx), input)),

      /** Unread counts for the sidebar badge, across the named channels. */
      unreadCounts: route({ permission: 'channel:read' })
        .input(z.object({ channelIds: z.array(ChannelIdSchema).min(1).max(200).readonly() }).strict())
        .output(
          z
            .array(
              z.object({
                channelId: z.string(),
                unreadCount: z.number().int().nonnegative(),
                lastReadMessageId: z.string().nullable(),
              }),
            )
            .readonly(),
        )
        .query(({ input, ctx }) => readCursors.unreadCounts(actorOf(ctx), input)),
    }),

    messages: router({
      list: route({ permission: 'message:read' })
        .input(
          z
            .object({
              channelId: ChannelIdSchema,
              limit: z.number().int().min(1).max(100).default(50),
              before: MessageIdSchema.nullable().default(null),
            })
            .strict(),
        )
        .output(MessageOutput)
        .query(({ input, ctx }) => messages.listMessages(actorOf(ctx), input)),

      thread: route({ permission: 'message:read' })
        .input(z.object({ messageId: MessageIdSchema }).strict())
        .output(MessageOutput)
        .query(({ input, ctx }) => messages.listThread(actorOf(ctx), input)),

      send: route({ permission: 'message:create' })
        .input(
          z
            .object({
              channelId: ChannelIdSchema,
              /* The same closed node/mark whitelist Work's rich text uses. A
                 mention is structurally the `href`-becomes-a-URL shape a link
                 already is, so it goes through the schema that was written to
                 refuse `javascript:` rather than a second one written for
                 chat. */
              body: RichTextDocument,
              parentMessageId: MessageIdSchema.nullable().default(null),
            })
            .strict(),
        )
        .output(z.object({ messageId: z.string() }))
        .mutation(({ input, ctx }) => messages.sendMessage(actorOf(ctx), input)),

      edit: route({ permission: 'message:update' })
        .input(z.object({ messageId: MessageIdSchema, body: RichTextDocument }).strict())
        .output(z.object({ edited: z.literal(true) }))
        .mutation(({ input, ctx }) => messages.editMessage(actorOf(ctx), input)),

      /**
       * `message:update` at layer 1, not `message:delete`.
       *
       * An author withdrawing their own message must be able to reach this
       * route, and they may hold no moderation permission at all. Which of the
       * two applies is decided in the service, where the message's author is
       * known — putting `message:delete` here would make the common case
       * (deleting your own message) unreachable for exactly the people who do it
       * most.
       */
      delete: route({ permission: 'message:update' })
        .input(z.object({ messageId: MessageIdSchema }).strict())
        .output(z.object({ deleted: z.literal(true) }))
        .mutation(({ input, ctx }) => messages.deleteMessage(actorOf(ctx), input)),

      /**
       * Toggles the caller's own reaction. `message:create` at layer 1 — see
       * `reaction.service.ts`'s header on why reacting needs the same
       * permission posting does.
       */
      react: route({ permission: 'message:create' })
        .input(
          z
            .object({
              channelId: ChannelIdSchema,
              messageId: MessageIdSchema,
              emoji: z.string().trim().min(1).max(32),
            })
            .strict(),
        )
        .output(z.object({ reacted: z.boolean() }))
        .mutation(({ input, ctx }) => reactions.toggleReaction(actorOf(ctx), input)),

      /** Every reaction on the named messages — the reaction bar under each. */
      reactions: route({ permission: 'message:read' })
        .input(
          z
            .object({
              channelId: ChannelIdSchema,
              messageIds: z.array(MessageIdSchema).min(1).max(200).readonly(),
            })
            .strict(),
        )
        .output(
          z
            .array(
              z.object({ messageId: z.string(), userId: z.string(), emoji: z.string() }),
            )
            .readonly(),
        )
        .query(({ input, ctx }) => reactions.listReactions(actorOf(ctx), input)),

      /** Pins a message. `message:create` — pinning curates, it does not moderate. */
      pin: route({ permission: 'message:create' })
        .input(z.object({ channelId: ChannelIdSchema, messageId: MessageIdSchema }).strict())
        .output(z.object({ pinned: z.boolean() }))
        .mutation(({ input, ctx }) => pins.pinMessage(actorOf(ctx), input)),

      unpin: route({ permission: 'message:create' })
        .input(z.object({ channelId: ChannelIdSchema, messageId: MessageIdSchema }).strict())
        .output(z.object({ unpinned: z.boolean() }))
        .mutation(({ input, ctx }) => pins.unpinMessage(actorOf(ctx), input)),

      /** The pinned-messages panel. */
      pins: route({ permission: 'message:read' })
        .input(z.object({ channelId: ChannelIdSchema }).strict())
        .output(
          z
            .array(
              z.object({
                messageId: z.string(),
                pinnedBy: z.string().nullable(),
                pinnedAt: z.date(),
              }),
            )
            .readonly(),
        )
        .query(({ input, ctx }) => pins.listPinnedMessages(actorOf(ctx), input)),
    }),
  });
}
