import { describe, expect, it } from 'vitest';
import type { OutboxRow } from '@taskflow/db';
import { planNotifications } from './notification.projection.js';

/**
 * Who gets told about a message (§4, §10.6).
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
function row(payload: Record<string, unknown>, actorId: string | null = ALICE): OutboxRow {
  return {
    id: '0195ee05-0000-7000-8000-0000000000ff',
    orgId: '0195ee05-0000-7000-8000-00000000000a',
    name: 'message.sent',
    version: 1,
    actorId,
    occurredAt: new Date(),
    requestId: null,
    payload,
  } as unknown as OutboxRow;
}

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

describe('who is notified', () => {
  it('tells nobody about an ordinary channel message', () => {
    /* The most important negative. A named channel notifying every member of
       every message is how a bell becomes something people switch off, and
       then the mention that mattered goes unseen too. */
    expect(planNotifications(row(base))).toEqual([]);
  });

  it('tells the people who were mentioned', () => {
    const planned = planNotifications(row({ ...base, mentionedUserIds: [BOB, CAROL] }));

    expect(planned.map((entry) => entry.userId)).toEqual([BOB, CAROL]);
    expect(planned.every((entry) => entry.kind === 'chat.mention')).toBe(true);
    expect(planned[0]?.title).toBe('Mentioned in #general');
  });

  it('never tells the person who sent it', () => {
    /* The bug that makes a notification system feel broken rather than wrong:
       you @mention a colleague and get the notification yourself. Every branch
       excludes the actor. */
    const planned = planNotifications(row({ ...base, mentionedUserIds: [ALICE, BOB] }));

    expect(planned.map((entry) => entry.userId)).toEqual([BOB]);
  });

  it('tells DM participants even with no mention', () => {
    // A direct message notifies its recipients whether or not anybody was
    // @mentioned — that is what makes it direct.
    const planned = planNotifications(
      row({ ...base, channelName: null, directRecipientIds: [BOB] }),
    );

    expect(planned).toEqual([
      { userId: BOB, kind: 'chat.direct', title: 'New direct message', excerpt: 'hello' },
    ]);
  });

  it('tells the author of a message that was replied to', () => {
    const planned = planNotifications(row({ ...base, parentAuthorId: BOB }));

    expect(planned).toEqual([
      {
        userId: BOB,
        kind: 'chat.thread_reply',
        title: 'New reply to your message',
        excerpt: 'hello',
      },
    ]);
  });

  it('does not tell you about a reply to your own message', () => {
    expect(planNotifications(row({ ...base, parentAuthorId: ALICE }))).toEqual([]);
  });
});

describe('deduplication', () => {
  it('tells one person once, even when three rules match', () => {
    /* Mentioned, in a reply to their own message, in a DM. Without a shared
       `told` set this produces three rows for one message — and the unique
       index would reject two of them, turning a cosmetic problem into a failed
       batch that retries forever. */
    const planned = planNotifications(
      row({
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
    // A mention is more specific than a thread reply, which is more specific
    // than "a message arrived". First match wins, in that order.
    const planned = planNotifications(
      row({ ...base, mentionedUserIds: [BOB], parentAuthorId: BOB }),
    );

    expect(planned[0]?.kind).toBe('chat.mention');
  });

  it('does not collapse two different people', () => {
    const planned = planNotifications(
      row({ ...base, mentionedUserIds: [BOB], parentAuthorId: CAROL }),
    );

    expect(planned.map((entry) => entry.kind).sort()).toEqual([
      'chat.mention',
      'chat.thread_reply',
    ]);
  });
});

describe('malformed and unrelated input', () => {
  it('ignores events that are not message.sent', () => {
    const other = { ...row(base), name: 'message.edited' } as OutboxRow;
    expect(planNotifications(other)).toEqual([]);
  });

  it('survives a payload missing every optional field', () => {
    /* An event written by an older build, before `channelName` and friends
       existed. A consumer is long-lived and reads events it did not write, so
       the shape it does not recognize must produce nothing rather than throw —
       a projection that crashes stops the whole batch. */
    const sparse = row({ messageId: base.messageId, channelId: base.channelId });
    expect(planNotifications(sparse)).toEqual([]);
  });

  it('survives a payload that is not an object at all', () => {
    expect(planNotifications(row([] as unknown as Record<string, unknown>))).toEqual([]);
  });

  it('ignores non-string entries in the id lists', () => {
    const planned = planNotifications(
      row({ ...base, mentionedUserIds: [BOB, 42, null, { userId: CAROL }] }),
    );

    expect(planned.map((entry) => entry.userId)).toEqual([BOB]);
  });

  it('falls back to a generic title when the channel has no name', () => {
    const planned = planNotifications(row({ ...base, channelName: null, mentionedUserIds: [BOB] }));

    expect(planned[0]?.title).toBe('You were mentioned');
  });
});
