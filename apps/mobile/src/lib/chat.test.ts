import { describe, expect, it } from 'vitest';
import {
  channelDisplayName,
  groupMessages,
  groupReactions,
  replyCountsOf,
  type Message,
} from './chat.js';

/**
 * `groupMessages`/`channelDisplayName`/`groupReactions` — ported logic from
 * `apps/web/src/features/chat/grouping.ts` and `chat-page.tsx`'s own
 * `directLabel`/`groupReactions`. These tests exist here (not just on web)
 * because a native-only bug (grouping by the wrong field, an off-by-one in
 * the window comparison) would be invisible to web's own suite.
 */

function message(overrides: Partial<Message>): Message {
  return {
    messageId: 'm-default',
    channelId: 'c-1',
    parentMessageId: null,
    authorId: 'u-1',
    body: null,
    bodyText: 'hi',
    editedAt: null,
    deletedAt: null,
    createdAt: '2026-06-15T12:00:00.000Z',
    ...overrides,
  };
}

describe('groupMessages', () => {
  it('groups consecutive messages from the same author', () => {
    const groups = groupMessages([
      message({ messageId: 'm1', authorId: 'a', createdAt: '2026-06-15T12:00:00.000Z' }),
      message({ messageId: 'm2', authorId: 'a', createdAt: '2026-06-15T12:01:00.000Z' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.messages.map((m) => m.messageId)).toEqual(['m1', 'm2']);
  });

  it('starts a new group when the author changes', () => {
    const groups = groupMessages([
      message({ messageId: 'm1', authorId: 'a' }),
      message({ messageId: 'm2', authorId: 'b' }),
    ]);
    expect(groups).toHaveLength(2);
  });

  it('starts a new group once the gap from the PREVIOUS message exceeds the window', () => {
    const groups = groupMessages([
      message({ messageId: 'm1', authorId: 'a', createdAt: '2026-06-15T12:00:00.000Z' }),
      message({ messageId: 'm2', authorId: 'a', createdAt: '2026-06-15T12:06:00.000Z' }),
    ]);
    expect(groups).toHaveLength(2);
  });

  it('a burst each within the window of its predecessor stays one group even past the window from the first message', () => {
    const groups = groupMessages([
      message({ messageId: 'm1', authorId: 'a', createdAt: '2026-06-15T12:00:00.000Z' }),
      message({ messageId: 'm2', authorId: 'a', createdAt: '2026-06-15T12:04:00.000Z' }),
      message({ messageId: 'm3', authorId: 'a', createdAt: '2026-06-15T12:08:00.000Z' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.messages).toHaveLength(3);
  });

  it('groups by author id, not by resolved label', () => {
    // Two different authorIds never merge, even if a caller would resolve
    // both to the same fallback label upstream — grouping happens before
    // any label lookup runs.
    const groups = groupMessages([
      message({ messageId: 'm1', authorId: 'left-the-org-1' }),
      message({ messageId: 'm2', authorId: 'left-the-org-2' }),
    ]);
    expect(groups).toHaveLength(2);
  });
});

describe('channelDisplayName', () => {
  const personOf = (userId: string): { readonly label: string } => ({ label: `Name(${userId})` });

  it('uses the channel name when there is one', () => {
    expect(
      channelDisplayName({ name: 'general', type: 'public', participantIds: [] }, 'me', personOf),
    ).toBe('general');
  });

  it('names a one-on-one DM by the other participant', () => {
    expect(
      channelDisplayName(
        { name: null, type: 'dm', participantIds: ['me', 'them'] },
        'me',
        personOf,
      ),
    ).toBe('Name(them)');
  });

  it('falls back to "Direct message" once the viewer is the only participant left', () => {
    expect(
      channelDisplayName({ name: null, type: 'dm', participantIds: ['me'] }, 'me', personOf),
    ).toBe('Direct message');
  });

  it('joins two other participants with "and"', () => {
    expect(
      channelDisplayName(
        { name: null, type: 'group_dm', participantIds: ['me', 'a', 'b'] },
        'me',
        personOf,
      ),
    ).toBe('Name(a), Name(b)');
  });

  it('summarizes three or more others as "and N others"', () => {
    expect(
      channelDisplayName(
        { name: null, type: 'group_dm', participantIds: ['me', 'a', 'b', 'c', 'd'] },
        'me',
        personOf,
      ),
    ).toBe('Name(a), Name(b) and 2 others');
  });
});

describe('replyCountsOf', () => {
  it('counts replies by their parent, ignoring top-level messages', () => {
    const counts = replyCountsOf([
      message({ messageId: 'root-1', parentMessageId: null }),
      message({ messageId: 'reply-1', parentMessageId: 'root-1' }),
      message({ messageId: 'reply-2', parentMessageId: 'root-1' }),
      message({ messageId: 'root-2', parentMessageId: null }),
      message({ messageId: 'reply-3', parentMessageId: 'root-2' }),
    ]);
    expect(counts.get('root-1')).toBe(2);
    expect(counts.get('root-2')).toBe(1);
    expect(counts.has('reply-1')).toBe(false);
  });

  it('returns an empty map when nothing has a reply', () => {
    const counts = replyCountsOf([message({ messageId: 'root-1', parentMessageId: null })]);
    expect(counts.size).toBe(0);
  });
});

describe('groupReactions', () => {
  it('groups by message then by emoji, collecting reactor ids', () => {
    const grouped = groupReactions([
      { messageId: 'm1', userId: 'u1', emoji: '👍' },
      { messageId: 'm1', userId: 'u2', emoji: '👍' },
      { messageId: 'm1', userId: 'u1', emoji: '🎉' },
      { messageId: 'm2', userId: 'u3', emoji: '👀' },
    ]);

    expect(grouped.get('m1')?.get('👍')).toEqual(['u1', 'u2']);
    expect(grouped.get('m1')?.get('🎉')).toEqual(['u1']);
    expect(grouped.get('m2')?.get('👀')).toEqual(['u3']);
  });
});
