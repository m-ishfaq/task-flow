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
 * Wave 1 seeds only the two events its acceptance criteria name (§5). Everything
 * else resolves to null and is skipped — dispatched, so it does not accumulate,
 * but broadcast nowhere. Wave 2 fills in the rest of the §4 catalog.
 */
const BOARD_KEY_OF: Readonly<Record<string, string>> = {
  'card.created': 'boardId',
  'card.moved': 'boardId',
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

/** Thrown at boot, not at broadcast time — see `assertRoomTableIsSafe`. */
export class UnsafeRoomMappingError extends Error {
  constructor(name: string) {
    super(
      `Event "${name}" must not be mapped to a room. Attachment events carry presigned ` +
        'download URLs, which are bearer credentials for one file; broadcasting one hands ' +
        'it to every socket in the room. Broadcast the attachmentId and let the client ' +
        'request a URL over authorized HTTP. See ai/phase-4-realtime.md §4.',
    );
    this.name = 'UnsafeRoomMappingError';
  }
}

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
    if (name.startsWith(NEVER_BROADCAST_PREFIX)) throw new UnsafeRoomMappingError(name);
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
