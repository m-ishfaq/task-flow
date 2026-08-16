import { and, eq, inArray, schema, withOrgScope, outboxWriter } from '@taskflow/db';
import { errors, type ChannelId, type MessageId } from '@taskflow/contracts';
import { createEvent } from '@taskflow/events';
import { messageReactionAdded, messageReactionRemoved } from './events.js';
import {
  assertMessageInChannel,
  enforceOnChannel,
  envelopeOf,
  loadChannel,
  orgOf,
  userOf,
  type ChatActor,
} from './shared.js';

/**
 * Reactions (ai/phase-5-chat.md §5).
 *
 * `message:create` gates a toggle, not `message:read` — reacting is a form of
 * participating in the channel, the same capability posting needs, and the
 * permission a `viewer` tuple deliberately withholds (§3.9). Listing what is
 * already there is `message:read`, matching `messages.list`.
 *
 * One row, not two, records the current state: a reaction is either present or
 * it is not, so there is no separate "removed" tombstone the way a message
 * has one — nothing downstream needs to know a reaction ONCE existed.
 *
 * One row PER PERSON PER MESSAGE (migration 0076's primary key): a person
 * holds at most one reaction on a message, so reacting with a second emoji
 * REPLACES the first — the WhatsApp model. Clicking the emoji you already
 * hold is what removes it.
 */

export interface ReactionRow {
  readonly messageId: string;
  readonly userId: string;
  readonly emoji: string;
}

const MAX_EMOJI_LENGTH = 32;

/**
 * The caller's one reaction on a message, set by whatever the current row
 * implies: the emoji they already hold toggles it OFF, any other emoji
 * REPLACES it, and the first reaction inserts. There is no separate "remove"
 * route because the client already knows which emoji this is from what it is
 * currently rendering.
 */
export async function toggleReaction(
  actor: ChatActor,
  input: { readonly channelId: ChannelId; readonly messageId: MessageId; readonly emoji: string },
): Promise<{ readonly reacted: boolean }> {
  const emoji = input.emoji.trim();
  if (emoji.length === 0 || emoji.length > MAX_EMOJI_LENGTH) {
    throw errors.validation({ emoji: 'A reaction must be between 1 and 32 characters.' });
  }

  const userId = userOf(actor);
  const orgId = orgOf(actor);

  return withOrgScope(orgId, async (tx) => {
    const channel = await loadChannel(tx, input.channelId);
    enforceOnChannel(actor, 'message:create', channel);

    await assertMessageInChannel(tx, input.channelId, input.messageId);

    /* The caller's ONE current reaction on this message. No emoji in the
       WHERE: migration 0076 made (message_id, user_id) the primary key, so at
       most one row can exist and it IS the slot being toggled or replaced. */
    const existing = await tx
      .select({ emoji: schema.messageReactions.emoji })
      .from(schema.messageReactions)
      .where(
        and(
          eq(schema.messageReactions.messageId, input.messageId),
          eq(schema.messageReactions.userId, userId),
        ),
      )
      .limit(1);

    const current = existing[0]?.emoji;

    /* The emoji already held → toggle OFF. The emoji in the DELETE's WHERE is
       the one just read, so it can only match the row that was looked at. */
    if (current === emoji) {
      await tx
        .delete(schema.messageReactions)
        .where(
          and(
            eq(schema.messageReactions.messageId, input.messageId),
            eq(schema.messageReactions.userId, userId),
            eq(schema.messageReactions.emoji, emoji),
          ),
        );

      await outboxWriter.append(tx, [
        createEvent(
          messageReactionRemoved,
          { messageId: input.messageId, channelId: input.channelId, userId, emoji },
          envelopeOf(actor),
        ),
      ]);

      return { reacted: false };
    }

    /* A different emoji, or the first reaction — one upsert covers both, since
       the only row it can touch is this person's own (message, user) slot.
       `onConflictDoUpdate` also closes the race where a second reaction lands
       between the read above and this write: without it the new primary key's
       unique violation would surface as a 500 to the second clicker.
       Last-write-wins is the honest outcome for two near-simultaneous
       reactions. */
    await tx
      .insert(schema.messageReactions)
      .values({
        orgId,
        channelId: input.channelId,
        messageId: input.messageId,
        userId,
        emoji,
      })
      .onConflictDoUpdate({
        target: [schema.messageReactions.messageId, schema.messageReactions.userId],
        set: { emoji },
      });

    /* A replace is announced as the old emoji leaving and the new one
       arriving, never as a third "replaced" event: `message.reaction_removed`
       and `_added` already map to the audit projection and the realtime
       event-rooms (audit.projection.ts, event-rooms.ts), so a replace needs
       no new wiring, and a consumer that counts reactions sees the same net
       effect. The first reaction has no old emoji to announce. */
    const events = [
      ...(current === undefined
        ? []
        : [
            createEvent(
              messageReactionRemoved,
              {
                messageId: input.messageId,
                channelId: input.channelId,
                userId,
                emoji: current,
              },
              envelopeOf(actor),
            ),
          ]),
      createEvent(
        messageReactionAdded,
        { messageId: input.messageId, channelId: input.channelId, userId, emoji },
        envelopeOf(actor),
      ),
    ];
    await outboxWriter.append(tx, events);

    return { reacted: true };
  });
}

/**
 * Every reaction on the named messages. Bounded by the caller's own message
 * ids — the set currently rendered — rather than the whole channel, so
 * opening a long-lived channel does not pull its entire reaction history.
 */
export async function listReactions(
  actor: ChatActor,
  input: { readonly channelId: ChannelId; readonly messageIds: readonly MessageId[] },
): Promise<readonly ReactionRow[]> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const channel = await loadChannel(tx, input.channelId);
    enforceOnChannel(actor, 'message:read', channel);

    if (input.messageIds.length === 0) return [];

    return tx
      .select({
        messageId: schema.messageReactions.messageId,
        userId: schema.messageReactions.userId,
        emoji: schema.messageReactions.emoji,
      })
      .from(schema.messageReactions)
      .where(
        and(
          eq(schema.messageReactions.channelId, input.channelId),
          inArray(schema.messageReactions.messageId, input.messageIds),
        ),
      );
  });
}
