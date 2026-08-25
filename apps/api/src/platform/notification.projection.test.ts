import { describe, expect, it } from 'vitest';
import type { OutboxRow } from '@taskflow/db';
import {
  dueDateChanged,
  planChannelDeliveries,
  planNotifications,
} from './notification.projection.js';

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

describe('member.added — tenancy (migration 0071)', () => {
  const MEMBERSHIP = '0195ee05-0000-7000-8000-000000000060';
  const base = { membershipId: MEMBERSHIP, userId: BOB, email: 'bob@example.com', role: 'member' };

  it('tells the person added, not the person who added them', () => {
    const planned = planNotifications(row('member.added', base, ALICE));
    expect(planned).toEqual([
      {
        userId: BOB,
        kind: 'member.added',
        subjectType: 'membership',
        subjectId: MEMBERSHIP,
        title: 'You were added as a Member',
        excerpt: null,
        channelId: null,
        boardId: null,
      },
    ]);
  });

  it('capitalizes and articles the role', () => {
    expect(planNotifications(row('member.added', { ...base, role: 'owner' }))[0]?.title).toBe(
      'You were added as an Owner',
    );
    expect(planNotifications(row('member.added', { ...base, role: 'admin' }))[0]?.title).toBe(
      'You were added as an Admin',
    );
  });

  it('survives a payload missing membershipId', () => {
    expect(planNotifications(row('member.added', { userId: BOB, role: 'member' }))).toEqual([]);
  });
});

describe('member.role_changed — tenancy (migration 0071)', () => {
  const MEMBERSHIP = '0195ee05-0000-7000-8000-000000000061';
  const base = { membershipId: MEMBERSHIP, userId: BOB, from: 'member', to: 'admin' };

  it('tells the person whose role changed, not the actor who changed it', () => {
    const planned = planNotifications(row('member.role_changed', base, ALICE));
    expect(planned).toEqual([
      {
        userId: BOB,
        kind: 'member.role_changed',
        subjectType: 'membership',
        subjectId: MEMBERSHIP,
        title: 'Your role changed to an Admin',
        excerpt: null,
        channelId: null,
        boardId: null,
      },
    ]);
  });

  it('survives a payload missing the target role', () => {
    expect(
      planNotifications(row('member.role_changed', { membershipId: MEMBERSHIP, userId: BOB })),
    ).toEqual([]);
  });
});

describe('member.removed — tenancy (migration 0072)', () => {
  const MEMBERSHIP = '0195ee05-0000-7000-8000-000000000062';
  const base = { membershipId: MEMBERSHIP, userId: BOB, role: 'member' };

  it('tells the person removed, not the person who removed them', () => {
    const planned = planNotifications(row('member.removed', base, ALICE));
    expect(planned).toEqual([
      {
        userId: BOB,
        kind: 'member.removed',
        subjectType: 'membership',
        subjectId: MEMBERSHIP,
        title: 'You were removed from this organization',
        excerpt: null,
        channelId: null,
        boardId: null,
      },
    ]);
  });

  it('survives a payload missing membershipId', () => {
    expect(planNotifications(row('member.removed', { userId: BOB, role: 'member' }))).toEqual([]);
  });
});

describe('rtc_session.ended — missed call (Phase 13, §7)', () => {
  const SESSION = '0195ee05-0000-7000-8000-000000000070';
  const CHANNEL = '0195ee05-0000-7000-8000-000000000071';
  const base = { sessionId: SESSION, channelId: CHANNEL, missedUserIds: [BOB, CAROL] };

  it('tells everyone who missed it, anonymously by default', () => {
    const planned = planNotifications(row('rtc_session.ended', base, ALICE));
    expect(planned).toEqual([
      {
        userId: BOB,
        kind: 'call.missed',
        subjectType: 'call',
        subjectId: SESSION,
        title: 'Missed call',
        excerpt: null,
        channelId: CHANNEL,
        boardId: null,
      },
      {
        userId: CAROL,
        kind: 'call.missed',
        subjectType: 'call',
        subjectId: SESSION,
        title: 'Missed call',
        excerpt: null,
        channelId: CHANNEL,
        boardId: null,
      },
    ]);
  });

  it('never tells the caller they missed their own call', () => {
    expect(
      planNotifications(row('rtc_session.ended', { ...base, missedUserIds: [ALICE] }, ALICE)),
    ).toEqual([]);
  });

  it('survives a payload missing sessionId', () => {
    expect(planNotifications(row('rtc_session.ended', { missedUserIds: [BOB] }))).toEqual([]);
  });
});

describe('actorLabel — personalized titles (migration 0087)', () => {
  it('names the caller in a missed-call title', () => {
    const planned = planNotifications(
      row('rtc_session.ended', { sessionId: '1', channelId: '2', missedUserIds: [BOB] }, ALICE),
      'Alice Example',
    );
    expect(planned[0]?.title).toBe('Missed call from Alice Example');
  });

  it('names the mentioner, with and without a channel name', () => {
    const withChannel = planNotifications(
      row(
        'message.sent',
        {
          messageId: '1',
          channelId: '2',
          excerpt: 'hi',
          channelName: 'general',
          mentionedUserIds: [BOB],
        },
        ALICE,
      ),
      'Alice Example',
    );
    expect(withChannel[0]?.title).toBe('Alice Example mentioned you in #general');

    const dm = planNotifications(
      row(
        'message.sent',
        {
          messageId: '1',
          channelId: '2',
          excerpt: 'hi',
          channelName: null,
          mentionedUserIds: [BOB],
        },
        ALICE,
      ),
      'Alice Example',
    );
    expect(dm[0]?.title).toBe('Alice Example mentioned you');
  });

  it('names the sender of a thread reply and a direct message', () => {
    const reply = planNotifications(
      row(
        'message.sent',
        { messageId: '1', channelId: '2', excerpt: 'hi', parentAuthorId: BOB },
        ALICE,
      ),
      'Alice Example',
    );
    expect(reply[0]?.title).toBe('Alice Example replied to your message');

    const direct = planNotifications(
      row(
        'message.sent',
        { messageId: '1', channelId: '2', excerpt: 'hi', directRecipientIds: [BOB] },
        ALICE,
      ),
      'Alice Example',
    );
    expect(direct[0]?.title).toBe('Alice Example sent you a message');
  });

  it('names who assigned a card and who mentioned in a comment', () => {
    const assigned = planNotifications(
      row('card.assigned', { cardId: '1', boardId: '2', before: [], after: [BOB] }, ALICE),
      'Alice Example',
    );
    expect(assigned[0]?.title).toBe('Alice Example assigned you a card');

    const cardComment = planNotifications(
      row(
        'comment.created',
        { commentId: '1', cardId: '2', boardId: '3', excerpt: 'ping', mentionedUserIds: [BOB] },
        ALICE,
      ),
      'Alice Example',
    );
    expect(cardComment[0]?.title).toBe('Alice Example mentioned you in a comment');

    const pageComment = planNotifications(
      row('page.comment_created', { pageId: '1', excerpt: 'ping', mentionedUserIds: [BOB] }, ALICE),
      'Alice Example',
    );
    expect(pageComment[0]?.title).toBe('Alice Example mentioned you in a comment');
  });

  it('names who changed a membership', () => {
    const added = planNotifications(
      row('member.added', { membershipId: '1', userId: BOB, role: 'member' }, ALICE),
      'Alice Example',
    );
    expect(added[0]?.title).toBe('Alice Example added you as a Member');

    const roleChanged = planNotifications(
      row('member.role_changed', { membershipId: '1', userId: BOB, to: 'admin' }, ALICE),
      'Alice Example',
    );
    expect(roleChanged[0]?.title).toBe('Alice Example changed your role to an Admin');

    const removed = planNotifications(
      row('member.removed', { membershipId: '1', userId: BOB }, ALICE),
      'Alice Example',
    );
    expect(removed[0]?.title).toBe('Alice Example removed you from this organization');
  });

  it('falls back to the pre-0087 anonymous phrasing when the actor cannot be resolved', () => {
    const planned = planNotifications(
      row('card.assigned', { cardId: '1', boardId: '2', before: [], after: [BOB] }, ALICE),
      null,
    );
    expect(planned[0]?.title).toBe('You were assigned a card');
  });
});

describe('unrelated event names', () => {
  it('ignores events this projection does not consume', () => {
    expect(planNotifications(row('card.updated', { cardId: '1' }))).toEqual([]);
    expect(planNotifications(row('message.edited', { messageId: '1' }))).toEqual([]);
  });
});

describe('planChannelDeliveries — Wave 2 delivery decisions (§3.4, §3.7)', () => {
  /* Absence of a pref row means the coded default — the matrix says direct is
     emailed immediately and pushed by default, activity is off across the
     board until someone turns a channel on. */
  it('defaults: direct emailed immediately, activity off, push on for direct', () => {
    expect(planChannelDeliveries('chat.mention', [])).toEqual({
      email: 'immediate',
      push: true,
      sms: false,
    });
    expect(planChannelDeliveries('card.due_soon', [])).toEqual({
      email: 'off',
      push: false,
      sms: false,
    });
  });

  it('batches ACTIVITY email into the digest, never sends it now', () => {
    /* A due reminder arriving in tomorrow's digest is the point of a digest;
       a mention arriving there instead of tonight defeats the point of the
       mention. */
    const prefs = [{ category: 'activity' as const, channel: 'email' as const, enabled: true }];
    expect(planChannelDeliveries('card.due_soon', prefs)).toMatchObject({ email: 'digest' });
    expect(planChannelDeliveries('chat.thread_reply', prefs)).toMatchObject({ email: 'digest' });
  });

  it('sends DIRECT email immediately, even with the same pref row shape', () => {
    const prefs = [
      { category: 'direct' as const, channel: 'email' as const, enabled: true },
      { category: 'direct' as const, channel: 'push' as const, enabled: false },
    ];
    expect(planChannelDeliveries('chat.mention', prefs)).toEqual({
      email: 'immediate',
      push: false,
      sms: false,
    });
  });

  it('an explicit off beats the default', () => {
    const prefs = [{ category: 'direct' as const, channel: 'email' as const, enabled: false }];
    expect(planChannelDeliveries('chat.direct', prefs)).toMatchObject({ email: 'off' });
  });

  it('an unknown kind falls back to activity, the conservative default', () => {
    expect(planChannelDeliveries('future.kind', [])).toEqual({
      email: 'off',
      push: false,
      sms: false,
    });
  });
});

describe('dueDateChanged — the due-reminder refire trigger (§3.8)', () => {
  const CARD = '0195ee05-0000-7000-8000-000000000030';
  const ORG = '0195ee05-0000-7000-8000-00000000000a';

  it('detects a card.updated whose due date changed', () => {
    const changed = dueDateChanged(
      row('card.updated', {
        cardId: CARD,
        changed: ['dueDate'],
        before: { dueDate: '2026-08-10T00:00:00.000Z' },
        after: { dueDate: '2026-08-12T00:00:00.000Z' },
      }),
    );
    expect(changed).toEqual({ orgId: ORG, cardId: CARD });
  });

  it('ignores a card.updated that did not touch the due date', () => {
    expect(
      dueDateChanged(
        row('card.updated', {
          cardId: CARD,
          changed: ['title'],
          before: { dueDate: '2026-08-10T00:00:00.000Z' },
          after: { dueDate: '2026-08-10T00:00:00.000Z' },
        }),
      ),
    ).toBeNull();
  });

  it('ignores a card.updated where the date did not actually move', () => {
    /* `changed` is derived from the same comparison, but the delete must not
       depend on it being right — belt and braces, per the function's doc. */
    expect(
      dueDateChanged(
        row('card.updated', {
          cardId: CARD,
          changed: ['dueDate'],
          before: { dueDate: '2026-08-10T00:00:00.000Z' },
          after: { dueDate: '2026-08-10T00:00:00.000Z' },
        }),
      ),
    ).toBeNull();
  });

  it('ignores events that are not card.updated', () => {
    expect(
      dueDateChanged(row('card.assigned', { cardId: CARD, before: [], after: [BOB] })),
    ).toBeNull();
    expect(dueDateChanged(row('card.updated', {}))).toBeNull();
  });
});
