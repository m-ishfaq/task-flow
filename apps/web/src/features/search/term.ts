import type { FilterNode } from '@taskflow/filter';

/**
 * The first free-text term in a parsed query, if any (ai/phase-8-search.md §3).
 *
 * A `text contains "<term>"` comparison is what makes a query a SEARCH rather
 * than a filter. The page uses the term exactly once: to highlight the matched
 * span in each hit's snippet. Highlighting is CLIENT-side on purpose — the
 * server's excerpt is text, never markup (the XSS shape this codebase refuses,
 * §8.7 of PLAN.md), and the client owns the term because it owns the input.
 *
 * This mirrors `apps/api/src/search/postgres-provider.ts`'s `freeTextTerm`
 * deliberately: same tree-walk, same "first term only" rule, so the span the
 * client highlights is the span the server ranked and excerpted around. If the
 * two ever disagree, the highlight simply lands on a word the excerpt already
 * contains — cosmetic, never wrong.
 */
export function freeTextTermOf(node: FilterNode | null): string | null {
  if (node === null) return null;

  if (node.kind === 'comparison') {
    /* The search field set's `text` field is type `text` and `contains` takes a
       scalar, so a non-string value is rejected by validate long before this
       runs; anything else arriving here is no term. */
    return node.field === 'text' && node.operator === 'contains' && typeof node.value === 'string'
      ? node.value
      : null;
  }

  if (node.kind === 'not') return freeTextTermOf(node.child);

  for (const child of node.children) {
    const term = freeTextTermOf(child);
    if (term !== null) return term;
  }
  return null;
}

export interface HighlightPart {
  readonly text: string;
  /** True when this part is an occurrence of the matched term. */
  readonly match: boolean;
}

/**
 * Splits `text` on every case-insensitive occurrence of `term`.
 *
 * Renders as a `<mark>` around the matches. The server's excerpt is anchored
 * around the term's FIRST occurrence (§2.6), but a query term can appear
 * several times in one excerpt, and highlighting every occurrence is what
 * "search results" look like to a person.
 *
 * Empty `term` returns the text unsplit — a pure-filter query (no free text)
 * has nothing to highlight.
 */
export function splitOnTerm(text: string, term: string): readonly HighlightPart[] {
  const needle = term.trim().toLowerCase();
  if (needle === '') return [{ text, match: false }];

  const parts: HighlightPart[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const at = text.toLowerCase().indexOf(needle, cursor);
    if (at === -1) break;

    if (at > cursor) parts.push({ text: text.slice(cursor, at), match: false });
    parts.push({ text: text.slice(at, at + needle.length), match: true });
    cursor = at + needle.length;
  }

  if (cursor < text.length) parts.push({ text: text.slice(cursor), match: false });
  /* An unmatched `term` (the excerpt was anchored on a different field, or the
     hit's body was NULL and the title doesn't contain it) is rendered whole —
     the honest "no highlight" rather than an empty list. */
  return parts.length === 0 ? [{ text, match: false }] : parts;
}
