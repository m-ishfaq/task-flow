import { and, desc, eq, schema, withOrgScope, outboxWriter } from '@taskflow/db';
import { errors, type ChannelId, type MessageId } from '@taskflow/contracts';
import { createEvent } from '@taskflow/events';
import { messageSaved } from './events.js';
import {
  enforceOnChannel,
  envelopeOf,
  loadChannel,
  loadMessageRow,
  orgOf,
  userOf,
  type ChatActor,
} from './shared.js';

/**
 * Saved messages — "keep this for later", per person (§2, Wave 2).
 *
 * ## A save is not a pin
 *
 * A pin is CHANNEL state: everyone sees it, it appears in the pinned panel, and
 * unpinning is something one person does to everybody's view. A save is
 * personal and invisible to everyone else. They are separate tables and
 * separate services because merging them would produce one row whose AUDIENCE
 * depends on a column — and every read path would have to filter on that column
 * correctly, every time, with the failure mode being that one person's private
 * bookmark shows up in a channel.
 *
 * ## Saving is `channel:read`, not `message:create`
 *
 * You may bookmark anything you can read, including in a channel where a
 * `viewer` tuple gives you no voice at all. Requiring the ability to POST would
 * mean a read-only participant cannot keep a reference to something they were
 * shown, which is a restriction with no purpose behind it.
 *
 * ## Access is re-checked on READ, not trusted from the save
 *
 * `listSaved` re-authorizes every channel a saved message belongs to and drops
 * the ones that no longer pass. That matters: a save made while you were in a
 * private channel outlives your membership in it, and a list that trusted the
 * stored row would keep showing you content from a conversation you were
 * removed from. The row survives — it is your bookmark — and stops resolving.
 */

export interface SavedMessage {
  readonly messageId: string;
  readonly channelId: string;
  readonly savedAt: Date;
}

/** Saves a message for the caller. Idempotent — saving twice is not an error. */
export async function saveMessage(
  actor: ChatActor,
  input: { readonly messageId: MessageId },
): Promise<{ readonly saved: true }> {
  const orgId = orgOf(actor);

  return withOrgScope(orgId, async (tx) => {
    const message = await loadMessageRow(tx, input.messageId);
    const channel = await loadChannel(tx, message.channelId as ChannelId);

    enforceOnChannel(actor, 'channel:read', channel);
    if (message.deletedAt !== null) throw errors.notFound();

    await tx
      .insert(schema.savedMessages)
      .values({
        orgId,
        userId: userOf(actor),
        channelId: message.channelId,
        messageId: input.messageId,
      })
      /* A double-clicked bookmark is not something to report. The primary key
         is (org, user, message), so this is the whole idempotency. */
      .onConflictDoNothing();

    await outboxWriter.append(tx, [
      createEvent(
        messageSaved,
        { messageId: input.messageId, channelId: message.channelId, saved: true },
        envelopeOf(actor),
      ),
    ]);

    return { saved: true as const };
  });
}

export async function unsaveMessage(
  actor: ChatActor,
  input: { readonly messageId: MessageId },
): Promise<{ readonly saved: false }> {
  const orgId = orgOf(actor);

  return withOrgScope(orgId, async (tx) => {
    /* No channel check on the way OUT. Removing your own bookmark must keep
       working after you lose access to the channel it points at — otherwise a
       stale save is one you can see in your list and never get rid of. */
    const removed = await tx
      .delete(schema.savedMessages)
      .where(
        and(
          eq(schema.savedMessages.userId, userOf(actor)),
          eq(schema.savedMessages.messageId, input.messageId),
        ),
      )
      .returning({ channelId: schema.savedMessages.channelId });

    const row = removed[0];
    if (row !== undefined) {
      await outboxWriter.append(tx, [
        createEvent(
          messageSaved,
          { messageId: input.messageId, channelId: row.channelId, saved: false },
          envelopeOf(actor),
        ),
      ]);
    }

    return { saved: false as const };
  });
}

/**
 * The caller's saved messages, newest first, with the ones they can no longer
 * read dropped.
 *
 * The re-check is the interesting part — see the note at the top of the file.
 */
export async function listSaved(actor: ChatActor): Promise<readonly SavedMessage[]> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const rows = await tx
      .select({
        messageId: schema.savedMessages.messageId,
        channelId: schema.savedMessages.channelId,
        savedAt: schema.savedMessages.savedAt,
      })
      .from(schema.savedMessages)
      .where(eq(schema.savedMessages.userId, userOf(actor)))
      .orderBy(desc(schema.savedMessages.savedAt));

    const visible: SavedMessage[] = [];

    /* One `can()` per DISTINCT channel, not per saved message — a person with
       forty saves in one channel asks once. `can()` is pure, so the only cost
       being avoided is the channel read. */
    const decided = new Map<string, boolean>();

    for (const row of rows) {
      let allowed = decided.get(row.channelId);

      if (allowed === undefined) {
        try {
          const channel = await loadChannel(tx, row.channelId as ChannelId);
          enforceOnChannel(actor, 'channel:read', channel);
          allowed = true;
        } catch {
          /* Removed from the channel, or the channel is gone. The bookmark
             stays in the table — it is theirs — and simply stops resolving. */
          allowed = false;
        }
        decided.set(row.channelId, allowed);
      }

      if (allowed) visible.push(row);
    }

    return visible;
  });
}
