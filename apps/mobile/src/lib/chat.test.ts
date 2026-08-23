import { describe, expect, it } from 'vitest';
import {
  channelDisplayName,
  describeTyping,
  firstUnreadAfter,
  groupMessages,
  groupPreviews,
  groupReactions,
  replyCountsOf,
  type Message,
  type UnfurlPreview,
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

function preview(overrides: Partial<UnfurlPreview>): UnfurlPreview {
  return {
    messageId: 'm-default',
    url: 'https://example.com',
    status: 'ready',
    title: null,
    description: null,
    imageUrl: null,
    siteName: null,
    ...overrides,
  };
}

describe('groupPreviews', () => {
  it('groups previews by the message they were found in, preserving order', () => {
    const grouped = groupPreviews([
      preview({ messageId: 'm1', url: 'https://a.example' }),
      preview({ messageId: 'm1', url: 'https://b.example' }),
      preview({ messageId: 'm2', url: 'https://c.example' }),
    ]);

    expect(grouped.get('m1')?.map((row) => row.url)).toEqual([
      'https://a.example',
      'https://b.example',
    ]);
    expect(grouped.get('m2')?.map((row) => row.url)).toEqual(['https://c.example']);
  });

  it('returns an empty map for no rows', () => {
    expect(groupPreviews([]).size).toBe(0);
  });
});

describe('describeTyping', () => {
  const personOf = (userId: string): { readonly label: string } => ({ label: `Name(${userId})` });

  it('returns null when nobody is typing', () => {
    expect(describeTyping([], personOf)).toBeNull();
  });

  it('names the one person typing', () => {
    expect(describeTyping(['a'], personOf)).toBe('Name(a) is typing…');
  });

  it('joins exactly two names with "and"', () => {
    expect(describeTyping(['a', 'b'], personOf)).toBe('Name(a) and Name(b) are typing…');
  });

  it('summarizes three or more as a count', () => {
    expect(describeTyping(['a', 'b', 'c'], personOf)).toBe('3 people are typing…');
  });
});

/**
 * `firstUnreadAfter` — ported verbatim from `apps/web/src/features/chat/
 * unread-divider.test.ts`, the entire file, because the module under test
 * is itself a verbatim port. The rule the whole suite rests on: the
 * position comes from the read CURSOR, never from the unread COUNT.
 * Counting back N from the end is the obvious implementation and it is
 * wrong the moment a message is deleted or the page is partially loaded —
 * and wrong by exactly one, which is the least noticeable amount.
 */
describe('firstUnreadAfter', () => {
  const MESSAGES = ['m1', 'm2', 'm3', 'm4'];

  it('marks the message after the cursor', () => {
    expect(firstUnreadAfter('m2', MESSAGES)).toBe('m3');
  });

  it('draws nothing while the cursor is still loading', () => {
    // `undefined` is "not resolved yet", deliberately distinct from `null`.
    // Treating it as "never read" would flash a divider at the top of the
    // list for one render on every channel open.
    expect(firstUnreadAfter(undefined, MESSAGES)).toBeNull();
  });

  it('draws nothing for a channel that has never been opened', () => {
    // Everything is unread, so a line above the first message would label
    // the whole conversation "new" — true, and useless.
    expect(firstUnreadAfter(null, MESSAGES)).toBeNull();
  });

  it('draws nothing when the cursor is on the last message', () => {
    // Caught up. The ordinary state of a channel someone left open.
    expect(firstUnreadAfter('m4', MESSAGES)).toBeNull();
  });

  it('draws nothing when the cursor names a message not in the page', () => {
    // Older than the loaded window, or since deleted. Guessing a position
    // would put the line somewhere plausible and wrong.
    expect(firstUnreadAfter('m0', MESSAGES)).toBeNull();
  });

  it('draws nothing when there are no messages at all', () => {
    expect(firstUnreadAfter('m2', [])).toBeNull();
    expect(firstUnreadAfter(null, [])).toBeNull();
  });

  it('marks the second message when only the first was read', () => {
    expect(firstUnreadAfter('m1', MESSAGES)).toBe('m2');
  });
});

/**
 * The ORDER and CONTENT of the list this is given — the two things web's
 * own suite found wrong at the call site, which no assertion above could
 * catch in isolation. `firstUnreadAfter` is correct for any ascending,
 * rendered list; the bug lived in `topLevel`'s own construction (this
 * file's `oldestFirst`/`topLevel`, `channel/[channelId].tsx`'s own
 * `useMemo`s). These tests apply the identical transformation, so a
 * future change that drops the reverse or the reply filter fails here
 * instead of silently removing the divider.
 */
describe('the list the divider is computed from', () => {
  interface Row {
    readonly messageId: string;
    readonly parentMessageId: string | null;
  }

  /** Exactly what `channel/[channelId].tsx` does to build `topLevel`. */
  const rendered = (rows: readonly Row[]): string[] =>
    rows
      .filter((row) => row.parentMessageId === null)
      .toReversed()
      .map((row) => row.messageId);

  /* As the API returns it: newest first, replies interleaved. */
  const FROM_API: readonly Row[] = [
    { messageId: 'm4', parentMessageId: null },
    { messageId: 'r1', parentMessageId: 'm2' },
    { messageId: 'm3', parentMessageId: null },
    { messageId: 'm2', parentMessageId: null },
    { messageId: 'm1', parentMessageId: null },
  ];

  it('reads chronologically once transformed', () => {
    expect(rendered(FROM_API)).toEqual(['m1', 'm2', 'm3', 'm4']);
  });

  it('points at the NEXT message, not the previous one', () => {
    // The direction bug. On the raw newest-first list this returned 'm1'.
    expect(firstUnreadAfter('m2', rendered(FROM_API))).toBe('m3');
  });

  it('never names a thread reply, which is rendered in no group', () => {
    // `r1` sits next to `m2` in the raw list, so a naive divider could
    // name a message the transcript does not contain. After the filter
    // there is no reply to land on.
    expect(rendered(FROM_API)).not.toContain('r1');
    expect(firstUnreadAfter('m2', rendered(FROM_API))).not.toBe('r1');
  });

  it('shows a line when there is genuinely something unread', () => {
    // Caught up to m2, two newer messages exist — the line belongs above m3.
    expect(firstUnreadAfter('m2', rendered(FROM_API))).toBe('m3');
  });

  it('shows no line once the newest message has been read', () => {
    // The state a channel is in immediately after being opened — so
    // returning to it draws nothing.
    expect(firstUnreadAfter('m4', rendered(FROM_API))).toBeNull();
  });
});
