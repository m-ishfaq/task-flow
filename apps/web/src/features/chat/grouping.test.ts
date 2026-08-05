import { describe, expect, it } from 'vitest';
import { GROUP_WINDOW_MS, groupMessages } from './grouping.js';
import type { Message } from './api.js';

/**
 * Message grouping, tested the way `work/grouping.test.ts` tests board
 * grouping: every way this can be wrong is silent. A message merged into the
 * wrong group hides who actually said it; a group split that should not have
 * been makes a burst of messages from one person read as two different
 * conversations.
 */

let nextId = 1;

function message(overrides: Partial<Message> = {}): Message {
  const id = String(nextId);
  nextId += 1;
  return {
    messageId: `msg-${id}`,
    channelId: 'channel-1',
    parentMessageId: null,
    authorId: 'alice',
    body: { type: 'doc', content: [] },
    bodyText: 'hello',
    editedAt: null,
    deletedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const T0 = new Date('2026-01-01T00:00:00.000Z').getTime();
const at = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

describe('groupMessages', () => {
  it('groups consecutive messages from the same author', () => {
    const messages = [
      message({ authorId: 'alice', createdAt: at(0) }),
      message({ authorId: 'alice', createdAt: at(1000) }),
      message({ authorId: 'alice', createdAt: at(2000) }),
    ];

    const groups = groupMessages(messages);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.messages).toHaveLength(3);
  });

  it('starts a new group when the author changes', () => {
    const messages = [
      message({ authorId: 'alice', createdAt: at(0) }),
      message({ authorId: 'bob', createdAt: at(1000) }),
      message({ authorId: 'alice', createdAt: at(2000) }),
    ];

    const groups = groupMessages(messages);

    expect(groups).toHaveLength(3);
    expect(groups.map((group) => group.authorId)).toEqual(['alice', 'bob', 'alice']);
  });

  it('starts a new group once the gap exceeds the window, even for the same author', () => {
    const messages = [
      message({ authorId: 'alice', createdAt: at(0) }),
      message({ authorId: 'alice', createdAt: at(GROUP_WINDOW_MS + 1) }),
    ];

    const groups = groupMessages(messages);

    expect(groups).toHaveLength(2);
  });

  it('keeps a group going as long as each message is within the window of the one before it', () => {
    // Four messages, each GROUP_WINDOW_MS - 1 apart from its predecessor — a
    // window measured from the GROUP's first message would split this after
    // the second message; measuring from the PREVIOUS message keeps it one
    // continuous exchange, matching how the conversation actually happened.
    const step = GROUP_WINDOW_MS - 1;
    const messages = [
      message({ authorId: 'alice', createdAt: at(0) }),
      message({ authorId: 'alice', createdAt: at(step) }),
      message({ authorId: 'alice', createdAt: at(step * 2) }),
      message({ authorId: 'alice', createdAt: at(step * 3) }),
    ];

    const groups = groupMessages(messages);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.messages).toHaveLength(4);
  });

  it('does not merge a null-authorId message with a real author', () => {
    const messages = [
      message({ authorId: null, createdAt: at(0) }),
      message({ authorId: 'alice', createdAt: at(1000) }),
    ];

    const groups = groupMessages(messages);

    expect(groups).toHaveLength(2);
  });

  it('preserves message order within and across groups', () => {
    const messages = [
      message({ messageId: 'm1', authorId: 'alice', createdAt: at(0) }),
      message({ messageId: 'm2', authorId: 'alice', createdAt: at(1000) }),
      message({ messageId: 'm3', authorId: 'bob', createdAt: at(2000) }),
    ];

    const groups = groupMessages(messages);

    expect(groups[0]?.messages.map((m) => m.messageId)).toEqual(['m1', 'm2']);
    expect(groups[1]?.messages.map((m) => m.messageId)).toEqual(['m3']);
  });

  it('returns nothing for an empty list', () => {
    expect(groupMessages([])).toEqual([]);
  });
});
