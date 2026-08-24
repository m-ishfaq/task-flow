import type { Wire } from '@taskflow/client';
import { colors } from '@taskflow/tokens';
import type { MobileTRPCClient } from './trpc-client.js';

/**
 * Search (Phase 8) — one TQL query across cards, messages, pages, comments
 * and call transcripts, ported from `apps/web/src/features/search`.
 *
 * ## There is no separate "free text" endpoint, and none is needed
 *
 * Web has exactly one search surface — a TQL text box — not a plain-text
 * mode plus a separate query-builder. That reads as more than this app
 * needs until you notice `packages/filter/src/tql/parse.ts`'s `freeText()`:
 * a bare typed word is already COMPLETE, valid TQL (it desugars to
 * `text contains "word"` at parse time), so a plain search box that forwards
 * whatever the user typed straight through as `query` is not a reduced
 * version of web's feature — it is the same feature, minus the live
 * per-token underline and the saved-search CRUD list, neither of which a
 * modal has room for anyway. `@taskflow/filter`'s parser is intentionally
 * NOT a dependency of this app: if a power user types real TQL syntax and
 * gets it wrong, the server's own `VALIDATION` error surfaces exactly the
 * way any other tRPC error does here — there is no local pre-check to keep
 * in sync with the server's.
 *
 * ## The facet is honest, same as web
 *
 * `withFacet` appends `AND type = <kind>` to the typed text rather than
 * filtering a fetched list client-side — one query source of truth, same
 * as `search-page.tsx`'s own comment on this.
 *
 * ## Authorization is already done by the time a hit reaches this file
 *
 * `apps/api/src/search/router.ts`'s own header: the index answers WHICH
 * ORG, never WHICH RESOURCE — the route re-checks `can()` per hit before
 * returning it, so a card in a board this user cannot read is already
 * dropped server-side. This file (and `search-modal.tsx`) must not
 * re-derive that decision; it only has to render what it was handed and
 * treat every nullable field as possibly null, per `SearchHit`'s own shape.
 */

export type SearchHit = Wire<
  Awaited<ReturnType<MobileTRPCClient['search']['query']['query']>>
>[number];

export type SearchFacet = SearchHit['type'] | 'all';

export const SEARCH_FACETS: readonly { readonly id: SearchFacet; readonly label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'card', label: 'Cards' },
  { id: 'message', label: 'Messages' },
  { id: 'page', label: 'Pages' },
  { id: 'comment', label: 'Comments' },
  /* Transcripts are gated by role alone (`recording:read`, no target) —
     shown to every member anyway, same as web's own chip: hiding it would
     be this UI re-deriving an authorization decision the server already
     makes correctly. A member who picks it gets an honest empty result,
     not a missing option. */
  { id: 'transcript', label: 'Transcripts' },
];

export const SEARCH_TYPE_LABEL: Readonly<Record<SearchHit['type'], string>> = {
  card: 'Card',
  message: 'Message',
  page: 'Page',
  comment: 'Comment',
  transcript: 'Transcript',
};

/** Mirrors web's `TYPE_BADGE`, as native color values instead of Tailwind classes. */
export const SEARCH_TYPE_COLOR: Readonly<Record<SearchHit['type'], string>> = {
  card: colors.accent.hex,
  message: colors.success.hex,
  page: colors.warning.hex,
  comment: colors.inkMuted.hex,
  transcript: colors.danger.hex,
};

/** Appends the facet's type constraint onto the typed query — never a client-side filter. */
export function withFacet(query: string, facet: SearchFacet): string {
  if (facet === 'all') return query;
  const clause = `type = ${facet}`;
  const trimmed = query.trim();
  return trimmed === '' ? clause : `${trimmed} AND ${clause}`;
}

/** `title` is nullable on the wire — the same `"<Kind> · <id>"` fallback web renders. */
export function hitTitle(hit: SearchHit): string {
  return hit.title ?? `${SEARCH_TYPE_LABEL[hit.type]} · ${hit.entityId}`;
}

export function searchQueryKey(effectiveQuery: string): readonly ['search.query', string] {
  return ['search.query', effectiveQuery];
}
