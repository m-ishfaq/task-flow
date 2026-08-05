import { describe, expect, it } from 'vitest';
import { assertRoomTableIsSafe, broadcastEventNames, roomBoardIdOf } from './event-rooms.js';

/**
 * The event→room table (ai/phase-4-realtime.md §3.4, §4).
 *
 * Pure functions over a literal table — no database needed. What matters here
 * is the boundary behaviour the table's own header comment argues for: an
 * unknown event resolves to null rather than a guess, a malformed payload does
 * the same rather than throwing, and an `attachment.*` entry is refused at
 * import time rather than merely commented against.
 */

describe('roomBoardIdOf', () => {
  it('resolves a seeded event to its board id', () => {
    expect(roomBoardIdOf('card.moved', { boardId: 'board-1' })).toBe('board-1');
    expect(roomBoardIdOf('card.created', { boardId: 'board-2' })).toBe('board-2');
  });

  it('returns null for an event type with no room', () => {
    // Real event name, just not one Wave 1 seeded (§5) — must not throw, and
    // must not guess at a key that happens to exist on the payload.
    expect(roomBoardIdOf('board.updated', { boardId: 'board-1' })).toBeNull();
  });

  it('returns null rather than guess when the payload is missing the key', () => {
    expect(roomBoardIdOf('card.moved', { cardId: 'card-1' })).toBeNull();
  });

  it('returns null for a non-object payload', () => {
    expect(roomBoardIdOf('card.moved', null)).toBeNull();
    expect(roomBoardIdOf('card.moved', 'not-an-object')).toBeNull();
    expect(roomBoardIdOf('card.moved', undefined)).toBeNull();
  });

  it('returns null when the board id is present but not a non-empty string', () => {
    expect(roomBoardIdOf('card.moved', { boardId: '' })).toBeNull();
    expect(roomBoardIdOf('card.moved', { boardId: 42 })).toBeNull();
    expect(roomBoardIdOf('card.moved', { boardId: null })).toBeNull();
  });
});

describe('assertRoomTableIsSafe', () => {
  it('passes for the real, current table', () => {
    expect(() => {
      assertRoomTableIsSafe();
    }).not.toThrow();
  });

  it('the current table never maps an attachment.* event', () => {
    // The property assertRoomTableIsSafe enforces at boot, checked directly
    // here too: broadcasting a presigned download URL to a room hands it to
    // everyone subscribed, not only the caller who requested it (§4).
    for (const name of broadcastEventNames()) {
      expect(name.startsWith('attachment.')).toBe(false);
    }
  });
});
