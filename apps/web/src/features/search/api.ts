import { queryOptions } from '@tanstack/react-query';
import { api } from '../../lib/trpc.js';
import { wire } from '../../lib/wire.js';
import { keys } from '../../lib/query.js';

/**
 * Saved searches (§3.2).
 *
 * `broken` comes from the SERVER, which re-parses the stored TQL on every
 * list — the client does not re-derive it. Two parsers deciding independently
 * whether a saved query is usable is exactly the drift `wire.ts` exists to
 * prevent one level down.
 */
export function savedSearchesQuery(orgId: string) {
  return queryOptions({
    queryKey: keys.savedSearches(orgId),
    queryFn: async () => wire(await api.search.saved.list.query({})),
  });
}

/**
 * The search page's query (ai/phase-8-search.md §3.1).
 *
 * The input is TQL TEXT and the server is the only parser — this hook sends
 * exactly what the user typed (plus the type facet, which is a fixed, valid
 * suffix and not free text). Parse errors are caught client-side by the page
 * for the live per-token underline, but the SERVER re-parses and re-validates
 * on every request (§2.7), so a client whose parser drifted from the real one
 * gets a VALIDATION error, not a wrong result.
 */

/** The server's bound per query (§2.7) — the page states it rather than hiding it. */
export const SEARCH_LIMIT = 50;

export function searchResultsQuery(orgId: string, query: string) {
  const trimmed = query.trim();
  return queryOptions({
    queryKey: keys.search(orgId, trimmed),
    queryFn: async () => {
      // An empty query is "no constraint" server-side; the page shows the
      // prompt state instead of asking for everything.
      if (trimmed === '') return [];
      /* The route's output schema types `metadata` as the real union (§2.7),
         so `wire()` is identity here — it stays because the codebase rule is
         "call it once, at the boundary, on everything returned from the tRPC
         client", and the day `Wire` collapses it is a greppable list. */
      return wire(await api.search.query.query({ query: trimmed, limit: SEARCH_LIMIT }));
    },
    /* The hook itself stays enabled; the page gates on `enabled` via its own
       parse check, because "empty" and "unparseable" are different reasons to
       not fire and the caller knows which one it is. */
    enabled: trimmed !== '',
    /* Results change as the indexer folds events in the background — a short
       stale window absorbs rapid keystrokes without freezing a settled result
       set. */
    staleTime: 30_000,
  });
}
