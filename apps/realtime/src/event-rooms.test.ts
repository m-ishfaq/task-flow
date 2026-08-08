import { describe, expect, it } from 'vitest';
import {
  assertRoomTableIsSafe,
  broadcastEventNames,
  chatBroadcastEventNames,
  roomBoardIdOf,
  roomChannelIdOf,
  roomUserIdOf,
  userBroadcastEventNames,
} from './event-rooms.js';

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

/**
 * The chat half of the table (ai/phase-5-chat.md §3.4).
 *
 * Same mechanism, second table. These assertions are the reason the two are
 * separate maps rather than one with a discriminator: every property below is
 * about a chat event NOT being routed somewhere, and a merged table would make
 * "which room" a judgment call at broadcast time, which is exactly what §3.4
 * rules out.
 */
describe('roomChannelIdOf', () => {
  const CHANNEL = '0195ff00-0000-7000-8000-000000000c12';

  it('resolves a message event to its channel', () => {
    expect(roomChannelIdOf('message.sent', { channelId: CHANNEL })).toBe(CHANNEL);
  });

  it('returns null for an event with no channel mapping', () => {
    expect(roomChannelIdOf('card.moved', { boardId: CHANNEL })).toBeNull();
  });

  it('returns null when the payload lacks the key the table expects', () => {
    // A malformed payload is not a reason to guess at an audience — and on this
    // table the audience may be a two-person conversation.
    expect(roomChannelIdOf('message.sent', { messageId: CHANNEL })).toBeNull();
    expect(roomChannelIdOf('message.sent', null)).toBeNull();
  });

  it('does not resolve board events, and roomBoardIdOf does not resolve chat ones', () => {
    /* The two tables must stay disjoint. An event in both would be delivered to
       two rooms on two namespaces whose membership was decided by two different
       `can()` calls, and a mistake in either is invisible from inside the
       other. `assertRoomTableIsSafe` fails the boot on this; here it is checked
       as a property of the current tables. */
    for (const name of chatBroadcastEventNames()) {
      expect(broadcastEventNames(), name).not.toContain(name);
    }
  });

  it('routes the attachment-changed signal, which names no file', () => {
    /* The event that exists BECAUSE the attachment ban left the room with no
       signal at all — a file was visible only to whoever uploaded it. It is
       safe to broadcast precisely because its payload is a channel and a
       message and nothing else; the guard below proves the banned ones still
       cannot join it. */
    expect(chatBroadcastEventNames()).toContain('message.attachments_changed');
    expect(roomChannelIdOf('message.attachments_changed', { channelId: CHANNEL })).toBe(CHANNEL);
  });

  it('never maps an attachment.* event', () => {
    // §3.10: chat file sharing reuses Work's pipeline, and reuses its exclusion.
    // A presigned URL in a channel room is a bearer credential handed to
    // everyone subscribed.
    for (const name of chatBroadcastEventNames()) {
      expect(name.startsWith('attachment.')).toBe(false);
    }
  });

  it('never maps channel.created or a membership change', () => {
    /* `channel.created` names a channel nobody can have joined — a broadcast
       with zero possible subscribers, which looks like a working feature under
       any test that does not check who received it.

       `channel.member_removed` is the subtler one: the socket that must act on
       a removal belongs to the person removed, who is by definition no longer
       entitled to the room the message would go to. Eviction is
       `revocation.ts`'s job, and a room mapping here would make it look as
       though the broadcast were doing the work. */
    for (const name of chatBroadcastEventNames()) {
      expect(name).not.toBe('channel.created');
      expect(name).not.toBe('channel.member_added');
      expect(name).not.toBe('channel.member_removed');
    }
  });
});

/**
 * The personal-room table (Phase 9, ai/phase-9-notifications.md §3.5).
 *
 * Same mechanism as the two above, and a third disjointness property: a
 * personal room's membership is decided by the handshake alone, never by a
 * `can()` call on a resource, so nothing here may also appear in either of
 * the other two tables.
 */
describe('roomUserIdOf', () => {
  const USER = '0195ff00-0000-7000-8000-0000000000u1';

  it('resolves notification.created to its recipient', () => {
    expect(roomUserIdOf('notification.created', { userId: USER })).toBe(USER);
  });

  it('returns null for an event with no personal-room mapping', () => {
    expect(roomUserIdOf('card.moved', { boardId: USER })).toBeNull();
  });

  it('returns null when the payload lacks the key the table expects, or is not an object', () => {
    expect(roomUserIdOf('notification.created', { notificationId: USER })).toBeNull();
    expect(roomUserIdOf('notification.created', null)).toBeNull();
  });

  it('never overlaps the board or channel tables', () => {
    for (const name of userBroadcastEventNames()) {
      expect(broadcastEventNames(), name).not.toContain(name);
      expect(chatBroadcastEventNames(), name).not.toContain(name);
    }
  });

  it('never maps an attachment.* event', () => {
    for (const name of userBroadcastEventNames()) {
      expect(name.startsWith('attachment.')).toBe(false);
    }
  });
});
