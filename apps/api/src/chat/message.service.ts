import {
  and,
  asc,
  desc,
  eq,
  exists,
  isNull,
  lt,
  not,
  or,
  schema,
  withOrgScope,
  outboxWriter,
} from '@taskflow/db';
import { errors, type ChannelId, type MessageId } from '@taskflow/contracts';
import { createEvent } from '@taskflow/events';
import { newId } from '@taskflow/security';
import { messageDeleted, messageEdited, messageHidden, messageSent } from './events.js';
import { unfurlMessage } from './unfurl.service.js';
import { channelMemberIds } from './membership.js';
import {
  flattenToText,
  mentionedUserIds,
  plainParagraph,
  type RichTextNode,
} from '../work/richtext.js';
import {
  enforceOnChannel,
  envelopeOf,
  loadChannel,
  orgOf,
  userOf,
  type ChatActor,
} from './shared.js';

/**
 * Messages (PLAN.md §3.2; ai/phase-5-chat.md §3.5, §3.9).
 *
 * ## The socket never gets here
 *
 * Every function below is reached through tRPC and only through tRPC. CLAUDE.md
 * rule 8 and §3.5 are explicit that this is the phase where the shortcut is most
 * tempting — a client emitting `message.sent` over the already-open socket and
 * the gateway relaying it looks like the obvious low-latency design, and it
 * bypasses validation, authorization, audit, and the outbox in one move. The
 * realtime layer broadcasts what these functions have already committed.
 *
 * ## Editing and deleting are asymmetric, deliberately
 *
 * Only the AUTHOR may edit. There is no permission that overrides it, and one
 * must never be added: a discussion where an administrator can put words in your
 * mouth is not a record of anything. Deleting is different — an author may
 * withdraw their own message, and a moderator holding `message:delete` may
 * remove someone else's — and the event records which, because "a moderator
 * removed a message" is the interesting audit entry and "someone deleted their
 * own typo" is not. This is the same split `comment.service.ts` draws, on
 * purpose: two collaboration surfaces answering the same question differently
 * would be a difference nobody chose.
 *
 * ## Reading a message means reading its channel
 *
 * Every function here loads the CHANNEL and enforces against that, never against
 * the message. A message has no independent authorization — it is readable
 * exactly when its channel is, which for a private channel or DM means holding a
 * membership tuple (§3.3). Enforcing on the message would need a `message`
 * target with no tuple ever pointing at it, and would answer from the org role
 * alone: every member reading every DM.
 */

export interface MessageSummary {
  readonly messageId: string;
  readonly channelId: string;
  readonly parentMessageId: string | null;
  readonly authorId: string | null;
  readonly body: unknown;
  readonly bodyText: string;
  readonly editedAt: Date | null;
  readonly deletedAt: Date | null;
  readonly createdAt: Date;
}

/** How many messages one page may hold. */
const MAX_PAGE_SIZE = 100;

/**
 * The predicate `messages.list` and `listThread` both append to exclude
 * hidden messages: a message the CURRENT VIEWER has "removed for me" is not
 * returned to them, and is returned to everyone else unchanged — the hide row
 * is keyed on the viewer, so this is a per-viewer filter even though it reads
 * like a global one. The exclusion happens in SQL, not in JavaScript, because
 * paging happens here: a hidden message filtered out after the page was
 * selected would silently shorten a 100-message page and pull older messages
 * up into view.
 *
 * `userOf(actor)` is the value from the verified token, never client input,
 * and the hide row itself is tenant-scoped by RLS — so this can never test
 * against another tenant's hide, and a caller cannot name a victim. */
function notHiddenBy(actor: ChatActor, tx: ChatTx) {
  return not(
    exists(
      tx
        .select({ one: schema.messageHidden.userId })
        .from(schema.messageHidden)
        .where(
          and(
            eq(schema.messageHidden.userId, userOf(actor)),
            eq(schema.messageHidden.messageId, schema.messages.id),
          ),
        ),
    ),
  );
}

/**
 * A channel's messages, newest first, paged by id.
 *
 * ## Why the cursor is an id and not an offset or a timestamp
 *
 * Ids are UUIDv7 — creation-ordered AND unique — so `id < cursor` is a total
 * order with no ties. An OFFSET re-reads rows that shifted while the user was
 * scrolling, which in a channel receiving messages means duplicates and gaps on
 * every page boundary. A `created_at` cursor has the same problem more subtly:
 * two messages can share a millisecond, and the one that loses the tie is
 * skipped forever.
 *
 * Returned newest-first because that is the page the client needs first — a chat
 * view opens at the bottom. The client reverses for display.
 */
export async function listMessages(
  actor: ChatActor,
  input: {
    readonly channelId: ChannelId;
    readonly limit?: number;
    /** Return messages older than this id. Omit for the most recent page. */
    readonly before?: MessageId | null;
  },
): Promise<readonly MessageSummary[]> {
  const limit = Math.min(input.limit ?? 50, MAX_PAGE_SIZE);

  return withOrgScope(orgOf(actor), async (tx) => {
    const channel = await loadChannel(tx, input.channelId);
    enforceOnChannel(actor, 'channel:read', channel);

    const olderThan = input.before ?? null;

    const rows = await tx
      .select({
        messageId: schema.messages.id,
        channelId: schema.messages.channelId,
        parentMessageId: schema.messages.parentMessageId,
        authorId: schema.messages.authorId,
        body: schema.messages.body,
        bodyText: schema.messages.bodyText,
        editedAt: schema.messages.editedAt,
        deletedAt: schema.messages.deletedAt,
        createdAt: schema.messages.createdAt,
      })
      .from(schema.messages)
      .where(
        and(
          notHiddenBy(actor, tx),
          // Synthetic carriers that were deleted after a failed upload are
          // excluded entirely — no tombstone for any participant, ever.
          or(eq(schema.messages.isSynthetic, false), isNull(schema.messages.deletedAt)),
          olderThan === null
            ? eq(schema.messages.channelId, input.channelId)
            : and(
                eq(schema.messages.channelId, input.channelId),
                lt(schema.messages.id, olderThan),
              ),
        ),
      )
      .orderBy(desc(schema.messages.id))
      .limit(limit);

    /* A deleted message keeps its place and loses its content. Returning the
       body of a deleted message would make "delete" mean "hide in the UI",
       which is not what the person clicking it believes — and the row is still
       returned so a threaded reply has a parent to point at. */
    return rows.map((row) => (row.deletedAt === null ? row : { ...row, body: null, bodyText: '' }));
  });
}

/** One thread's replies, oldest first — the panel a client opens on a message. */
export async function listThread(
  actor: ChatActor,
  input: { readonly messageId: MessageId },
): Promise<readonly MessageSummary[]> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const parent = await loadMessage(tx, input.messageId);
    const channel = await loadChannel(tx, parent.channelId as ChannelId);
    enforceOnChannel(actor, 'channel:read', channel);

    const rows = await tx
      .select({
        messageId: schema.messages.id,
        channelId: schema.messages.channelId,
        parentMessageId: schema.messages.parentMessageId,
        authorId: schema.messages.authorId,
        body: schema.messages.body,
        bodyText: schema.messages.bodyText,
        editedAt: schema.messages.editedAt,
        deletedAt: schema.messages.deletedAt,
        createdAt: schema.messages.createdAt,
      })
      .from(schema.messages)
      .where(and(notHiddenBy(actor, tx), eq(schema.messages.parentMessageId, input.messageId)))
      .orderBy(asc(schema.messages.id))
      .limit(MAX_PAGE_SIZE);

    return rows.map((row) => (row.deletedAt === null ? row : { ...row, body: null, bodyText: '' }));
  });
}

/**
 * Posts a message. `message:create` on the channel.
 *
 * Not `channel:manage` and not `channel:read`: posting is its own capability, so
 * that a `viewer` tuple can give someone a read-only seat in a channel and a
 * `member` tuple can let a guest talk in exactly one place (§3.9). Both of those
 * fall out of the relation grants without a branch here.
 */
export async function sendMessage(
  actor: ChatActor,
  input: {
    readonly channelId: ChannelId;
    readonly body: RichTextNode;
    readonly parentMessageId?: MessageId | null;
    readonly isSynthetic?: boolean;
  },
): Promise<{ readonly messageId: MessageId }> {
  const messageId = newId<'MessageId'>();
  const orgId = orgOf(actor);

  /* Returned FROM the transaction rather than assigned into an outer variable:
     TypeScript cannot see an assignment made inside an async callback, so the
     outer binding narrows to `never` and every read of it is an error. Returning
     also makes the ordering explicit — the unfurl runs only on the value a
     COMMITTED transaction produced. */
  const sent = await withOrgScope(orgId, async (tx) => {
    const channel = await loadChannel(tx, input.channelId);
    enforceOnChannel(actor, 'message:create', channel);

    if (channel.archivedAt !== null) {
      throw errors.validation({ channelId: 'This channel is archived.' });
    }

    /* Replies are ONE level deep. The composite FK in migration 0017 stops a
       reply naming a parent in a different CHANNEL; depth is a product rule the
       database cannot express without a trigger, so it lives here — the same
       division 0013 draws for comment replies. A parent that is itself a reply,
       belongs to another channel, or was deleted all answer the same way: this
       cannot be replied to. */
    /* Captured for the notification payload as well as validated: the parent
       is already being read, and its author is who a thread reply notifies. */
    let parentAuthorId: string | null = null;

    if (input.parentMessageId != null) {
      const parent = await loadMessage(tx, input.parentMessageId);
      if (parent.channelId !== input.channelId) throw errors.notFound();
      if (parent.deletedAt !== null) throw errors.notFound();
      if (parent.parentMessageId !== null) {
        throw errors.validation({ parentMessageId: 'Replies cannot themselves be replied to.' });
      }
      parentAuthorId = parent.authorId;
    }

    /* A DM notifies its participants whether or not anybody was @mentioned —
       that is what makes it direct. A NAMED channel does not: the same rule
       there would notify every member of every message, which is how a bell
       becomes something people turn off. */
    const directRecipientIds =
      channel.type === 'dm' || channel.type === 'group_dm'
        ? (await channelMemberIds(tx, input.channelId)).filter((id) => id !== userOf(actor))
        : [];

    const bodyText = flattenToText(input.body);
    if (bodyText.length === 0) {
      /* A document that renders to nothing is an empty message with structure.
         Storing it produces a line nobody can see and a notification about
         nothing. */
      throw errors.validation({ body: 'A message cannot be empty.' });
    }

    await tx.insert(schema.messages).values({
      id: messageId,
      orgId,
      channelId: input.channelId,
      parentMessageId: input.parentMessageId ?? null,
      authorId: userOf(actor),
      body: input.body,
      bodyText,
      isSynthetic: input.isSynthetic ?? false,
    });

    await outboxWriter.append(tx, [
      createEvent(
        messageSent,
        {
          messageId,
          channelId: input.channelId,
          parentMessageId: input.parentMessageId ?? null,
          // Words, not a document: a notification cannot render TipTap JSON.
          excerpt: bodyText.slice(0, 280),
          mentionedUserIds: mentionedUserIds(input.body),

          /* Read here, in the transaction that already holds the channel and
             the parent, so the notification consumer does not have to make two
             queries per message at chat write rates against rows that may have
             changed since. */
          channelName: channel.name,
          parentAuthorId: parentAuthorId,
          directRecipientIds: directRecipientIds,
        },
        envelopeOf(actor),
      ),
    ]);

    return { bodyText };
  });

  /* Link previews, AFTER the transaction commits and deliberately not awaited
     (§7.6). The message is already written and already broadcast; fetching a
     third-party URL is a network round trip to a host we do not control, and
     making the send wait on it turns one slow site into a hanging send button.
     The preview arrives as its own `message.unfurled` event a moment later.

     Errors are swallowed rather than surfaced: this runs after the caller has
     been told the message was sent, so there is nowhere for a failure to go but
     an unhandled rejection — and `unfurlMessage` already records a `failed` row
     for anything it could not fetch. */
  void unfurlMessage(
    {
      orgId,
      channelId: input.channelId,
      messageId,
      actorId: userOf(actor),
      requestId: actor.requestId,
    },
    sent.bodyText,
  ).catch(() => undefined);

  return { messageId };
}

/**
 * Creates an upload CARRIER — the placeholder message a file attaches to when
 * the composer is empty (apps/mobile's attach flow posts one, then PUTs the
 * file onto it).
 *
 * ## Why this is a route of its own, not `isSynthetic` on `sendMessage`
 *
 * `isSynthetic` is what makes a message vanish from `listMessages` once
 * deleted — no "message deleted" tombstone for anyone. That is exactly right
 * for a carrier whose upload failed, and exactly wrong as a capability any
 * client can assert on an ordinary message: a caller could mark a real,
 * content-bearing message synthetic and then delete it to erase it silently
 * for everyone else. So the flag is set HERE, by the server, never accepted
 * from a client on `send` (which now ignores the legacy field), and the body
 * is BUILT here from the filename — a carrier can only ever be the
 * "Shared <name>" placeholder it claims to be, never arbitrary content.
 */
export async function sendUploadCarrier(
  actor: ChatActor,
  input: { readonly channelId: ChannelId; readonly filename: string },
): Promise<{ readonly messageId: MessageId }> {
  const filename = input.filename.trim();
  if (filename.length === 0 || filename.length > 255) {
    throw errors.validation({ filename: 'A filename is required.' });
  }
  return sendMessage(actor, {
    channelId: input.channelId,
    body: plainParagraph(`Shared ${filename}`),
    isSynthetic: true,
  });
}

/**
 * Edits a message. Author only.
 *
 * There is deliberately no permission that overrides this — see the note at the
 * top of the file. The `message:create` check below is not the authorization for
 * the edit; it establishes that the caller can still participate in the channel
 * at all, so that someone removed from a private channel cannot keep rewriting
 * their history in it from a stale tab.
 */
export async function editMessage(
  actor: ChatActor,
  input: { readonly messageId: MessageId; readonly body: RichTextNode },
): Promise<{ readonly edited: true }> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const message = await loadMessage(tx, input.messageId);
    const channel = await loadChannel(tx, message.channelId as ChannelId);

    enforceOnChannel(actor, 'message:create', channel);

    if (message.deletedAt !== null) throw errors.notFound();

    /* Not a permission check — an identity check. Comparing the author to the
       caller is not a role comparison, so guardrail 7 has nothing to say about
       it, and there is no permission that could express "your own". */
    if (message.authorId !== userOf(actor)) {
      throw errors.forbidden('You can only edit your own messages.');
    }

    const bodyText = flattenToText(input.body);
    if (bodyText.length === 0) {
      throw errors.validation({ body: 'A message cannot be empty.' });
    }

    await tx
      .update(schema.messages)
      .set({ body: input.body, bodyText, editedAt: new Date() })
      .where(eq(schema.messages.id, input.messageId));

    await outboxWriter.append(tx, [
      createEvent(
        messageEdited,
        {
          messageId: input.messageId,
          channelId: message.channelId,
          excerpt: bodyText.slice(0, 280),
          mentionedUserIds: mentionedUserIds(input.body),
        },
        envelopeOf(actor),
      ),
    ]);

    return { edited: true as const };
  });
}

/**
 * Deletes a message — the author's own, or anyone's with `message:delete`.
 *
 * A tombstone, not a row removal: a thread keeps its shape, and a reply that
 * quotes the deleted message still has something to point at. The composite FK
 * on `parent_message_id` would cascade a real DELETE through every reply, which
 * is the other reason this is an UPDATE.
 */
export async function deleteMessage(
  actor: ChatActor,
  input: { readonly messageId: MessageId },
): Promise<{ readonly deleted: true }> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const message = await loadMessage(tx, input.messageId);
    const channel = await loadChannel(tx, message.channelId as ChannelId);

    if (message.deletedAt !== null) throw errors.notFound();

    const byAuthor = message.authorId === userOf(actor);

    /* An author withdrawing their own message needs only the ability to post;
       removing someone else's is moderation and needs the moderation
       permission. `enforce` answers 404 rather than 403 when the caller cannot
       read the channel at all, so this does not confirm a message exists to
       someone with no access to it. */
    enforceOnChannel(actor, byAuthor ? 'message:create' : 'message:delete', channel);

    await tx
      .update(schema.messages)
      .set({ deletedAt: new Date(), deletedByAuthor: byAuthor })
      .where(eq(schema.messages.id, input.messageId));

    await outboxWriter.append(tx, [
      createEvent(
        messageDeleted,
        {
          messageId: input.messageId,
          channelId: message.channelId,
          byAuthor,
          /* Always 'user' on this path. Wave 4's retention sweep emits the same
             event with 'retention_policy' — see the event definition on why the
             field exists before its second value does. */
          reason: 'user' as const,
        },
        envelopeOf(actor),
      ),
    ]);

    return { deleted: true as const };
  });
}

/**
 * "Remove for me" — the per-viewer half of Slack's two-way delete.
 *
 * Writes a `chat.message_hidden` row and does NOT touch the message itself: a
 * hidden message stays live for every other member, and the tombstone delete
 * above is what "remove for everyone" means. The row is keyed on the ACTOR's
 * verified user id, never on input, so a caller cannot hide a message on
 * someone else's behalf — the same trust split `message_reactions` draws, and
 * the same reason the composite FK pins the row to a real message.
 *
 * Permission is `message:read`: hiding changes the VIEWER's own list, exactly
 * like marking a channel read, and is offered to anyone who can read the
 * channel at all.
 *
 * A `message.hidden` event IS emitted, and this sentence used to say the
 * opposite ("No domain event — nothing happened to the message") nineteen
 * lines above the `outboxWriter.append` that emits one. Guardrail 11's rule is
 * that a state-mutating service method emits, and this method writes a row.
 *
 * Nothing consumes it today and nothing broadcasts it: `message.hidden` is
 * absent from every table in `apps/realtime/src/event-rooms.ts`, which is what
 * keeps "this person hid a message" out of the channel everyone else is
 * sitting in. That absence is load-bearing — adding it to a room table would
 * publish one viewer's private list management to the whole room.
 */
export async function hideMessage(
  actor: ChatActor,
  input: { readonly messageId: MessageId },
): Promise<{ readonly hidden: true }> {
  return withOrgScope(orgOf(actor), async (tx) => {
    const message = await loadMessage(tx, input.messageId);
    const channel = await loadChannel(tx, message.channelId as ChannelId);

    if (message.deletedAt !== null) throw errors.notFound();
    enforceOnChannel(actor, 'message:read', channel);

    /* `onConflictDoNothing` — a repeat "remove for me" on a message that is
       already hidden resolves to the same `{ hidden: true }` instead of
       throwing the composite PK's unique violation (0075). Clicking a button
       twice is not an error the person needs to see. */
    await tx
      .insert(schema.messageHidden)
      .values({
        orgId: orgOf(actor),
        channelId: message.channelId as ChannelId,
        messageId: input.messageId,
        userId: userOf(actor),
      })
      .onConflictDoNothing();

    await outboxWriter.append(tx, [
      createEvent(
        messageHidden,
        {
          messageId: input.messageId,
          channelId: message.channelId,
          userId: userOf(actor),
        },
        envelopeOf(actor),
      ),
    ]);

    return { hidden: true as const };
  });
}

/* -------------------------------------------------------------------------- *
 * Internals
 * -------------------------------------------------------------------------- */

type ChatTx = Parameters<Parameters<typeof withOrgScope>[1]>[0];

interface MessageRow {
  readonly orgId: string;
  readonly channelId: string;
  readonly parentMessageId: string | null;
  readonly authorId: string | null;
  readonly deletedAt: Date | null;
}

async function loadMessage(tx: ChatTx, messageId: MessageId): Promise<MessageRow> {
  const rows = await tx
    .select({
      orgId: schema.messages.orgId,
      channelId: schema.messages.channelId,
      parentMessageId: schema.messages.parentMessageId,
      authorId: schema.messages.authorId,
      deletedAt: schema.messages.deletedAt,
    })
    .from(schema.messages)
    .where(eq(schema.messages.id, messageId))
    .limit(1);

  const message = rows[0];
  if (!message) throw errors.notFound();
  return message;
}
