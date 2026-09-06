import { z } from 'zod';
import { ChannelIdSchema, MessageIdSchema, UserIdSchema } from '@taskflow/contracts';
import type { RichTextNode } from '../../work/richtext.js';
import { sendMessage } from '../../chat/message.service.js';
import type { ChatActor } from '../../chat/shared.js';
import { defineTool, type ToolContext, type ToolDefinition } from './registry.js';

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
 * There is no tool yet that resolves a person's NAME to a `userId` — the
 * same discoverability gap `card_create`'s `listId` and `sprint_add_cards`'s
 * `sprintId` already have (see their own files) — so a mention today needs
 * a `userId` the conversation already supplied some other way (a prior
 * `search` hit's `author_id`, or the person named it themselves). Real, not
 * fatal: the tool still refuses cleanly (via `mention`'s own `isValidId`
 * check inside `RichTextDocument`) rather than posting garbage.
 */

const MessageSegment = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string().max(2_000) }).strict(),
  z
    .object({
      type: z.literal('mention'),
      userId: UserIdSchema,
      label: z.string().trim().min(1).max(120),
    })
    .strict(),
]);

const ChatPostMessageInput = z
  .object({
    channelId: ChannelIdSchema,
    segments: z.array(MessageSegment).min(1).max(50),
    parentMessageId: MessageIdSchema.nullable().optional(),
  })
  .strict();

function bodyOf(segments: readonly z.infer<typeof MessageSegment>[]): RichTextNode {
  const content = segments
    // An empty text segment contributes a degenerate node no editor would
    // ever produce — dropped here rather than rejected, since it costs
    // nothing to just not include it.
    .filter((segment) => segment.type !== 'text' || segment.text.length > 0)
    .map((segment) =>
      segment.type === 'text'
        ? { type: 'text', text: segment.text }
        : { type: 'mention', attrs: { userId: segment.userId, label: segment.label } },
    );
  return { type: 'doc', content: [{ type: 'paragraph', content }] };
}

export function createChatPostMessageTool(): ToolDefinition {
  return defineTool({
    name: 'chat_post_message',
    description:
      'Posts a message to a channel or DM, optionally @mentioning people by user id. Provide the message as an ordered list of text and mention segments.',
    jsonSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'The id of the channel or DM to post in.' },
        segments: {
          type: 'array',
          description: 'The message body, as ordered text/mention segments.',
          items: {
            oneOf: [
              {
                type: 'object',
                properties: { type: { const: 'text' }, text: { type: 'string' } },
                required: ['type', 'text'],
                additionalProperties: false,
              },
              {
                type: 'object',
                properties: {
                  type: { const: 'mention' },
                  userId: { type: 'string', description: 'The mentioned user id.' },
                  label: { type: 'string', description: 'The display text, e.g. their name.' },
                },
                required: ['type', 'userId', 'label'],
                additionalProperties: false,
              },
            ],
          },
        },
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
        body: bodyOf(input.segments),
        parentMessageId: input.parentMessageId ?? null,
      });
      return { content: JSON.stringify({ messageId: result.messageId }) };
    },
  });
}
