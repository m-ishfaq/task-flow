import { describe, expect, it } from 'vitest';
import { assertRoomTableIsSafe, broadcastEventNames, roomBoardIdOf } from './event-rooms.js';

/**
 * The event→room table (ai/phase-4-realtime.md §3.4, §4, Wave 2).
 *
 * Pure functions over a literal table — no database needed. What matters here
 * is the boundary behaviour the table's own header comment argues for: an
 * unknown event resolves to null rather than a guess, a malformed payload does
 * the same rather than throwing, and every excluded category (`attachment.*`,
 * `board.created`, the project-scoped vocabulary events) is refused at import
 * time rather than merely commented against.
 */

describe('roomBoardIdOf', () => {
  it('resolves every event Wave 2 wires through the table', () => {
    const boardId = 'board-1';
    const wired = [
      'card.created',
      'card.updated',
      'card.moved',
      'card.assigned',
      'card.archived',
      'card.status_changed',
      'card.labeled',
      'card.field_set',
      'list.created',
      'list.updated',
      'list.reordered',
      'list.archived',
      'list.rebalanced',
      'board.updated',
      'board.archived',
      'comment.created',
      'comment.updated',
      'comment.deleted',
      'checklist.created',
      'checklist.deleted',
      'checklist_item.created',
      'checklist_item.updated',
      'checklist_item.deleted',
      'view.created',
      'view.updated',
      'view.deleted',
    ];

    for (const name of wired) {
      expect(roomBoardIdOf(name, { boardId }), name).toBe(boardId);
    }
  });

  it('returns null for an event type with no room', () => {
    // Real event name, just not one this table routes — must not throw, and
    // must not guess at a key that happens to exist on the payload.
    expect(roomBoardIdOf('project.updated', { boardId: 'board-1' })).toBeNull();
  });

  /**
   * `board.created` and the project-scoped vocabulary events (label,
   * custom_field, status) are excluded on purpose — see event-rooms.ts's own
   * comments — and this asserts the exclusion behaves as "no room", not as a
   * crash: a caller that forgets the exclusion and passes one of these
   * through `roomBoardIdOf` gets null, same as any other unmapped name.
   */
  it('resolves the deliberately-excluded events to null, not a guess', () => {
    expect(roomBoardIdOf('board.created', { boardId: 'board-1' })).toBeNull();
    expect(roomBoardIdOf('label.updated', { projectId: 'project-1' })).toBeNull();
    expect(roomBoardIdOf('custom_field.created', { projectId: 'project-1' })).toBeNull();
    expect(roomBoardIdOf('status.deleted', { projectId: 'project-1' })).toBeNull();
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
    // Broadcasting a presigned download URL to a room hands it to everyone
    // subscribed, not only the caller who requested it (§4).
    for (const name of broadcastEventNames()) {
      expect(name.startsWith('attachment.')).toBe(false);
    }
  });

  it('the current table never maps board.created or a project-scoped vocabulary event', () => {
    const projectScopedPrefixes = ['label.', 'custom_field.', 'status.'];

    for (const name of broadcastEventNames()) {
      expect(name).not.toBe('board.created');
      expect(
        projectScopedPrefixes.some((prefix) => name.startsWith(prefix)),
        name,
      ).toBe(false);
    }
  });
});
