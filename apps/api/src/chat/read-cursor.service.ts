import { and, eq, gt, inArray, schema, withOrgScope, outboxWriter } from '@taskflow/db';
import type { ChannelId, MessageId } from '@taskflow/contracts';
import { createEvent } from '@taskflow/events';
import { enforce } from '@taskflow/policy';
import { channelReadAdvanced } from './events.js';
import {
  assertMessageInChannel,
  enforceOnChannel,
  envelopeOf,
  isClosedChannel,
  loadChannel,
  orgOf,
  userOf,
  type ChatActor,
} from './shared.js';

/**
 * Read cursors and unread counts (ai/phase-5-chat.md §3.6; migration 0018's
 * header comment).
 *
 * `channel:read` gates marking a message read, not `message:create` — reading
 * is not participating, and a `viewer`-only tuple must be able to advance its
 * own cursor same as a full member.
 *
 * The cursor only ever moves FORWARD. `markRead` compares message ids as
 * strings, which is safe because they are UUIDv7 — creation-ordered, so
 * lexicographic comparison agrees with Postgres's own `id < cursor` ordering
 * `listMessages` already relies on for pagination.
 */

/** Advances the caller's read cursor for a channel. A no-op if it would move backward. */
export async function markRead(
  actor: ChatActor,
  input: { readonly channelId: ChannelId; readonly messageId: MessageId },
): Promise<{ readonly advanced: boolean }> {
  const userId = userOf(actor);
  const orgId = orgOf(actor);

  return withOrgScope(orgId, async (tx) => {
    const channel = await loadChannel(tx, input.channelId);
    enforceOnChannel(actor, 'channel:read', channel);

    await assertMessageInChannel(tx, input.channelId, input.messageId);

    const existing = await tx
      .select({ lastReadMessageId: schema.readCursors.lastReadMessageId })
      .from(schema.readCursors)
      .where(
        and(
          eq(schema.readCursors.channelId, input.channelId),
          eq(schema.readCursors.userId, userId),
        ),
      )
      .limit(1);

    const current = existing[0]?.lastReadMessageId ?? null;
    if (current !== null && current >= input.messageId) {
      return { advanced: false };
    }

    await tx
      .insert(schema.readCursors)
      .values({
        orgId,
        channelId: input.channelId,
        userId,
        lastReadMessageId: input.messageId,
      })
      .onConflictDoUpdate({
        target: [schema.readCursors.channelId, schema.readCursors.userId],
        set: { lastReadMessageId: input.messageId, lastReadAt: new Date() },
      });

    await outboxWriter.append(tx, [
      createEvent(
        channelReadAdvanced,
        { channelId: input.channelId, userId, lastReadMessageId: input.messageId },
        envelopeOf(actor),
      ),
    ]);

    return { advanced: true };
  });
}

export interface UnreadCount {
  readonly channelId: string;
  readonly unreadCount: number;
}

/**
 * Unread counts for a set of channels — the sidebar badge.
 *
 * No target passed to `enforce`: this is the org-level `channel:read` check
 * every member holds for public channels, mirroring `listChannels`'s own
 * layer-1 check. Per-channel authorization still happens below, because
 * unlike `listChannels` the caller SUPPLIES the channel ids rather than this
 * function discovering them — a closed channel named here without a
 * membership tuple must not leak an unread count.
 *
 * One query per channel plus one for the cursors, not a single join: `count`
 * has no exported helper outside `packages/db` (guardrail 2's raw-SQL ban),
 * and the channel list a sidebar renders is small enough that this is not
 * the query worth optimizing away.
 */
export async function unreadCounts(
  actor: ChatActor,
  input: { readonly channelIds: readonly ChannelId[] },
): Promise<readonly UnreadCount[]> {
  enforce(actor.subject, 'channel:read');

  const userId = userOf(actor);
  const memberChannelIds = new Set(
    actor.subject.tuples
      .filter((tuple) => tuple.object.type === 'channel')
      .map((tuple) => tuple.object.id),
  );

  return withOrgScope(orgOf(actor), async (tx) => {
    if (input.channelIds.length === 0) return [];

    const channels = await tx
      .select({
        id: schema.channels.id,
        orgId: schema.channels.orgId,
        type: schema.channels.type,
        name: schema.channels.name,
        topic: schema.channels.topic,
        archivedAt: schema.channels.archivedAt,
      })
      .from(schema.channels)
      .where(inArray(schema.channels.id, input.channelIds));

    /* Silently drops a channel the caller cannot read, exactly like
       `listChannels` does — an unread count for a channel invisible in the
       sidebar is not a partial answer worth erroring over. */
    const readable = channels.filter(
      (channel) => !isClosedChannel(channel) || memberChannelIds.has(channel.id),
    );

    const cursors = await tx
      .select({
        channelId: schema.readCursors.channelId,
        lastReadMessageId: schema.readCursors.lastReadMessageId,
      })
      .from(schema.readCursors)
      .where(
        and(
          eq(schema.readCursors.userId, userId),
          inArray(
            schema.readCursors.channelId,
            readable.map((channel) => channel.id),
          ),
        ),
      );

    const cursorByChannel = new Map(cursors.map((row) => [row.channelId, row.lastReadMessageId]));

    const results: UnreadCount[] = [];
    for (const channel of readable) {
      const cursor = cursorByChannel.get(channel.id) ?? null;

      const rows = await tx
        .select({ id: schema.messages.id })
        .from(schema.messages)
        .where(
          cursor === null
            ? eq(schema.messages.channelId, channel.id)
            : and(eq(schema.messages.channelId, channel.id), gt(schema.messages.id, cursor)),
        );

      results.push({ channelId: channel.id, unreadCount: rows.length });
    }

    return results;
  });
}
