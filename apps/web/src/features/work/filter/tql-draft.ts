import { format, parse, validate, type FilterNode, type GroupNode } from '@taskflow/filter';

/**
 * Turning TQL text into a board filter draft (§3.1, PLAN.md §10.2).
 *
 * Split out of `filter-builder.tsx` for the reason `term.ts` is split out of
 * the search page: the interesting part is a decision, not a rendering, and a
 * decision that lives inside a component is one only a browser can check.
 *
 * Every refusal below is a case where the PARSER is perfectly happy and the
 * result would still be wrong for a board — which is exactly the class of bug
 * a type checker cannot see and a round-trip property test does not cover,
 * because both halves of the round trip succeed.
 */

/** An empty top-level group. `and` because a new filter narrows rather than widens. */
export const EMPTY_GROUP: GroupNode = { kind: 'group', combinator: 'and', children: [] };

export type TqlDraft =
  | { readonly ok: true; readonly group: GroupNode }
  | { readonly ok: false; readonly message: string };

/**
 * Reads TQL as a CARD filter.
 *
 * Empty text is "no constraint", not an error — clearing the box is how a user
 * removes a filter, and reporting that as a parse failure would make the empty
 * state look broken.
 */
export function interpretTql(text: string): TqlDraft {
  if (text.trim() === '') return { ok: true, group: EMPTY_GROUP };

  const parsed = parse(text);
  if (!parsed.ok) {
    return { ok: false, message: parsed.errors[0]?.message ?? 'That query could not be parsed.' };
  }

  /* `ORDER BY` is real grammar — the search page uses it — and is wrong here.
     A board's sort is a toolbar control with its own persisted value, so
     accepting a sort inside the filter would give one board two orderings
     that disagree, with no UI showing the second one. */
  if (parsed.orderBy !== null) {
    return { ok: false, message: 'Sorting is set by the board toolbar, not inside a filter.' };
  }

  if (parsed.filter === null) return { ok: true, group: EMPTY_GROUP };

  const checked = validate('card', parsed.filter);
  if (!checked.ok) {
    const first = checked.errors[0]?.message ?? 'That filter is not valid for cards.';
    /* A bare word desugars to `text contains …` (tql/parse.ts), and `text` is
       a field on the SEARCH resource, not on cards. So free text validates on
       the search page and can never validate here — a real difference between
       the two field sets, reported by the generic validator as `Unknown field
       "text"`, which is accurate and tells the user nothing they can act on. */
    return { ok: false, message: mentionsTextField(first) ? FREE_TEXT_HINT : first };
  }

  return { ok: true, group: asGroup(parsed.filter) };
}

/** Renders a draft back to canonical TQL. An empty group is the empty string, not `()`. */
export function draftToTql(group: GroupNode): string {
  return countComparisons(group) === 0 ? '' : format(group);
}

const FREE_TEXT_HINT =
  'Bare words search every product on the Search page. On a board, name a field — try `title contains …`.';

function mentionsTextField(message: string): boolean {
  return message.includes('"text"');
}

export function asGroup(node: FilterNode | null): GroupNode {
  if (node === null) return EMPTY_GROUP;
  if (node.kind === 'group') return node;
  return { kind: 'group', combinator: 'and', children: [node] };
}

export function countComparisons(node: FilterNode): number {
  if (node.kind === 'comparison') return 1;
  if (node.kind === 'not') return countComparisons(node.child);
  return node.children.reduce((total, child) => total + countComparisons(child), 0);
}
