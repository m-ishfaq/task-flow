/**
 * Keyset cursor pagination for the two org-level admin lists that grow without
 * bound — automations and webhooks (§6.6). Both are ordered by `(name, id)`,
 * and the cursor carries BOTH so the order it resumes from is TOTAL. A name is
 * per-org unique today (`webhooks_org_name_key` and automations' own name
 * constraint), so `name` alone would resume correctly — but a cursor whose
 * correctness depends on a uniqueness constraint elsewhere is one that breaks
 * silently the day that constraint is relaxed, losing or repeating a row at the
 * page boundary. The id tie-breaker makes the order total on its own terms,
 * the same reason the people directory keys on `user_id` rather than `joined_at`.
 *
 * Keyset, not OFFSET, for the same reason the rest of the codebase paginates
 * this way: a row inserted or deleted between two page loads shifts every
 * OFFSET after it, silently dropping or duplicating a row. `(name, id) >
 * (cursor.name, cursor.id)` resumes from a value, not a position, so
 * concurrent edits cannot corrupt the sequence.
 */

/** The default page size, matching the platform-admin console's own. */
export const PAGE_DEFAULT = 25;
/** The largest page a caller may request. */
export const PAGE_MAX = 100;

/** The boundary between two pages of a `(name, id)`-ordered list. */
export interface NameKeyCursor {
  readonly name: string;
  readonly id: string;
}

/**
 * Encodes a cursor as an opaque token.
 *
 * Opaque but UNSIGNED, deliberately: the value only ever feeds a `WHERE (name,
 * id) > ...` on an already org-scoped query, so a tampered cursor can at worst
 * return a differently-positioned page WITHIN the caller's own org — never a
 * cross-tenant row (RLS forbids it) and never more than the caller may see. It
 * is base64 only so a name with a comma or a quote survives the round trip, not
 * for secrecy — the same posture platform-admin's plain string cursors take.
 */
export function encodeNameKeyCursor(cursor: NameKeyCursor): string {
  return Buffer.from(JSON.stringify([cursor.name, cursor.id]), 'utf8').toString('base64url');
}

/** Decodes a cursor, or null if it is malformed — a bad cursor starts from the top, never errors. */
export function decodeNameKeyCursor(raw: string): NameKeyCursor | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === 'string' &&
      typeof parsed[1] === 'string'
    ) {
      return { name: parsed[0], id: parsed[1] };
    }
    return null;
  } catch {
    return null;
  }
}
