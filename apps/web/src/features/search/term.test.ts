import { describe, expect, it } from 'vitest';
import { and, compare, not, or, type FilterNode } from '@taskflow/filter';
import { freeTextTermOf, splitOnTerm } from './term.js';

/**
 * The search page's two pure helpers (ai/phase-8-search.md §3).
 *
 * The highlight split is worth pinning because the failure mode is silent: a
 * bug that leaves the matched term un-highlighted reads exactly like "the
 * server's snippet doesn't contain the word", and nothing would say otherwise.
 * The term extraction is pinned because it must agree with the provider's own
 * walk — the client highlights the span the server ranked around.
 */

describe('freeTextTermOf', () => {
  it('returns the first `text contains` value in the tree', () => {
    const tree = and(
      compare('type', 'eq', 'card'),
      compare('text', 'contains', 'deploy outage'),
      compare('author', 'eq', '@me'),
    );
    expect(freeTextTermOf(tree)).toBe('deploy outage');
  });

  it('returns null for a pure filter query with no free text', () => {
    const tree = or(compare('type', 'eq', 'page'), compare('archived', 'eq', false));
    expect(freeTextTermOf(tree)).toBeNull();
    expect(freeTextTermOf(null)).toBeNull();
  });

  it('looks through groups and NOT', () => {
    const tree = not(and(compare('archived', 'eq', false), compare('text', 'contains', 'ship')));
    expect(freeTextTermOf(tree)).toBe('ship');
  });

  it('ignores contains comparisons on fields other than text', () => {
    /* A comparison on a non-search resource field can still be `contains` —
       the walk must not treat it as a term. */
    const tree = compare('title', 'contains', 'x') as FilterNode;
    expect(freeTextTermOf(tree)).toBeNull();
  });
});

describe('splitOnTerm', () => {
  it('highlights every case-insensitive occurrence', () => {
    expect(splitOnTerm('Ship the thing and ship it well', 'ship')).toEqual([
      { text: 'Ship', match: true },
      { text: ' the thing and ', match: false },
      { text: 'ship', match: true },
      { text: ' it well', match: false },
    ]);
  });

  it('returns the whole text unsplit when the term is absent or empty', () => {
    expect(splitOnTerm('nothing matches here', 'zzz')).toEqual([
      { text: 'nothing matches here', match: false },
    ]);
    expect(splitOnTerm('plain text', '')).toEqual([{ text: 'plain text', match: false }]);
  });

  it('matches a term at the very start and end of the text', () => {
    expect(splitOnTerm('deploy', 'deploy')).toEqual([{ text: 'deploy', match: true }]);
    expect(splitOnTerm('outage', 'outage')).toEqual([{ text: 'outage', match: true }]);
  });

  it('keeps a multi-word term together', () => {
    expect(splitOnTerm('the deploy outage window', 'deploy outage')).toEqual([
      { text: 'the ', match: false },
      { text: 'deploy outage', match: true },
      { text: ' window', match: false },
    ]);
  });
});
