import { describe, expect, it } from 'vitest';
import { MailQueue, MemoryMailer } from '@taskflow/mail';
import { sendStandupDigest } from './standup-mail.js';
import type { StandupResult } from './standup.service.js';

/**
 * The `scope` split (this file's own header) — 'team' unchanged from before
 * the split, 'personal' filtered down to one member's own row with no
 * headline and no member cap. A hand-built `StandupResult` and a real
 * `MailQueue` over `MemoryMailer` — no database needed, `queryStandup`'s
 * own real query is what `standup.service.test.ts` proves separately.
 */

function fakeMail(): { mailer: MemoryMailer; queue: MailQueue } {
  const mailer = new MemoryMailer();
  const queue = new MailQueue({ mailer, sleep: () => Promise.resolve() });
  return { mailer, queue };
}

const STANDUP: StandupResult = {
  sprint: null,
  urgentSprintCards: [],
  headline: '3 people have overdue work.',
  members: [
    {
      userId: 'user-1',
      name: 'Aoife',
      yesterday: [],
      today: [
        { cardId: 'c1', reference: 'WEB-1', title: 'Fix login', priority: null, dueDate: null },
      ],
      overdue: [],
      urgent: [],
    },
    {
      userId: 'user-2',
      name: 'Priya',
      yesterday: [],
      today: [],
      overdue: [
        {
          cardId: 'c2',
          reference: 'WEB-2',
          title: 'Ship release',
          priority: 'urgent',
          dueDate: null,
        },
      ],
      urgent: [],
    },
  ],
};

describe('sendStandupDigest', () => {
  it("scope: 'team' includes every member and the headline", async () => {
    const { mailer, queue } = fakeMail();

    sendStandupDigest(
      { queue, webOrigin: 'https://app.test' },
      {
        to: 'admin@org.test',
        projectName: 'Website',
        projectId: 'proj-1',
        standup: STANDUP,
        scope: 'team',
        recipientUserId: 'user-1',
      },
    );
    await queue.drain();

    const mail = mailer.sent[0];
    expect(mail?.subject).toBe('Standup for Website');
    expect(mail?.text).toContain(STANDUP.headline);
    expect(mail?.text).toContain('Aoife');
    expect(mail?.text).toContain('Priya');
  });

  it("scope: 'personal' includes only the recipient's own row, no headline", async () => {
    const { mailer, queue } = fakeMail();

    sendStandupDigest(
      { queue, webOrigin: 'https://app.test' },
      {
        to: 'member@org.test',
        projectName: 'Website',
        projectId: 'proj-1',
        standup: STANDUP,
        scope: 'personal',
        recipientUserId: 'user-2',
      },
    );
    await queue.drain();

    const mail = mailer.sent[0];
    expect(mail?.subject).toBe('Your standup for Website');
    expect(mail?.text).not.toContain(STANDUP.headline);
    expect(mail?.text).toContain('Priya');
    expect(mail?.text).not.toContain('Aoife');
  });

  it("scope: 'personal' for a member with nothing to report says so, not an empty table", async () => {
    const { mailer, queue } = fakeMail();

    sendStandupDigest(
      { queue, webOrigin: 'https://app.test' },
      {
        to: 'quiet@org.test',
        projectName: 'Website',
        projectId: 'proj-1',
        standup: STANDUP,
        scope: 'personal',
        recipientUserId: 'user-does-not-exist',
      },
    );
    await queue.drain();

    const mail = mailer.sent[0];
    expect(mail?.text).toContain('Nothing to report today.');
  });
});
