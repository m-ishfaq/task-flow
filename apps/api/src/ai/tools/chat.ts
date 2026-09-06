import { z } from 'zod';
import { ChannelIdSchema, MessageIdSchema } from '@taskflow/contracts';
import { sendMessage } from '../../chat/message.service.js';
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
 */

const ChatPostMessageInput = z
  .object({
    channelId: ChannelIdSchema,
    segments: z.array(MessageSegment).min(1).max(50),
    parentMessageId: MessageIdSchema.nullable().optional(),
  })
  .strict();

export function createChatPostMessageTool(): ToolDefinition {
  return defineTool({
    name: 'chat_post_message',
    description:
      'Posts a message to a channel or DM, optionally @mentioning people by user id. Provide the message as an ordered list of text and mention segments.',
    jsonSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'The id of the channel or DM to post in.' },
        segments: SEGMENT_JSON_SCHEMA,
        parentMessageId: {
          type: ['string', 'null'],
          description: 'Reply to this message, or omit for a top-level post.',
        },
      },
      required: ['channelId', 'segments'],
      additionalProperties: false,
    },
    requiresConfirmation: true,
    inputSchema: ChatPostMessageInput,
    async execute(ctx: ToolContext, input) {
      const actor: ChatActor = { subject: ctx.subject, requestId: ctx.requestId };
      const result = await sendMessage(actor, {
        channelId: input.channelId,
        body: segmentsToRichText(input.segments),
        parentMessageId: input.parentMessageId ?? null,
      });
      return { content: JSON.stringify({ messageId: result.messageId }) };
    },
  });
}
