import { z } from 'zod';
import { defineEvent } from '@taskflow/events';

/**
 * Chat domain events — guardrail 11 (PLAN.md §10.6; ai/phase-5-chat.md §4).
 *
 * Five consumers wait on these, and only one of them exists today: audit now,
 * then realtime broadcast (the `/chat` namespace, §3.4), notifications resolving
 * @mentions (Phase 9), search indexing (Phase 8), automation triggers on
 * "message posted matching a pattern" (Phase 10).
 *
 * ## Payloads carry the room, always
 *
 * Every event here carries `channelId`, including the ones whose subject is a
 * message. That is not redundancy — it is the realtime layer's entire routing
 * key. §3.4 requires the event→room table to derive a room from a fixed field on
 * the payload, never from a lookup, because a consumer that has to read the
 * database to learn which room an event belongs to is a consumer that fans out
 * one query per broadcast on the busiest path in the product.
 *
 * ## What is deliberately NOT here
 *
 * `typing.*` — never a domain event (§3.5). A typing indicator has no persisted
 * state, so there is nothing for guardrail 11 to require an event for; it is
 * relayed in-process on the already-joined room and dies with the connection.
 * Adding it here would put a row in the outbox — and therefore in the compliance
 * record — every time someone presses a key.
 *
 * `attachment.*` — already excluded from the realtime catalog by Phase 4 §4,
 * and chat reuses that exclusion rather than needing its own (§3.10). A
 * presigned download URL is a bearer credential; broadcasting one to a room
 * hands it to everyone currently subscribed.
 *
 * `channel.visibility_changed` — named in §4's catalog but has no emitter in
 * Wave 1, because `channels.update` deliberately does not change `type`. A
 * registered event nothing emits is worse than an absent one: a consumer
 * subscribes to it, the subscription is never exercised, and the first time it
 * fires is in production. It arrives with the route that changes visibility.
 */

/* -------------------------------------------------------------------------- *
 * Channels
 * -------------------------------------------------------------------------- */

/**
 * A channel was created.
 *
 * `memberCount` rather than the member list. A group DM can be created with a
 * large participant set, and an outbox payload is replayed into an audit log
 * that keeps it forever — the same reasoning that keeps the filter tree out of
 * `view.created`. Who is in a channel is answered by `channel.member_added`,
 * one event per person, which is also the granularity the force-leave logic in
 * §3.3 needs.
 */
export const channelCreated = defineEvent(
  'channel.created',
  z
    .object({
      channelId: z.string(),
      type: z.string(),
      /** Null for a DM — a named DM is a channel wearing DM authorization. */
      name: z.string().nullable(),
      memberCount: z.number().int().nonnegative(),
    })
    .strict(),
);

/**
 * A channel's name or topic changed.
 *
 * Carries `before` as well as `after`, like every other update event here: an
 * event saying only what a field became cannot answer whether anything actually
 * changed, which is the question every downstream filter asks first.
 */
export const channelUpdated = defineEvent(
  'channel.updated',
  z
    .object({
      channelId: z.string(),
      before: z.object({ name: z.string().nullable(), topic: z.string().nullable() }).strict(),
      after: z.object({ name: z.string().nullable(), topic: z.string().nullable() }).strict(),
    })
    .strict(),
);

/**
 * A channel was archived or restored.
 *
 * One event with a `restored` boolean rather than two names, matching
 * `board.archived` and `list.archived`: consumers care about the transition,
 * and splitting it would make each of them subscribe twice to reconstruct a
 * boolean.
 *
 * This is also a force-leave trigger (§3.3). An archived channel stops
 * accepting messages, so a socket still joined to its room is subscribed to
 * something that can no longer produce events — harmless today, and exactly the
 * kind of stale subscription that becomes a leak when "archived" later grows to
 * mean "hidden from members".
 */
export const channelArchived = defineEvent(
  'channel.archived',
  z
    .object({
      channelId: z.string(),
      name: z.string().nullable(),
      restored: z.boolean(),
    })
    .strict(),
);

/**
 * Someone was added to a channel.
 *
 * One event per person, not a set diff like `card.assigned`. The difference is
 * the consumer: assignment changes are read by a notification that needs both
 * sides to know who to un-notify, whereas channel membership is read by the
 * gateway's force-leave logic, which acts on ONE socket's authorization and has
 * no use for the rest of the set. A batched payload would make that consumer
 * iterate a list to find itself.
 */
export const channelMemberAdded = defineEvent(
  'channel.member_added',
  z
    .object({
      channelId: z.string(),
      userId: z.string(),
      /** Null when someone joined a public channel themselves. */
      addedBy: z.string().nullable(),
    })
    .strict(),
);

/**
 * Someone was removed from a channel, or left.
 *
 * The event the gateway must act on within one relay tick (§3.3): a socket
 * joined to `channel:{channelId}` whose `channel:read` no longer passes keeps
 * receiving every message in a channel the person was just removed from, for as
 * long as the tab stays open. That is the failure this event exists to prevent,
 * which is why it is emitted for a voluntary leave as well — the gateway cannot
 * tell the two apart and must force-leave either way.
 */
export const channelMemberRemoved = defineEvent(
  'channel.member_removed',
  z
    .object({
      channelId: z.string(),
      userId: z.string(),
      /** Whether the person left of their own accord rather than being removed. */
      voluntary: z.boolean(),
    })
    .strict(),
);

/* -------------------------------------------------------------------------- *
 * Messages
 * -------------------------------------------------------------------------- */

/**
 * A message was posted — the highest-volume event this system emits.
 *
 * `excerpt` is flattened text, not the TipTap document, for the same reason
 * `comment.created` carries one: a notification cannot render JSON, and the
 * outbox row is replayed into an audit log that keeps whatever is put in it.
 * The full body is read from the row by the one consumer that needs it.
 *
 * `mentionedUserIds` is extracted from the document at write time rather than
 * left for the notification consumer to re-parse. Parsing rich text in a
 * consumer means the mention rules live in two places, and the copy that
 * decides who gets notified would be the one with no test on it.
 */
export const messageSent = defineEvent(
  'message.sent',
  z
    .object({
      messageId: z.string(),
      channelId: z.string(),
      /** Null for a top-level message, the parent's id for a threaded reply. */
      parentMessageId: z.string().nullable(),
      excerpt: z.string(),
      mentionedUserIds: z.array(z.string()).readonly(),
    })
    .strict(),
);

export const messageEdited = defineEvent(
  'message.edited',
  z
    .object({
      messageId: z.string(),
      channelId: z.string(),
      excerpt: z.string(),
      mentionedUserIds: z.array(z.string()).readonly(),
    })
    .strict(),
);

/**
 * A message was removed.
 *
 * `byAuthor` distinguishes an author withdrawing their own message from a
 * moderator removing someone else's — the same split `comment.deleted` records,
 * and for the same reason: "moderator removed a message" is the interesting
 * entry in an audit log and "author deleted their own typo" is not.
 *
 * `reason` exists now, with only `'user'` reachable, because Wave 4's retention
 * sweep emits this same event with `'retention_policy'` (§3.7) and adding the
 * field later would mean every consumer written against the Wave 1 shape treats
 * a policy deletion as a user one. A field that is constant today and load-
 * bearing in two waves' time is cheaper to add now than to migrate into.
 */
export const messageDeleted = defineEvent(
  'message.deleted',
  z
    .object({
      messageId: z.string(),
      channelId: z.string(),
      byAuthor: z.boolean(),
      reason: z.enum(['user', 'retention_policy']),
    })
    .strict(),
);

/* -------------------------------------------------------------------------- *
 * Reactions and pins (Wave 2, ai/phase-5-chat.md §5)
 * -------------------------------------------------------------------------- */

export const messageReactionAdded = defineEvent(
  'message.reaction_added',
  z
    .object({
      messageId: z.string(),
      channelId: z.string(),
      userId: z.string(),
      emoji: z.string(),
    })
    .strict(),
);

export const messageReactionRemoved = defineEvent(
  'message.reaction_removed',
  z
    .object({
      messageId: z.string(),
      channelId: z.string(),
      userId: z.string(),
      emoji: z.string(),
    })
    .strict(),
);

export const messagePinned = defineEvent(
  'message.pinned',
  z
    .object({
      messageId: z.string(),
      channelId: z.string(),
      pinnedBy: z.string(),
    })
    .strict(),
);

export const messageUnpinned = defineEvent(
  'message.unpinned',
  z
    .object({
      messageId: z.string(),
      channelId: z.string(),
    })
    .strict(),
);

/* -------------------------------------------------------------------------- *
 * Read cursors (§3.6) — excluded from the audit projection ON PURPOSE.
 *
 * This event still exists, still satisfies guardrail 11, and still goes
 * through the outbox — what's different is the one consumer that reads
 * EVERY event unconditionally today. `apps/api/src/tenancy/audit.projection.ts`
 * claims and marks this event dispatched exactly like any other (so the
 * exactly-once bookkeeping stays true), but skips writing it into
 * `audit.audit_log`. See that file's `NEVER_AUDITED` set and the migration's
 * header comment for why: a read cursor advances on ordinary scrolling, and
 * "user read up to message X" is not a compliance-relevant fact at any volume
 * this event will actually see.
 * -------------------------------------------------------------------------- */

export const channelReadAdvanced = defineEvent(
  'channel.read_advanced',
  z
    .object({
      channelId: z.string(),
      userId: z.string(),
      lastReadMessageId: z.string(),
    })
    .strict(),
);

/* -------------------------------------------------------------------------- *
 * Message attachments (Wave 3, ai/phase-5-chat.md §3.10)
 *
 * Named `message_attachment.*` rather than reusing Work's `attachment.*`: an
 * event name is unique across the whole registry (`defineEvent` throws on a
 * duplicate), and Work's payloads require `cardId` and `boardId`, which a chat
 * upload has neither of.
 *
 * ⚠ NONE of these may ever appear in `apps/realtime`'s event→room table. A
 * presigned download URL is a bearer credential for the file it names, and a
 * channel room's audience is everyone currently subscribed. Phase 4 §4 excludes
 * `attachment.*` for exactly this reason and §3.10 says chat reuses that
 * exclusion rather than needing its own. The boot-time assertion in
 * `event-rooms.ts` matches the word "attachment" ANYWHERE in the resource
 * segment specifically so this prefix is caught too — a check keyed on
 * `startsWith('attachment.')` would have let these straight through.
 *
 * What a client gets instead: `message.sent` carries the attachment id, and the
 * client asks for a URL over the normal authorized HTTP path.
 * -------------------------------------------------------------------------- */

const messageAttachmentRef = {
  attachmentId: z.string(),
  channelId: z.string(),
  /** Null while the upload is still being attached to a draft message. */
  messageId: z.string().nullable(),
  filename: z.string(),
};

/**
 * An upload URL was issued.
 *
 * Recorded for the same reason Work's is: a presigned PUT is a capability to
 * place bytes in this org's bucket, valid for minutes and usable by whoever
 * holds it. Auditing only successful uploads would leave the GRANT of that
 * capability invisible, and a run of presigns with no matching verdict is
 * either a broken client or someone probing the endpoint.
 */
export const messageAttachmentPresigned = defineEvent(
  'message_attachment.presigned',
  z
    .object({
      ...messageAttachmentRef,
      contentType: z.string(),
      declaredBytes: z.number().int().positive(),
    })
    .strict(),
);

/** Passed magic-byte verification and the virus scan. */
export const messageAttachmentUploaded = defineEvent(
  'message_attachment.uploaded',
  z
    .object({
      ...messageAttachmentRef,
      contentType: z.string(),
      sizeBytes: z.number().int().nonnegative(),
    })
    .strict(),
);

/**
 * Refused — infected, mistyped, or unscannable.
 *
 * All three, distinguished by `status`, because they are one thing to a user
 * ("that file was not accepted") and three very different things to whoever
 * reads the audit log. A run of `rejected` with a scan-failure reason is what a
 * broken clamd looks like before anyone notices.
 */
export const messageAttachmentRejected = defineEvent(
  'message_attachment.rejected',
  z
    .object({
      ...messageAttachmentRef,
      status: z.enum(['infected', 'rejected']),
      reason: z.string(),
    })
    .strict(),
);

/**
 * A download URL was issued.
 *
 * The event records the issuing of a capability, not its use: the fetch goes
 * browser-to-storage and never touches the API, so a URL that was minted and
 * never followed looks identical here.
 */
export const messageAttachmentDownloaded = defineEvent(
  'message_attachment.downloaded',
  z.object(messageAttachmentRef).strict(),
);

export const messageAttachmentDeleted = defineEvent(
  'message_attachment.deleted',
  z.object(messageAttachmentRef).strict(),
);

/* -------------------------------------------------------------------------- *
 * Link previews (Wave 3, ai/phase-5-chat.md §7.6)
 * -------------------------------------------------------------------------- */

/**
 * A message's link previews finished being fetched.
 *
 * Its own event rather than a second `message.edited`, and the distinction
 * matters to two consumers. `message.edited` means A PERSON changed what they
 * wrote — it moves `editedAt`, it shows an "edited" marker, and a notification
 * consumer may reasonably re-notify on it. An unfurl is none of those things:
 * nobody edited anything, the text is identical, and re-notifying a channel
 * because a preview card loaded would be absurd.
 *
 * Carries no preview CONTENT. The metadata came from a third-party server, it
 * is unbounded, and an outbox row is replayed into an audit log that keeps
 * whatever is put in it — so this says only "previews changed for this
 * message", and the client refetches them through the normal authorized read.
 * The same reasoning that keeps the filter tree out of `view.created`.
 */
export const messageUnfurled = defineEvent(
  'message.unfurled',
  z
    .object({
      messageId: z.string(),
      channelId: z.string(),
      /** How many previews resolved. Zero is a real outcome, not a failure. */
      previewCount: z.number().int().nonnegative(),
    })
    .strict(),
);

/* -------------------------------------------------------------------------- *
 * Retention, legal hold, and guests (Wave 4, ai/phase-5-chat.md §3.7, §3.8)
 * -------------------------------------------------------------------------- */

/**
 * A channel's retention window changed.
 *
 * Carries both sides because the interesting audit question is the DIRECTION:
 * shortening a window is a decision to destroy data that would otherwise have
 * been kept, and it takes effect on the next sweep with no further approval.
 * An event recording only the new value cannot distinguish that from someone
 * lengthening it.
 *
 * Null on either side means "keep forever" — a real value, and the default.
 */
export const channelRetentionChanged = defineEvent(
  'channel.retention_changed',
  z
    .object({
      channelId: z.string(),
      before: z.number().int().nullable(),
      after: z.number().int().nullable(),
    })
    .strict(),
);

/**
 * A legal hold was placed or lifted.
 *
 * `scope` distinguishes a whole-channel hold from a single message, because
 * they are answers to different questions — "preserve this conversation" versus
 * "preserve this statement" — and an access review needs to tell them apart.
 *
 * LIFTING a hold is the entry that matters most here. Placing one is cautious;
 * removing one makes messages eligible for deletion on the very next sweep, and
 * "who un-held this, and when" is the question asked after data that should
 * have been preserved is gone.
 */
export const legalHoldChanged = defineEvent(
  'legal_hold.changed',
  z
    .object({
      channelId: z.string(),
      /** Null for a channel-wide hold. */
      messageId: z.string().nullable(),
      scope: z.enum(['channel', 'message']),
      held: z.boolean(),
    })
    .strict(),
);

/**
 * A compliance export was produced.
 *
 * The export itself is never in the payload — it is the entire contents of a
 * channel, and an outbox row is replayed into an audit log that keeps whatever
 * is put in it. What is recorded is that somebody took a copy, of what, and how
 * much: exporting a private channel is one of the most sensitive operations in
 * the product, and it is invisible unless this event exists.
 */
export const complianceExported = defineEvent(
  'compliance.exported',
  z
    .object({
      channelId: z.string(),
      messageCount: z.number().int().nonnegative(),
      includesDeleted: z.boolean(),
    })
    .strict(),
);

/** A guest was granted access to a channel, or had it revoked. */
export const channelGuestChanged = defineEvent(
  'channel.guest_changed',
  z
    .object({
      channelId: z.string(),
      userId: z.string(),
      granted: z.boolean(),
      /** ISO timestamp when the access lapses, or null for no expiry. */
      expiresAt: z.string().nullable(),
    })
    .strict(),
);

/**
 * A message's attachments changed — one arrived, or one was removed.
 *
 * ## Why this exists when `message_attachment.uploaded` already does
 *
 * `message_attachment.*` is banned from the realtime room table, and the ban is
 * right: Phase 4 §4 and §3.10 exclude attachment events because a presigned
 * download URL is a bearer credential and a room's audience is everyone
 * subscribed. `event-rooms.ts` enforces it at boot on the word "attachment"
 * anywhere in the resource segment.
 *
 * But the ban left a real hole. Nothing told the ROOM that a file had appeared,
 * so the person who uploaded it saw their own attachment (their client
 * invalidates locally) and nobody else did — a file shared into a channel was
 * invisible to the channel until someone reloaded.
 *
 * So this is the signal, shaped to be safe to broadcast: it carries a channel
 * and a message and NOTHING ELSE. No filename, no id, no size, no URL. A client
 * that receives it refetches the attachment list through the normal authorized
 * HTTP path, which is exactly what §3.10 prescribes — "the client re-requests a
 * presigned URL through the normal authorized HTTP path".
 *
 * The same shape as `message.unfurled`, for the same reason: the interesting
 * fact is "something about this message changed", and the content of the change
 * is a read the recipient is authorized for, not a payload to push.
 */
export const messageAttachmentsChanged = defineEvent(
  'message.attachments_changed',
  z.object({ messageId: z.string(), channelId: z.string() }).strict(),
);
