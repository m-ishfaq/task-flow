import { and, desc, eq, schema, withOrgScope, outboxWriter } from '@taskflow/db';
import type { ChannelId, MessageId } from '@taskflow/contracts';
import { createEvent } from '@taskflow/events';
import { messagePinned, messageUnpinned } from './events.js';
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
 * Pinned messages (ai/phase-5-chat.md §5).
 *
 * `message:create` gates pin/unpin, the same permission posting needs —
 * pinning is a form of curating the conversation you can already participate
 * in, not a moderation action, so it does not need `channel:manage`. Listing
 * the pinned-messages panel is `message:read`, matching `messages.list`.
 */

export interface PinnedMessageRow {
  readonly messageId: string;
  readonly pinnedBy: string | null;
  readonly pinnedAt: Date;
}

/** Pins a message. Idempotent — pinning an already-pinned message is a no-op. */
export async function pinMessage(
  actor: ChatActor,
  input: { readonly channelId: ChannelId; readonly messageId: MessageId },
): Promise<{ readonly pinned: boolean }> {
  const orgId = orgOf(actor);
  const userId = userOf(actor);

  return withOrgScope(orgId, async (tx) => {
    const channel = await loadChannel(tx, input.channelId);
    enforceOnChannel(actor, 'message:create', channel);

    await assertMessageInChannel(tx, input.channelId, input.messageId);

    const existing = await tx
      .select({ messageId: schema.pinnedMessages.messageId })
      .from(schema.pinnedMessages)
      .where(
        and(
          eq(schema.pinnedMessages.channelId, input.channelId),
          eq(schema.pinnedMessages.messageId, input.messageId),
        ),
      )
      .limit(1);

    if (existing.length > 0) return { pinned: false };

    await tx.insert(schema.pinnedMessages).values({
      orgId,
      channelId: input.channelId,
      messageId: input.messageId,
      pinnedBy: userId,
    });

    await outboxWriter.append(tx, [
      createEvent(
        messagePinned,
        { messageId: input.messageId, channelId: input.channelId, pinnedBy: userId },
        envelopeOf(actor),
      ),
    ]);

    return { pinned: true };
  });
}

/** Unpins a message. A no-op, not an error, when it was not pinned. */
export async function unpinMessage(
  actor: ChatActor,
  input: { readonly channelId: ChannelId; readonly messageId: MessageId },
): Promise<{ readonly unpinned: boolean }> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const channel = await loadChannel(tx, input.channelId);
    enforceOnChannel(actor, 'message:create', channel);

    const deleted = await tx
      .delete(schema.pinnedMessages)
      .where(
        and(
          eq(schema.pinnedMessages.channelId, input.channelId),
          eq(schema.pinnedMessages.messageId, input.messageId),
        ),
      )
      .returning({ messageId: schema.pinnedMessages.messageId });

    if (deleted.length === 0) return { unpinned: false };

    await outboxWriter.append(tx, [
      createEvent(
        messageUnpinned,
        { messageId: input.messageId, channelId: input.channelId },
        envelopeOf(actor),
      ),
    ]);

    return { unpinned: true };
  });
}

/** The pinned-messages panel for a channel, newest pin first. */
export async function listPinnedMessages(
  actor: ChatActor,
  input: { readonly channelId: ChannelId },
): Promise<readonly PinnedMessageRow[]> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const channel = await loadChannel(tx, input.channelId);
    enforceOnChannel(actor, 'message:read', channel);

    return tx
      .select({
        messageId: schema.pinnedMessages.messageId,
        pinnedBy: schema.pinnedMessages.pinnedBy,
        pinnedAt: schema.pinnedMessages.pinnedAt,
      })
      .from(schema.pinnedMessages)
      .where(eq(schema.pinnedMessages.channelId, input.channelId))
      .orderBy(desc(schema.pinnedMessages.pinnedAt));
  });
}
