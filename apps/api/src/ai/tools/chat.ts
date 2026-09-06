import { z } from 'zod';
import { errors, ChannelIdSchema, MessageIdSchema, UserIdSchema } from '@taskflow/contracts';
import { can } from '@taskflow/policy';
import { sendMessage } from '../../chat/message.service.js';
import { listChannels, openDirectMessage } from '../../chat/channel.service.js';
import type { ChatActor } from '../../chat/shared.js';
import { defineTool, type ToolContext, type ToolDefinition } from './registry.js';
import { MessageSegment, SEGMENT_JSON_SCHEMA, segmentsToRichText } from './segments.js';

/**
 * `chat_post_message` (§4.1's table, §4.3 item 4 — "cross-member
 * tagging/discussion... already mostly exists via `mention` + Chat, mainly
 * assistant wiring, not new primitives"). Reuses the already-whitelisted
 * `mention` TipTap node exactly as a human's own composer does — no new
 * content type, and the SAME `mentionedUserIds` extraction on the send path
 * notifies whoever is tagged, because this is a real `sendMessage` call, not
 * a parallel notification path invented for the assistant.
 *
 * **This tool requires confirmation, even though §4.2's own illustrative
 * text names `chat_post_message` alongside `card_create`/`card_update` as
 * "cheap to undo... can execute directly once permitted."** Unlike those
 * two, §4.3 does not separately contradict that for this tool — there is no
 * genuine ambiguity to resolve here the way Wave 2 had one. The choice to
 * still require confirmation is deliberate anyway: a message posted to a
 * channel is read (and a mention notifies its target) before anyone could
 * undo it, unlike a card field that only the people already looking at that
 * card would ever see change. Loosening this to auto-execute, matching
 * §4.2's text exactly, is real, separate, reviewable work later — the same
 * posture this registry already takes toward every other write tool.
 *
 * The model composes the message as ordered SEGMENTS — plain text or a
 * `mention` naming a `userId` and the `label` to display — rather than a
 * markup string the tool would have to parse. This is a direct, lossless
 * map onto the one paragraph `sendMessage`'s `body` becomes: text segments
 * become `text` nodes, `mention` segments become `mention` nodes with
 * `attrs.userId`/`attrs.label`, exactly as `plainParagraph` builds a
 * text-only paragraph for every other non-human caller in this codebase.
 *
 * `lookup.ts`'s `list_members` (added later, from a real "still no way to
 * mention a member" report) closes what this comment used to document as
 * open: a mention no longer needs a `userId` the conversation already
 * supplied some other way — the model can resolve a name to one in the
 * same turn, the identical fix `list_boards`/`list_labels`/`list_sprints`
 * already gave `card_create`'s `listId`/`labelIds`/`sprintId`. `mention`'s
 * own `isValidId` check inside `RichTextDocument` still refuses a malformed
 * id cleanly rather than posting garbage, for whichever caller does not
 * look one up first.
 *
 * The segment shape and the segments -> rich-text mapping now live in
 * `segments.ts`, shared with `card_add_comment` (`card.ts`) — the identical
 * "map onto the one paragraph a human's composer would produce" logic, and
 * a second copy would be exactly the kind of drift a third caller would
 * have no reason to notice.
 *
 * `dmUserIds`, added later from a real transcript ("send a msg to @Rosa
 * Pereira" failing "Not found." three times), closes a gap this tool always
 * had: it took only a `channelId`, and nothing in the registry could ever
 * produce one for a DM that did not already exist — `list_members` gives a
 * `userId`, never a `channelId`. Rather than a separate `chat_open_dm` tool
 * needing its OWN confirmation before `chat_post_message` could even be
 * attempted (two approvals for one "message Rosa" request), this bundles
 * `openDirectMessage` (find-or-create) and `sendMessage` behind the SAME
 * single confirmation — the identical "several real service calls behind
 * one tool call" shape `card_create` already established for
 * create+assign+label+priority+sprint. `channelId` and `dmUserIds` are
 * mutually exclusive: a caller who already has a channel id (from
 * `list_channels`, or a channel named earlier in the conversation) should
 * use it directly rather than paying an extra `openDirectMessage` lookup
 * that would only return the same id.
 *
 * `openDirectMessage`'s own ROUTE floors on `channel:read` — "starting a
 * conversation with a colleague is not the same capability as creating a
 * channel the whole organization sees" — and a tool call bypasses every
 * route, so this checks the identical permission itself before calling it,
 * the same in-executor pattern `list_members` already uses for
 * `member:read`.
 */

const ChatPostMessageInput = z
  .object({
    channelId: ChannelIdSchema.optional(),
    dmUserIds: z.array(UserIdSchema).min(1).max(20).optional(),
    segments: z.array(MessageSegment).min(1).max(50),
    parentMessageId: MessageIdSchema.nullable().optional(),
  })
  .strict()
  .refine((value) => (value.channelId === undefined) !== (value.dmUserIds === undefined), {
    message: 'Provide exactly one of channelId or dmUserIds.',
  });

export function createChatPostMessageTool(): ToolDefinition {
  return defineTool({
    name: 'chat_post_message',
    description:
      'Posts a message to a channel, optionally @mentioning people by user id. Provide the ' +
      'message as an ordered list of text and mention segments. To post in an existing channel ' +
      'or DM, pass `channelId` (from `list_channels`). To message someone directly with no ' +
      'existing conversation in hand, pass `dmUserIds` instead (from `list_members`) and this ' +
      'opens or reuses the DM automatically — never call another tool first to get a channel id ' +
      'for a DM.',
    jsonSchema: {
      type: 'object',
      properties: {
        channelId: {
          type: 'string',
          description: 'The id of an existing channel or DM to post in, from `list_channels`.',
        },
        dmUserIds: {
          type: 'array',
          items: { type: 'string' },
          description:
            'User ids (from `list_members`) to direct-message. Opens the DM if none exists yet. ' +
            'Provide this OR channelId, never both.',
        },
        segments: SEGMENT_JSON_SCHEMA,
        parentMessageId: {
          type: ['string', 'null'],
          description: 'Reply to this message, or omit for a top-level post.',
        },
      },
      required: ['segments'],
      additionalProperties: false,
    },
    requiresConfirmation: true,
    inputSchema: ChatPostMessageInput,
    async execute(ctx: ToolContext, input) {
      const actor: ChatActor = { subject: ctx.subject, requestId: ctx.requestId };

      let channelId = input.channelId;
      if (channelId === undefined) {
        if (!can(ctx.subject, 'channel:read').allowed) {
          throw errors.forbidden('You do not have permission to start a direct message.');
        }
        const opened = await openDirectMessage(actor, { userIds: input.dmUserIds ?? [] });
        channelId = opened.channelId;
      }

      const result = await sendMessage(actor, {
        channelId,
        body: segmentsToRichText(input.segments),
        parentMessageId: input.parentMessageId ?? null,
      });
      return { content: JSON.stringify({ channelId, messageId: result.messageId }) };
    },
  });
}

const NoChannelsInput = z.object({}).strict();

/**
 * Closes the sibling gap `dmUserIds` above does not: resolving an EXISTING
 * named channel (or a DM already open) to its id. Before this, nothing in
 * the registry could ever produce a channel id at all except by opening a
 * fresh DM — posting to "the #general channel" or replying in an existing
 * conversation had no path to an id either.
 *
 * Wraps the real `listChannels`, which already filters to exactly what the
 * caller may see via a per-row `can()` check (`channel.service.ts`'s own
 * header) — this tool adds no authorization of its own, the same "the real
 * service already asks" shape every other lookup tool in this file follows.
 */
export function createListChannelsTool(): ToolDefinition {
  return defineTool({
    name: 'list_channels',
    description:
      'Lists the channels and DMs the current user can see — public channels plus any the ' +
      "user has joined — with each one's id, type, name (null for a DM), and, for a DM, the " +
      "other participants' user ids. Use this to resolve a named channel the user mentions " +
      '(e.g. "post it in #general") to an id for `chat_post_message`. For a NEW direct message ' +
      "with someone, use `chat_post_message`'s own `dmUserIds` instead — no need to look up a " +
      'DM channel id first.',
    jsonSchema: { type: 'object', properties: {}, additionalProperties: false },
    requiresConfirmation: false,
    inputSchema: NoChannelsInput,
    async execute(ctx) {
      const actor: ChatActor = { subject: ctx.subject, requestId: ctx.requestId };
      const { channels } = await listChannels(actor);
      if (channels.length === 0) {
        return { content: 'No channels are visible to you yet.' };
      }
      const summarized = channels.map((channel) => ({
        channelId: channel.channelId,
        type: channel.type,
        name: channel.name,
        participantIds: channel.participantIds,
      }));
      return { content: JSON.stringify(summarized) };
    },
  });
}
