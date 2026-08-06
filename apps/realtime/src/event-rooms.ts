/**
 * Which room does a domain event belong to? (ai/phase-4-realtime.md §3.4)
 *
 * ## Why this is not `RESOURCE_OF`
 *
 * `apps/api/src/tenancy/audit.projection.ts` already has an event-name lookup,
 * and reusing it is the obvious move. It is also wrong, and wrong in a way that
 * would produce a working system with a silent bug.
 *
 * The two tables answer different questions. Audit's resolves `card.moved` to
 * `{ type: 'card', key: 'cardId' }` because that is the precise resource a
 * compliance record should name. Realtime needs the BOARD — a card room would
 * multiply join traffic for a subscriber nobody has, since no client watches one
 * card without its board open. So for the SAME event the correct answer is a
 * different key of the same payload.
 *
 * Sharing one table would mean a correct audit mapping becoming a wrong room
 * mapping the first time someone "simplified" the duplication away — and a wrong
 * room mapping does not fail. It delivers a board's events to a room nobody is
 * in, which looks exactly like a quiet board.
 *
 * ## The shape is the control
 *
 * A fixed literal lookup, exactly like audit's and like `packages/filter`'s
 * field table. An event name is a key into this map; it is never a string a
 * caller composes, and an unknown name resolves to null rather than to a guess.
 * Inferring "the key ending in BoardId" would work for most of these and would
 * silently route the one event whose payload names two boards.
 */

/**
 * Event name → the payload key holding the board id its room is named after.
 *
 * Wave 2 (ai/phase-4-realtime.md §5) fills this in to every event §4 named
 * that a SINGLE board room can actually carry — see the two exclusion notes
 * below for the ones that cannot.
 */
const BOARD_KEY_OF: Readonly<Record<string, string>> = {
  'card.created': 'boardId',
  'card.updated': 'boardId',
  'card.moved': 'boardId',
  'card.assigned': 'boardId',
  'card.archived': 'boardId',
  'card.status_changed': 'boardId',
  'card.labeled': 'boardId',
  'card.field_set': 'boardId',

  'list.created': 'boardId',
  'list.updated': 'boardId',
  'list.reordered': 'boardId',
  'list.archived': 'boardId',
  'list.rebalanced': 'boardId',

  /* NOT 'board.created' — see the exclusion note below. */
  'board.updated': 'boardId',
  'board.archived': 'boardId',

  'comment.created': 'boardId',
  'comment.updated': 'boardId',
  'comment.deleted': 'boardId',

  /* boardId added to these five payloads in Phase 4 Wave 2 specifically so
     this table could name them — see the comment on their definitions in
     apps/api/src/work/events.ts. */
  'checklist.created': 'boardId',
  'checklist.deleted': 'boardId',
  'checklist_item.created': 'boardId',
  'checklist_item.updated': 'boardId',
  'checklist_item.deleted': 'boardId',

  'view.created': 'boardId',
  'view.updated': 'boardId',
  'view.deleted': 'boardId',
};

/**
 * Event name → the payload key holding the channel id its room is named after
 * (ai/phase-5-chat.md §3.4).
 *
 * The SAME mechanism as `BOARD_KEY_OF`, a second table rather than a second
 * code path — §3.4 asks for rows, not for chat-specific room-resolution logic.
 * Two tables rather than one because the two rooms are keyed on different
 * payload fields and a single map would need a discriminator that is itself a
 * judgment call at broadcast time.
 *
 * `channel.member_added` and `channel.member_removed` are absent, and NOT by
 * oversight. Broadcasting them to `channel:{id}` would tell everyone currently
 * in a private channel who just joined or left, which is fine — but the socket
 * that actually needs to act on a removal is the REMOVED person's, and that
 * socket is by definition no longer entitled to the room the message would be
 * sent to. That eviction is `revocation.ts`'s job, driven by the `grant.revoked`
 * event the tuple write produces, and adding a room mapping here would make it
 * look as though the broadcast were doing the work.
 *
 * `channel.created` is absent for the same reason `board.created` is: no client
 * can have joined a room for a channel whose id it has never seen, so the
 * broadcast would always have zero subscribers and would look like a working
 * feature under any test that does not check who received it.
 */
const CHANNEL_KEY_OF: Readonly<Record<string, string>> = {
  'message.sent': 'channelId',
  'message.edited': 'channelId',
  'message.deleted': 'channelId',

  /* A rename or a topic change is visible to everyone with the channel open,
     and unlike a label rename (see the project-scoped note below) it names
     exactly one room. */
  'channel.updated': 'channelId',

  /* Archiving stops a channel accepting messages. Everyone watching needs to
     know, and they are all in the one room this names. */
  'channel.archived': 'channelId',

  /* Reactions and pins (Wave 2, ai/phase-5-chat.md §5) — everyone with the
     channel open needs to see the reaction bar or the pinned-messages panel
     update, and both events carry exactly one channelId. */
  'message.reaction_added': 'channelId',
  'message.reaction_removed': 'channelId',
  'message.pinned': 'channelId',
  'message.unpinned': 'channelId',

  /* Link previews finished loading (Wave 3, §7.6's async call). Its own event
     rather than a second `message.edited`, because nobody edited anything —
     see the definition. Carries a count, never the preview content: a room
     broadcast is not the place for metadata a third-party server chose. */
  'message.unfurled': 'channelId',

  /* A file arrived on a message, or was removed. Carries a channel and a
     message and NOTHING else — no filename, no attachment id, no URL — which
     is what makes it safe to broadcast where `message_attachment.*` is banned.
     A client refetches the attachment list over authorized HTTP, exactly as
     §3.10 prescribes. Without this the uploader saw their own file and nobody
     else did, because the ban left the room with no signal at all. */
  'message.attachments_changed': 'channelId',

  /* `channel.read_advanced` is deliberately ABSENT. A read cursor is personal
     state — nobody else viewing the channel needs to learn where ONE person
     has scrolled to, and broadcasting it would turn the highest-frequency
     write in this phase into the highest-frequency room broadcast too. */
};

/**
 * Deliberately absent, and NOT an oversight: `attachment.*` (§4).
 *
 * A presigned download URL is a bearer credential for the file it names. If an
 * attachment event is ever added here, its broadcast payload carries an
 * `attachmentId` and the client re-requests a URL through the normal authorized
 * HTTP path — the URL itself must never be relayed to a room, whose audience is
 * everyone currently subscribed rather than the one caller who asked.
 *
 * Kept as a runtime assertion rather than a comment alone, because "we all know
 * not to" is exactly the kind of knowledge that does not survive a new
 * contributor filling in the Wave 2 catalog from the §4 list.
 */
const NEVER_BROADCAST_PREFIX = 'attachment.';

/**
 * Any event whose RESOURCE names an attachment, however it is prefixed.
 *
 * `NEVER_BROADCAST_PREFIX` above catches Work's `attachment.*`. It does not
 * catch chat's, which are `message_attachment.*` — a name chosen because event
 * names are unique across the whole registry and `attachment.uploaded` was
 * already taken. A `startsWith('attachment.')` check would have let every one
 * of them through, and the thing that would then be broadcast to a channel room
 * is a presigned download URL: a bearer credential handed to everyone currently
 * subscribed.
 *
 * So the test is on the resource segment rather than the start of the string.
 * Written as a rule about what the event IS, not about how it happens to be
 * spelled today, because the next attachment-adjacent slice (Docs page
 * attachments, §3.3) will pick a third prefix.
 */
function namesAnAttachment(name: string): boolean {
  const resource = name.slice(0, name.indexOf('.'));
  return resource.split('_').includes('attachment');
}

/**
 * Also deliberately absent, for two DIFFERENT reasons than the attachment ban
 * — worth naming so a future "just add it" pass has to read this first.
 *
 * `board.created` names a board that did not exist a moment ago. No client
 * can have joined `board:{boardId}` for a board whose id it has never seen,
 * so this room always has zero subscribers and the broadcast is a no-op that
 * would look, incorrectly, like a working feature under any test that does
 * not check WHO received it.
 *
 * `label.*`, `custom_field.*`, and `status.*` (created/updated/deleted/
 * archived) are PROJECT-scoped vocabulary changes, not board-scoped ones —
 * their event payloads carry `projectId`, never a single `boardId`, because a
 * project commonly has more than one board and a rename affects every card
 * carrying that label or field across all of them. This table's whole design
 * (§3.4) is one fixed key per event, precisely because "which room" must
 * never be a judgment call made at broadcast time — and there is no single
 * board room that is the right answer for a project-wide change. Routing it
 * to "every board under the project" would need a project-room concept
 * §3.1 does not have, or a per-broadcast database lookup this table exists
 * to avoid. Left on the existing 30-second `staleTime` poll (`lib/query.ts`)
 * instead: renaming a label is a low-frequency admin action, not a board
 * interaction, and the gap this leaves is a wait of at most half a minute —
 * not a silently broken feature.
 */
const PROJECT_SCOPED_PREFIXES = ['label.', 'custom_field.', 'status.'] as const;

/** Thrown at boot, not at broadcast time — see `assertRoomTableIsSafe`. */
export class UnsafeRoomMappingError extends Error {
  constructor(name: string, reason: string) {
    super(`Event "${name}" must not be mapped to a room. ${reason} See ai/phase-4-realtime.md §4.`);
    this.name = 'UnsafeRoomMappingError';
  }
}

const ATTACHMENT_REASON =
  'Attachment events carry presigned download URLs, which are bearer credentials for one ' +
  'file; broadcasting one hands it to every socket in the room. Broadcast the attachmentId ' +
  'and let the client request a URL over authorized HTTP.';

const PROJECT_SCOPED_REASON =
  'This event is project-scoped (payload carries projectId, not a single boardId) — a ' +
  'project commonly has more than one board, so no one board room is the right audience. ' +
  'Leave it on the polled query rather than guessing at a board, or routing it at broadcast ' +
  'time with a database lookup this table exists to avoid.';

const BOARD_CREATED_REASON =
  '"board.created" names a board no client has ever seen, so its room always has zero ' +
  'subscribers — the broadcast would be a silent no-op, not a working feature.';

const CHANNEL_CREATED_REASON =
  '"channel.created" names a channel no client has ever joined, so its room always has zero ' +
  'subscribers — the same silent no-op as "board.created". A client learns about a new ' +
  'channel from the polled channel list, not from a room it cannot be in.';

const DUAL_ROOM_REASON =
  'This event is mapped to BOTH a board room and a channel room. They are different rooms on ' +
  'different namespaces with independently authorized membership, so it would be delivered ' +
  'twice to two audiences — and a mistake in either is invisible from inside the other.';

/**
 * Fails the process at boot if the table above ever grows a forbidden entry.
 *
 * At boot rather than at broadcast time on purpose: a check that fires when the
 * event happens fires in production, on a real attachment, after the row is
 * already in the outbox. This one fires in CI, on every developer's machine,
 * before a connection has been accepted.
 */
export function assertRoomTableIsSafe(): void {
  for (const name of Object.keys(BOARD_KEY_OF)) {
    if (name.startsWith(NEVER_BROADCAST_PREFIX) || namesAnAttachment(name)) {
      throw new UnsafeRoomMappingError(name, ATTACHMENT_REASON);
    }
    if (PROJECT_SCOPED_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      throw new UnsafeRoomMappingError(name, PROJECT_SCOPED_REASON);
    }
    if (name === 'board.created') {
      throw new UnsafeRoomMappingError(name, BOARD_CREATED_REASON);
    }
  }

  for (const name of Object.keys(CHANNEL_KEY_OF)) {
    /* The attachment ban applies identically to chat (§3.10). Chat file sharing
       reuses the existing pipeline, so `attachment.uploaded` is exactly as much
       of a bearer credential in a channel as it is on a card — and a channel
       room is a larger audience. */
    if (name.startsWith(NEVER_BROADCAST_PREFIX) || namesAnAttachment(name)) {
      throw new UnsafeRoomMappingError(name, ATTACHMENT_REASON);
    }
    if (name === 'channel.created') {
      throw new UnsafeRoomMappingError(name, CHANNEL_CREATED_REASON);
    }
    /* A channel and a board are different rooms on different namespaces. One
       event mapped into both would be delivered twice, to two audiences whose
       membership was decided by two different `can()` calls — and the one that
       is wrong would be invisible, because each broadcast looks correct from
       inside its own namespace. */
    if (name in BOARD_KEY_OF) {
      throw new UnsafeRoomMappingError(name, DUAL_ROOM_REASON);
    }
  }
}

/**
 * The board id an event should be broadcast to, or null if it has no room.
 *
 * Null covers both "this event type is not broadcast" and "this event's payload
 * did not carry the board id the table expects". The second is a defect, but the
 * correct response to it is still to not broadcast: a malformed payload is not a
 * reason to guess at an audience.
 */
export function roomBoardIdOf(name: string, payload: unknown): string | null {
  const key = BOARD_KEY_OF[name];
  if (key === undefined) return null;

  if (typeof payload !== 'object' || payload === null) return null;

  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * The channel id an event should be broadcast to, or null if it has no room.
 *
 * Same contract as `roomBoardIdOf`: null covers both "not a broadcast event" and
 * "the payload did not carry the id the table expects", and the correct response
 * to the second is still not to broadcast. A malformed payload is not a reason
 * to guess at an audience — and on this table the audience is a private
 * conversation.
 */
export function roomChannelIdOf(name: string, payload: unknown): string | null {
  const key = CHANNEL_KEY_OF[name];
  if (key === undefined) return null;

  if (typeof payload !== 'object' || payload === null) return null;

  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Every event name currently routed to a board room. For tests and diagnostics. */
export function broadcastEventNames(): readonly string[] {
  return Object.keys(BOARD_KEY_OF);
}

/** Every event name currently routed to a channel room. */
export function chatBroadcastEventNames(): readonly string[] {
  return Object.keys(CHANNEL_KEY_OF);
}
