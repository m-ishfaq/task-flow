/**
 * Keyset pagination for the directory reads (orgs, users).
 *
 * The cursor is `createdAtMs:rowId`, an opaque pair. Ordering is
 * `created_at DESC, id DESC`, and the WHERE clause is the tuple comparison
 * `(created_at, id) < (cursorCreatedAt, cursorRowId)` — expressed in Drizzle
 * as `created_at < c OR (created_at = c AND id < r)` because Drizzle has no
 * row-value constructor.
 *
 * ## Why truncating the cursor timestamp to MILLISECONDS is correct
 *
 * Postgres stores `timestamptz` at microsecond precision; a JavaScript `Date`
 * carries milliseconds. The cursor date is therefore slightly truncated
 * relative to the row it came from. That is safe, and the direction is the
 * one that matters: a row created in the SAME millisecond as the cursor row
 * but a few microseconds LATER compares as `created_at > cursorDate` and is
 * excluded — which is correct, because in `created_at DESC` order it sorts
 * BEFORE the cursor row and was already on an earlier page. A row created
 * earlier in the same millisecond is `< cursorDate` and included. The only
 * rows that hit the exact-equality branch (`id < cursorRowId`) are those with
 * the identical microsecond — the cursor row's own instant — where the id
 * breaks the tie. No row is ever skipped, and none is ever repeated.
 */

/** `createdAtMs:rowId`. The ms prefix is opaque; nothing parses it back out. */
export function encodeCreatedCursor(createdAt: Date, rowId: string): string {
  return `${String(createdAt.getTime())}:${rowId}`;
}

export interface CreatedCursor {
  readonly createdAt: Date;
  readonly rowId: string;
}

/** Parses a cursor, or null for the first page. A malformed cursor starts over. */
export function parseCreatedCursor(cursor: string | null): CreatedCursor | null {
  if (cursor === null) return null;
  const colon = cursor.indexOf(':');
  if (colon <= 0) return null;

  const ms = Number(cursor.slice(0, colon));
  const rowId = cursor.slice(colon + 1);
  if (!Number.isFinite(ms) || rowId.length === 0) return null;

  const createdAt = new Date(ms);
  if (Number.isNaN(createdAt.getTime())) return null;
  return { createdAt, rowId };
}
