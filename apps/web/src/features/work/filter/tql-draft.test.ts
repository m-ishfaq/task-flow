import { describe, expect, it } from 'vitest';
import { compare, validate } from '@taskflow/filter';
import { asGroup, countComparisons, draftToTql, interpretTql } from './tql-draft.js';

/**
 * The board's TQL text box (§3.1, PLAN.md §10.2's "editing the text reparses
 * into chips").
 *
 * The round trip itself — `parse(format(tree)) === tree` — is already a
 * property test in `packages/filter` over both field sets, so it is not
 * re-asserted here. What this file covers is the part that is specific to a
 * BOARD, and that no round-trip property can catch: three inputs the parser
 * accepts happily and that must not become a card filter.
 */

describe('interpretTql — what a board accepts', () => {
  it('reads an ordinary card filter into the same tree the builder edits', () => {
    const result = interpretTql('priority = high AND archived = false');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.group.combinator).toBe('and');
    expect(countComparisons(result.group)).toBe(2);
    /* The point of the shared AST: what the text produced is a tree the SAME
       validator accepts, so the Builder tab renders it as chips with no
       conversion step in between. */
    expect(validate('card', result.group).ok).toBe(true);
  });

  it('treats empty text as "no filter", not as a parse error', () => {
    /* Clearing the box is how a filter is removed. Reporting that as broken
       would make the empty state look like a bug. */
    for (const text of ['', '   ', '\n']) {
      const result = interpretTql(text);
      expect(result.ok).toBe(true);
      if (result.ok) expect(countComparisons(result.group)).toBe(0);
    }
  });

  it('keeps @me symbolic rather than resolving it', () => {
    /* `creator`, not `assignee`: `assignee` is a `uuid_array` and `=` is not
       one of its operators (`assignee in (me)` is the array form). The card
       field set is closed and its shapes are not interchangeable — the same
       thing this suite's first run got wrong twice. */
    const result = interpretTql('creator = me');
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    /* A saved view that resolved `@me` at edit time would mean "assigned to
       whoever built it" for everyone else who opened it — 0014's own trap. */
    expect(JSON.stringify(result.group)).toContain('@me');
  });
});

describe('interpretTql — what a board refuses, though TQL allows it', () => {
  it('refuses ORDER BY, which parses fine and belongs to the toolbar', () => {
    const result = interpretTql('status = todo ORDER BY due ASC');
    expect(result.ok).toBe(false);
    if (result.ok) return;

    /* Not a parse failure — the grammar has ORDER BY for the search page. A
       board's sort is a separate persisted control, so accepting one here
       would leave the board with two orderings and only one of them visible. */
    expect(result.message).toContain('toolbar');
  });

  it('explains a bare term instead of reporting `Unknown field "text"`', () => {
    const result = interpretTql('outage');
    expect(result.ok).toBe(false);
    if (result.ok) return;

    /* Free text desugars to `text contains outage`, and `text` is a SEARCH
       field, not a card one. The raw validator message is accurate and
       actionable by nobody — a user who typed a word never mentioned a field
       called "text". */
    expect(result.message).toContain('Search page');
    expect(result.message).not.toContain('Unknown field');
  });

  it('refuses a field that exists on search but not on cards', () => {
    /* `author` is the search projection's field; a card has `creator`. Both
       field sets are closed and they are NOT the same set — the assumption
       that they overlap is exactly what the saved-search suite got wrong on
       its first run. */
    const result = interpretTql('author = me');
    expect(result.ok).toBe(false);
  });

  it('refuses a syntax error with the parser’s own positioned message', () => {
    const result = interpretTql('status =');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message.length).toBeGreaterThan(0);
  });
});

describe('draftToTql', () => {
  it('renders an empty draft as the empty string, never as "()"', () => {
    /* `format` emits `()` for an empty group, which would put two characters
       in the box that then fail to parse — an editor that breaks itself by
       being opened. */
    expect(draftToTql(asGroup(null))).toBe('');
  });

  it('round-trips a real filter back through interpretTql', () => {
    const group = asGroup(compare('priority', 'eq', 'high'));
    const text = draftToTql(group);

    const back = interpretTql(text);
    expect(back.ok).toBe(true);
    if (back.ok) expect(countComparisons(back.group)).toBe(1);
  });
});
