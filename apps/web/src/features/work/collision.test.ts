import { describe, expect, it } from 'vitest';
import { preferInnermost } from './collision.js';

/**
 * The rule that decides whether a drop lands where it was released or at the
 * bottom of the column. Both outcomes are successful moves, so neither raises
 * an error — the only difference the user sees is a card in the wrong place.
 */

const columns = new Set(['todo', 'doing', 'done']);

const collision = (id: string) => ({ id });

describe('preferring the innermost droppable', () => {
  it('picks the card over the column containing it', () => {
    /* What `pointerWithin` returns whenever the cursor is over a card: the card
       AND its column, because the pointer is inside both. Answering with the
       column appends to the bottom of it. */
    expect(preferInnermost([collision('doing'), collision('b2')], columns)).toEqual([
      collision('b2'),
    ]);
  });

  it('keeps the column when it is the only thing under the pointer', () => {
    // The header, or the empty space below the last card — a legal "append here".
    expect(preferInnermost([collision('doing')], columns)).toEqual([collision('doing')]);
  });

  it('keeps every card when several are candidates, preserving dnd-kit order', () => {
    // Ranking between cards is dnd-kit's job; this only removes containers.
    expect(
      preferInnermost([collision('b1'), collision('doing'), collision('b2')], columns),
    ).toEqual([collision('b1'), collision('b2')]);
  });

  it('drops every column when the pointer spans more than one', () => {
    expect(
      preferInnermost([collision('todo'), collision('doing'), collision('a1')], columns),
    ).toEqual([collision('a1')]);
  });

  it('passes an empty candidate list through unchanged', () => {
    /* Nothing droppable under the pointer — dragged off the board. Stays empty
       so `over` is null and no move is attempted, rather than resolving to a
       nearest column the user never aimed at. */
    expect(preferInnermost([], columns)).toEqual([]);
  });

  it('treats an empty container set as "everything is innermost"', () => {
    expect(preferInnermost([collision('a1'), collision('todo')], new Set())).toEqual([
      collision('a1'),
      collision('todo'),
    ]);
  });
});
