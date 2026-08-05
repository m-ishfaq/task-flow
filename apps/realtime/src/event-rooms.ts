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
    if (name.startsWith(NEVER_BROADCAST_PREFIX)) {
      throw new UnsafeRoomMappingError(name, ATTACHMENT_REASON);
    }
    if (PROJECT_SCOPED_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      throw new UnsafeRoomMappingError(name, PROJECT_SCOPED_REASON);
    }
    if (name === 'board.created') {
      throw new UnsafeRoomMappingError(name, BOARD_CREATED_REASON);
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

/** Every event name currently routed to a room. For tests and diagnostics. */
export function broadcastEventNames(): readonly string[] {
  return Object.keys(BOARD_KEY_OF);
}
