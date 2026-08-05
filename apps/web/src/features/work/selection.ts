/**
 * Multi-select over an ordered list of cards (`ai/phase-3.5-work-ux.md` §6).
 *
 * Pure, and separate from the components that use it, because the two gestures
 * it has to support disagree about what "the list" means. A plain click toggles
 * one card and needs no context at all. A SHIFT-click selects a range, and a
 * range is only meaningful against the order the user is actually looking at —
 * which is the grouped, sorted, filtered order on screen, not the order the
 * server returned.
 *
 * Passing that order in, rather than reading it from a store, is what keeps
 * this testable and what stops a range selecting cards that are not visible.
 */

/** The card a range extends FROM — the last one clicked without shift. */
export interface SelectionState {
  readonly selected: ReadonlySet<string>;
  readonly anchor: string | null;
}

export const EMPTY_SELECTION: SelectionState = { selected: new Set(), anchor: null };

/**
 * A plain click: toggle one card, and make it the anchor.
 *
 * The anchor moves even when the click DESELECTS, because the next shift-click
 * extends from wherever the user last acted — not from wherever they last
 * happened to add something.
 */
export function toggle(state: SelectionState, cardId: string): SelectionState {
  const selected = new Set(state.selected);
  if (selected.has(cardId)) {
    selected.delete(cardId);
  } else {
    selected.add(cardId);
  }
  return { selected, anchor: cardId };
}

/**
 * A shift-click: select everything between the anchor and this card, inclusive.
 *
 * ADDS to the selection rather than replacing it. Someone shift-picking a run
 * in one column and then a run in another means both, and a replace would make
 * the second gesture silently discard the first.
 *
 * With no anchor — the first click of a session was a shift-click — this
 * degrades to selecting the one card. Guessing an anchor (the first visible
 * card, say) would select a swathe nobody pointed at.
 */
export function selectRange(
  state: SelectionState,
  cardId: string,
  ordered: readonly string[],
): SelectionState {
  if (state.anchor === null) return toggle(state, cardId);

  const from = ordered.indexOf(state.anchor);
  const to = ordered.indexOf(cardId);

  /* Either end missing means the anchor is no longer on screen — filtered out,
     moved, or archived by someone else while this was open. Falling back to the
     single card is the honest answer; a range measured against a list that no
     longer contains one of its endpoints is not a range the user drew. */
  if (from === -1 || to === -1) return toggle(state, cardId);

  const start = Math.min(from, to);
  const end = Math.max(from, to);

  const selected = new Set(state.selected);
  for (const id of ordered.slice(start, end + 1)) selected.add(id);

  /* The anchor deliberately does NOT move on a shift-click. Holding shift and
     clicking further down should keep growing the same range from where it
     started, which is how every file manager behaves; moving it would make each
     shift-click start a new run from the previous one's end. */
  return { selected, anchor: state.anchor };
}

/**
 * Drops any selected card that is no longer in `ordered`.
 *
 * Called when the visible set changes — a filter applied, a card archived by
 * someone else. Without it the bulk bar keeps counting cards nobody can see,
 * and a bulk action reaches rows the user believes they deselected when they
 * narrowed the filter.
 */
export function pruneSelection(state: SelectionState, ordered: readonly string[]): SelectionState {
  const visible = new Set(ordered);
  const selected = new Set([...state.selected].filter((id) => visible.has(id)));
  const anchor = state.anchor !== null && visible.has(state.anchor) ? state.anchor : null;

  /* Returning the SAME object when nothing changed keeps this usable in a
     render path without causing a re-render loop — but it has to test BOTH
     halves. Checking only the selection size let an anchor that had scrolled
     out of the filter survive, and the next shift-click would measure a range
     from a card that is not in `ordered` at all. */
  if (selected.size === state.selected.size && anchor === state.anchor) return state;

  return { selected, anchor };
}
