/**
 * Duplicate-card detection at creation time (product brainstorm: "no
 * duplicate-card detection" — a real source of the sprawl teams complain
 * about in Jira/Asana).
 *
 * Entirely a client-side wrapper around the search that already exists —
 * `search.query` already indexes every card with trigram-backed `ILIKE`
 * substring matching, so this needs no new backend route, no new
 * permission, and no new schema. The only new code is deciding WHEN to fire
 * a query and what to send: a plain `` `type:card <title>` `` TQL string,
 * bare terms desugaring to `text contains <term>` automatically.
 *
 * `buildDuplicateQuery` is exported and tested directly — the pure half of
 * this feature — the same "test the pure half" split this codebase already
 * holds `neighbours.ts`/`markdown-lite.tsx` to, since the component itself
 * is mostly wiring (a debounce effect, a query, a dropdown) around this one
 * decision.
 */

/** Below this many characters a partial title matches too much to be useful. */
export const MIN_DUPLICATE_QUERY_LENGTH = 3;

/** Advisory only — never more than a glance's worth of candidates. */
export const DUPLICATE_MATCH_LIMIT = 5;

/**
 * The TQL query for a duplicate check, or `null` when the title is too
 * short to search on yet.
 *
 * No escaping beyond a trim: bare free text is exactly what `search.query`
 * already accepts from the search page's own input box, and a title whose
 * literal text happens to break TQL syntax (an unbalanced quote, a bare
 * `AND`) simply fails to parse — the caller gates on that with the same
 * `parse()` check the search page itself already runs, so a query that
 * cannot be built safely is silently skipped rather than sent broken.
 */
export function buildDuplicateQuery(title: string): string | null {
  const trimmed = title.trim();
  if (trimmed.length < MIN_DUPLICATE_QUERY_LENGTH) return null;
  return `type:card ${trimmed}`;
}
