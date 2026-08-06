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
 */

export interface ReactionRow {
  readonly messageId: string;
  readonly userId: string;
  readonly emoji: string;
}

const MAX_EMOJI_LENGTH = 32;

/**
 * Adds or removes the caller's own reaction — whichever the current row
 * implies. A second click on the same emoji is what removes it; there is no
 * separate "remove" route because the client already knows which one this is
 * from what it is currently rendering.
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

    const existing = await tx
      .select({ emoji: schema.messageReactions.emoji })
      .from(schema.messageReactions)
      .where(
        and(
          eq(schema.messageReactions.messageId, input.messageId),
          eq(schema.messageReactions.userId, userId),
          eq(schema.messageReactions.emoji, emoji),
        ),
      )
      .limit(1);

    if (existing.length > 0) {
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

    await tx.insert(schema.messageReactions).values({
      orgId,
      channelId: input.channelId,
      messageId: input.messageId,
      userId,
      emoji,
    });

    await outboxWriter.append(tx, [
      createEvent(
        messageReactionAdded,
        { messageId: input.messageId, channelId: input.channelId, userId, emoji },
        envelopeOf(actor),
      ),
    ]);

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
