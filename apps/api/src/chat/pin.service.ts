import { and, desc, eq, inArray, schema, withOrgScope, outboxWriter } from '@taskflow/db';
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
  /** Null when the message was since deleted — the pin still resolves, there
      is just nothing to preview. Same rule `listAllPinned`'s own excerpt and
      `saved.service.ts`'s `listSaved` already state. */
  readonly excerpt: string | null;
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

    const rows = await tx
      .select({
        messageId: schema.pinnedMessages.messageId,
        pinnedBy: schema.pinnedMessages.pinnedBy,
        pinnedAt: schema.pinnedMessages.pinnedAt,
      })
      .from(schema.pinnedMessages)
      .where(eq(schema.pinnedMessages.channelId, input.channelId))
      .orderBy(desc(schema.pinnedMessages.pinnedAt));

    if (rows.length === 0) return [];

    /* One batch read for every excerpt, the same reasoning `listAllPinned`
       and `listSaved` both give: a channel with dozens of pins should cost
       this endpoint two round trips, not one per row. */
    const messageRows = await tx
      .select({
        id: schema.messages.id,
        bodyText: schema.messages.bodyText,
        deletedAt: schema.messages.deletedAt,
      })
      .from(schema.messages)
      .where(
        inArray(
          schema.messages.id,
          rows.map((row) => row.messageId),
        ),
      );

    const excerptById = new Map(
      messageRows.map((row) => [
        row.id,
        row.deletedAt === null ? row.bodyText.slice(0, 280) : null,
      ]),
    );

    return rows.map((row) => ({
      messageId: row.messageId,
      pinnedBy: row.pinnedBy,
      pinnedAt: row.pinnedAt,
      excerpt: excerptById.get(row.messageId) ?? null,
    }));
  });
}

export interface PinnedMessageSummary {
  readonly messageId: string;
  readonly channelId: string;
  readonly channelName: string | null;
  readonly channelType: string;
  readonly excerpt: string | null;
  readonly pinnedBy: string | null;
  readonly pinnedAt: Date;
}

/**
 * Every pin the caller can still see, across every channel — the sidebar's
 * "Pinned messages" surface, same shape as `saved.service.ts`'s `listSaved`
 * and for the same reasons: one query across channels rather than a panel
 * that only ever showed the ONE channel currently open, re-checked per
 * DISTINCT channel (`message:read`, matching `listPinnedMessages`'s own
 * permission) so a pin in a channel the caller has since lost access to
 * simply stops resolving rather than re-disclosing it, and an excerpt read
 * in one batch rather than one query per row.
 */
/** An org that pins liberally across many channels has no natural ceiling on
 *  this query otherwise — Design Bible §20, the identical reasoning
 *  `PAGE_VERSION_LIST_LIMIT` gives its own sibling in `apps/api/src/docs`.
 *  `chat-sidebar.tsx`'s own disclosure note restates this number rather
 *  than importing across the API boundary, the same trade that file's
 *  header already accepts for `notifications.ts`'s `PAGE_SIZE`. */
export const PINNED_LIST_LIMIT = 200;

export async function listAllPinned(actor: ChatActor): Promise<readonly PinnedMessageSummary[]> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const rows = await tx
      .select({
        messageId: schema.pinnedMessages.messageId,
        channelId: schema.pinnedMessages.channelId,
        pinnedBy: schema.pinnedMessages.pinnedBy,
        pinnedAt: schema.pinnedMessages.pinnedAt,
      })
      .from(schema.pinnedMessages)
      .orderBy(desc(schema.pinnedMessages.pinnedAt))
      .limit(PINNED_LIST_LIMIT);

    if (rows.length === 0) return [];

    const channelInfo = new Map<
      string,
      { readonly name: string | null; readonly type: string } | null
    >();

    const visible: {
      readonly messageId: string;
      readonly channelId: string;
      readonly pinnedBy: string | null;
      readonly pinnedAt: Date;
    }[] = [];

    for (const row of rows) {
      let info = channelInfo.get(row.channelId);

      if (info === undefined) {
        try {
          const channel = await loadChannel(tx, row.channelId as ChannelId);
          enforceOnChannel(actor, 'message:read', channel);
          info = { name: channel.name, type: channel.type };
        } catch {
          info = null;
        }
        channelInfo.set(row.channelId, info);
      }

      if (info !== null) visible.push(row);
    }

    if (visible.length === 0) return [];

    const messageRows = await tx
      .select({
        id: schema.messages.id,
        bodyText: schema.messages.bodyText,
        deletedAt: schema.messages.deletedAt,
      })
      .from(schema.messages)
      .where(
        inArray(
          schema.messages.id,
          visible.map((row) => row.messageId),
        ),
      );

    const excerptById = new Map(
      messageRows.map((row) => [
        row.id,
        row.deletedAt === null ? row.bodyText.slice(0, 280) : null,
      ]),
    );

    return visible.map((row) => {
      const info = channelInfo.get(row.channelId);
      return {
        messageId: row.messageId,
        channelId: row.channelId,
        channelName: info?.name ?? null,
        channelType: info?.type ?? 'public',
        excerpt: excerptById.get(row.messageId) ?? null,
        pinnedBy: row.pinnedBy,
        pinnedAt: row.pinnedAt,
      };
    });
  });
}
