import { describe, expect, it } from 'vitest';
import { EMPTY_SELECTION, pruneSelection, selectRange, toggle } from './selection.js';

const ordered = ['a', 'b', 'c', 'd', 'e'];

const withSelection = (ids: readonly string[], anchor: string | null = null) => ({
  selected: new Set(ids),
  anchor,
});

const ids = (state: { readonly selected: ReadonlySet<string> }) => [...state.selected].sort();

describe('clicking one card', () => {
  it('adds it and makes it the anchor', () => {
    const next = toggle(EMPTY_SELECTION, 'b');
    expect(ids(next)).toEqual(['b']);
    expect(next.anchor).toBe('b');
  });

  it('removes it when it was already selected', () => {
    expect(ids(toggle(withSelection(['a', 'b']), 'b'))).toEqual(['a']);
  });

  it('moves the anchor even when the click deselects', () => {
    /* The next shift-click extends from where the user last ACTED, not from
       wherever they last happened to add something. */
    expect(toggle(withSelection(['a', 'b'], 'a'), 'b').anchor).toBe('b');
  });
});

describe('shift-clicking a range', () => {
  it('selects everything between the anchor and the click, inclusive', () => {
    expect(ids(selectRange(withSelection(['b'], 'b'), 'd', ordered))).toEqual(['b', 'c', 'd']);
  });

  it('works upwards as well as downwards', () => {
    expect(ids(selectRange(withSelection(['d'], 'd'), 'b', ordered))).toEqual(['b', 'c', 'd']);
  });

  it('adds to the selection rather than replacing it', () => {
    /* Picking a run in one column and then a run in another means both. A
       replace would make the second gesture silently discard the first. */
    const state = withSelection(['a'], 'c');
    expect(ids(selectRange(state, 'd', ordered))).toEqual(['a', 'c', 'd']);
  });

  it('leaves the anchor where it was, so a longer shift-click keeps growing the same run', () => {
    const first = selectRange(withSelection(['b'], 'b'), 'c', ordered);
    expect(first.anchor).toBe('b');

    const second = selectRange(first, 'e', ordered);
    expect(ids(second)).toEqual(['b', 'c', 'd', 'e']);
  });

  it('selects only the clicked card when there is no anchor yet', () => {
    /* The session's first click was a shift-click. Guessing an anchor would
       select a swathe nobody pointed at. */
    expect(ids(selectRange(EMPTY_SELECTION, 'c', ordered))).toEqual(['c']);
  });

  it('falls back to the single card when the anchor is no longer visible', () => {
    // Filtered out, or archived by someone else while this was open.
    const state = withSelection(['z'], 'z');
    expect(ids(selectRange(state, 'c', ordered))).toEqual(['c', 'z']);
  });
});

describe('pruning to what is visible', () => {
  it('drops cards that are no longer on screen', () => {
    /* Otherwise the bulk bar counts cards nobody can see, and the action
       reaches rows the user believes they removed by narrowing the filter. */
    const state = withSelection(['a', 'z'], 'a');
    expect(ids(pruneSelection(state, ordered))).toEqual(['a']);
  });

  it('clears an anchor that is no longer visible', () => {
    expect(pruneSelection(withSelection(['a'], 'z'), ordered).anchor).toBeNull();
  });

  it('returns the same object when nothing was pruned', () => {
    // Identity matters: this runs in a render path, and a fresh object every
    // time would re-render forever.
    const state = withSelection(['a', 'b'], 'a');
    expect(pruneSelection(state, ordered)).toBe(state);
  });
});
