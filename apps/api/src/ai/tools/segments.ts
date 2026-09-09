import { z } from 'zod';
import { UserIdSchema, type UserId } from '@taskflow/contracts';
import type { RichTextNode } from '../../work/richtext.js';

/**
 * The ordered text/mention segment shape every AI tool that composes rich
 * text uses — `chat_post_message` first, now `card_add_comment` too. Shared
 * rather than copied: both need the identical "map onto the one paragraph a
 * human's own composer would produce" logic `chat.ts`'s own header
 * documents, and a second copy is exactly the kind of drift a future third
 * caller (a Docs comment, an automation action) would have no reason to
 * notice.
 */

/* An explicit type annotation on the exported schema const, not bare
   inference — without it, `tsc`'s declaration emit fails with TS4023
   ("has or is using name 'brand' from external module... but cannot be
   named"), since `UserIdSchema`'s branded type closes over a symbol
   `@taskflow/contracts` does not itself export. Naming the type explicitly
   (against `UserId`, which IS exported) sidesteps the synthesis entirely —
   `chat.ts`'s original inline version of this never hit it only because it
   was never itself exported from a module. */
export type MessageSegment =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'mention'; readonly userId: UserId; readonly label: string };

export const MessageSegment: z.ZodType<MessageSegment, z.ZodTypeDef, unknown> =
  z.discriminatedUnion('type', [
    z.object({ type: z.literal('text'), text: z.string().max(2_000) }).strict(),
    z
      .object({
        type: z.literal('mention'),
        userId: UserIdSchema,
        label: z.string().trim().min(1).max(120),
      })
      .strict(),
  ]);

export const SEGMENT_JSON_SCHEMA = {
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
} as const;

export function segmentsToRichText(segments: readonly MessageSegment[]): RichTextNode {
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
