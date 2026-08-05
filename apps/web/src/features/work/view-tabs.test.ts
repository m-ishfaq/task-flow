import { describe, expect, it } from 'vitest';
import { matchingView, type BoardArrangement } from './view-match.js';
import type { SavedView } from './api.js';

/**
 * Which saved view the board is currently showing.
 *
 * Derived from the URL rather than stored, so this function is the whole
 * definition of "selected". Every way it can be wrong is quiet: a false match
 * highlights a tab whose filter is not the one applied, and a missed match
 * makes a view the user just clicked look like it did nothing.
 */

function view(overrides: Partial<SavedView> & { readonly viewId: string }): SavedView {
  return {
    boardId: 'board-1',
    name: overrides.viewId,
    type: 'board',
    groupBy: 'list',
    sortBy: 'manual',
    filter: null,
    filterBroken: false,
    visibleColumns: null,
    isShared: false,
    createdBy: 'user-1',
    position: 0,
    ...overrides,
  };
}

const plain: BoardArrangement = {
  type: 'board',
  groupBy: 'list',
  sortBy: 'manual',
  filter: null,
};

const filter = { kind: 'comparison', field: 'title', operator: 'contains', value: 'x' } as const;

describe('deriving the active tab', () => {
  it('matches a view whose four fields all agree', () => {
    expect(matchingView([view({ viewId: 'v1' })], plain)).toBe('v1');
  });

  it('does not match when only the grouping differs', () => {
    expect(matchingView([view({ viewId: 'v1', groupBy: 'status' })], plain)).toBeNull();
  });

  it('does not match when only the sort differs', () => {
    expect(matchingView([view({ viewId: 'v1', sortBy: 'due' })], plain)).toBeNull();
  });

  it('does not match when only the renderer differs', () => {
    expect(matchingView([view({ viewId: 'v1', type: 'table' })], plain)).toBeNull();
  });

  it('matches on filter structure, not identity', () => {
    /* The saved tree and the URL tree are different objects that came through
       different parsers. Comparing by reference would mean no filtered view
       ever highlighted. */
    const saved = view({ viewId: 'v1', filter: { ...filter } });
    expect(matchingView([saved], { ...plain, filter: { ...filter } })).toBe('v1');
  });

  it('deselects when the filter is edited away from the saved one', () => {
    const saved = view({ viewId: 'v1', filter: { ...filter } });
    const edited = { ...plain, filter: { ...filter, value: 'y' } };

    /* The honest outcome: at this point the board is no longer showing the
       saved thing, so no tab should claim it is. */
    expect(matchingView([saved], edited)).toBeNull();
  });

  it('never matches a view whose stored filter is broken', () => {
    /* A broken view's filter reads back as null, which would otherwise collide
       with an unfiltered board and highlight a tab that cannot be applied. */
    const broken = view({ viewId: 'v1', filter: null, filterBroken: true });
    expect(matchingView([broken], plain)).toBeNull();
  });

  it('treats stored nulls as the toolbar defaults', () => {
    // A view saved before a field existed stores null; the board renders the
    // default. They are the same arrangement and must match.
    const legacy = view({ viewId: 'v1', groupBy: null, sortBy: null });
    expect(matchingView([legacy], plain)).toBe('v1');
  });

  it('returns the first match when two views are identical', () => {
    expect(matchingView([view({ viewId: 'v1' }), view({ viewId: 'v2' })], plain)).toBe('v1');
  });

  it('returns null for an empty list rather than throwing', () => {
    expect(matchingView([], plain)).toBeNull();
  });
});
