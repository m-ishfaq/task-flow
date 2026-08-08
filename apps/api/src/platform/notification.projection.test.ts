import { describe, expect, it } from 'vitest';
import type { OutboxRow } from '@taskflow/db';
import { planNotifications } from './notification.projection.js';

/**
 * Who gets told about an event (§4, §10.6; ai/phase-9-notifications.md §4).
 *
 * `planNotifications` is pure and separated from the write for exactly this
 * reason: "who gets notified" IS the logic, and every way it can be wrong is
 * quiet. Nobody reports a notification they did not receive, and the person who
 * receives one they should not have gets no error either — they just learn
 * something.
 *
 * No database. The projection's WRITE is an ordinary upsert with a unique index
 * behind it; this file tests the decision, which is the part with judgment in
 * it.
 */

const ALICE = '0195ee05-0000-7000-8000-000000000001';
const BOB = '0195ee05-0000-7000-8000-000000000002';
const CAROL = '0195ee05-0000-7000-8000-000000000003';

/** An outbox row shaped like the relay produces, with an overridable payload. */
function row(
  name: string,
  payload: Record<string, unknown>,
  actorId: string | null = ALICE,
): OutboxRow {
  return {
    id: '0195ee05-0000-7000-8000-0000000000ff',
    orgId: '0195ee05-0000-7000-8000-00000000000a',
    name,
    version: 1,
    actorId,
    occurredAt: new Date(),
    requestId: null,
    payload,
  } as unknown as OutboxRow;
}

describe('message.sent — chat', () => {
  const base = {
    messageId: '0195ee05-0000-7000-8000-000000000010',
    channelId: '0195ee05-0000-7000-8000-000000000020',
    parentMessageId: null,
    excerpt: 'hello',
    mentionedUserIds: [],
    channelName: 'general',
    parentAuthorId: null,
    directRecipientIds: [],
  };
  const msg = (payload: Record<string, unknown>, actorId: string | null = ALICE) =>
    row('message.sent', payload, actorId);

  it('tells nobody about an ordinary channel message', () => {
    /* The most important negative. A named channel notifying every member of
       every message is how a bell becomes something people switch off, and
       then the mention that mattered goes unseen too. */
    expect(planNotifications(msg(base))).toEqual([]);
  });

  it('tells the people who were mentioned', () => {
    const planned = planNotifications(msg({ ...base, mentionedUserIds: [BOB, CAROL] }));

    expect(planned.map((entry) => entry.userId)).toEqual([BOB, CAROL]);
    expect(planned.every((entry) => entry.kind === 'chat.mention')).toBe(true);
    expect(planned.every((entry) => entry.subjectType === 'message')).toBe(true);
    expect(planned[0]?.title).toBe('Mentioned in #general');
  });

  it('never tells the person who sent it', () => {
    const planned = planNotifications(msg({ ...base, mentionedUserIds: [ALICE, BOB] }));
    expect(planned.map((entry) => entry.userId)).toEqual([BOB]);
  });

  it('tells DM participants even with no mention', () => {
    const planned = planNotifications(
      msg({ ...base, channelName: null, directRecipientIds: [BOB] }),
    );

    expect(planned).toEqual([
      {
        userId: BOB,
        kind: 'chat.direct',
        subjectType: 'message',
        subjectId: base.messageId,
        title: 'New direct message',
        excerpt: 'hello',
        channelId: base.channelId,
        boardId: null,
      },
    ]);
  });

  it('tells the author of a message that was replied to', () => {
    const planned = planNotifications(msg({ ...base, parentAuthorId: BOB }));

    expect(planned).toEqual([
      {
        userId: BOB,
        kind: 'chat.thread_reply',
        subjectType: 'message',
        subjectId: base.messageId,
        title: 'New reply to your message',
        excerpt: 'hello',
        channelId: base.channelId,
        boardId: null,
      },
    ]);
  });

  it('does not tell you about a reply to your own message', () => {
    expect(planNotifications(msg({ ...base, parentAuthorId: ALICE }))).toEqual([]);
  });

  it('tells one person once, even when three rules match', () => {
    const planned = planNotifications(
      msg({
        ...base,
        channelName: null,
        mentionedUserIds: [BOB],
        parentAuthorId: BOB,
        directRecipientIds: [BOB],
      }),
    );
    expect(planned).toHaveLength(1);
  });

  it('keeps the most specific reason when several apply', () => {
    const planned = planNotifications(
      msg({ ...base, mentionedUserIds: [BOB], parentAuthorId: BOB }),
    );
    expect(planned[0]?.kind).toBe('chat.mention');
  });

  it('does not collapse two different people', () => {
    const planned = planNotifications(
      msg({ ...base, mentionedUserIds: [BOB], parentAuthorId: CAROL }),
    );
    expect(planned.map((entry) => entry.kind).sort()).toEqual([
      'chat.mention',
      'chat.thread_reply',
    ]);
  });

  it('survives a payload missing every optional field', () => {
    const sparse = msg({ messageId: base.messageId, channelId: base.channelId });
    expect(planNotifications(sparse)).toEqual([]);
  });

  it('survives a payload that is not an object at all', () => {
    expect(
      planNotifications(row('message.sent', [] as unknown as Record<string, unknown>)),
    ).toEqual([]);
  });

  it('ignores non-string entries in the id lists', () => {
    const planned = planNotifications(
      msg({ ...base, mentionedUserIds: [BOB, 42, null, { userId: CAROL }] }),
    );
    expect(planned.map((entry) => entry.userId)).toEqual([BOB]);
  });

  it('falls back to a generic title when the channel has no name', () => {
    const planned = planNotifications(msg({ ...base, channelName: null, mentionedUserIds: [BOB] }));
    expect(planned[0]?.title).toBe('You were mentioned');
  });

  it('carries the channel id through for click-to-open, and nulls it when absent', () => {
    const planned = planNotifications(msg({ ...base, mentionedUserIds: [BOB] }));
    expect(planned[0]?.channelId).toBe(base.channelId);

    const sparse = planNotifications(msg({ messageId: base.messageId, mentionedUserIds: [BOB] }));
    expect(sparse[0]?.channelId).toBeNull();
  });
});

describe('card.assigned — work', () => {
  const CARD = '0195ee05-0000-7000-8000-000000000030';
  const BOARD = '0195ee05-0000-7000-8000-000000000031';

  it('tells newly-assigned people, not the whole set', () => {
    const planned = planNotifications(
      row('card.assigned', { cardId: CARD, boardId: BOARD, before: [BOB], after: [BOB, CAROL] }),
    );
    expect(planned).toEqual([
      {
        userId: CAROL,
        kind: 'card.assigned',
        subjectType: 'card',
        subjectId: CARD,
        title: 'You were assigned a card',
        excerpt: null,
        channelId: null,
        boardId: BOARD,
      },
    ]);
  });

  it('does not notify anyone when the assignee set is unchanged', () => {
    const planned = planNotifications(
      row('card.assigned', { cardId: CARD, boardId: BOARD, before: [BOB], after: [BOB] }),
    );
    expect(planned).toEqual([]);
  });

  it('does not notify about self-assignment', () => {
    const planned = planNotifications(
      row('card.assigned', { cardId: CARD, boardId: BOARD, before: [], after: [ALICE] }, ALICE),
    );
    expect(planned).toEqual([]);
  });

  it('survives a payload missing boardId', () => {
    const planned = planNotifications(
      row('card.assigned', { cardId: CARD, before: [], after: [BOB] }),
    );
    expect(planned).toEqual([]);
  });
});

describe('comment.created — work card comment mentions', () => {
  const CARD = '0195ee05-0000-7000-8000-000000000040';
  const BOARD = '0195ee05-0000-7000-8000-000000000041';
  const base = {
    commentId: '0195ee05-0000-7000-8000-000000000042',
    cardId: CARD,
    boardId: BOARD,
    excerpt: 'ping @bob',
    parentCommentId: null,
    mentionedUserIds: [BOB],
  };

  it('tells the mentioned person, with the excerpt and board carried through', () => {
    const planned = planNotifications(row('comment.created', base));
    expect(planned).toEqual([
      {
        userId: BOB,
        kind: 'card.comment_mention',
        subjectType: 'card',
        subjectId: CARD,
        title: 'You were mentioned in a comment',
        excerpt: 'ping @bob',
        channelId: null,
        boardId: BOARD,
      },
    ]);
  });

  it('does not notify the comment author about their own mention of themselves', () => {
    const planned = planNotifications(
      row('comment.created', { ...base, mentionedUserIds: [ALICE] }),
    );
    expect(planned).toEqual([]);
  });

  it('ignores a comment with nobody mentioned', () => {
    expect(planNotifications(row('comment.created', { ...base, mentionedUserIds: [] }))).toEqual(
      [],
    );
  });
});

describe('page.comment_created — docs page comment mentions', () => {
  const PAGE = '0195ee05-0000-7000-8000-000000000050';
  const base = {
    commentId: '0195ee05-0000-7000-8000-000000000051',
    pageId: PAGE,
    excerpt: 'ping @carol',
    mentionedUserIds: [CAROL],
  };

  it('tells the mentioned person, with no board (docs has none)', () => {
    const planned = planNotifications(row('page.comment_created', base));
    expect(planned).toEqual([
      {
        userId: CAROL,
        kind: 'page.comment_mention',
        subjectType: 'page',
        subjectId: PAGE,
        title: 'You were mentioned in a comment',
        excerpt: 'ping @carol',
        channelId: null,
        boardId: null,
      },
    ]);
  });

  it('survives a payload missing pageId', () => {
    expect(planNotifications(row('page.comment_created', { mentionedUserIds: [CAROL] }))).toEqual(
      [],
    );
  });
});

describe('unrelated event names', () => {
  it('ignores events this projection does not consume', () => {
    expect(planNotifications(row('card.updated', { cardId: '1' }))).toEqual([]);
    expect(planNotifications(row('message.edited', { messageId: '1' }))).toEqual([]);
  });
});
