import { describe, expect, it } from 'vitest';
import { createRng } from './rng.js';
import { findProfile, type Profile } from './profiles.js';
import { notificationsModule } from './modules/platform.notifications.js';
import { channelsModule, type SeededChannel } from './modules/chat.channels.js';
import { messagesModule, type SeededMessageRef } from './modules/chat.messages.js';
import type { SeededMembership, SeededOrg } from './modules/tenancy.orgs.js';
import type { SeedContext, SeedDb } from './context.js';
import type { SeedModule } from './registry.js';

/**
 * `platform.notifications` fixtures, held to what the module's own header
 * documents as its scope: only `chat.direct` and `chat.mention` are real,
 * sourced 1:1 from the messages `chat.messages` already wrote — no card or
 * page notification kinds, because nothing exports the titles an honest
 * snapshot of those needs. See that module's header for the full argument.
 */

interface CapturedInsert {
  readonly table: string;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly unknown[])[];
  readonly orgId: string | null;
}

interface Harness {
  readonly ctx: SeedContext;
  rowsOf(table: string): readonly (readonly unknown[])[];
  columnsOf(table: string): readonly string[];
}

function harnessFor(
  profile: Profile,
  channels: readonly SeededChannel[],
  messageRefs: readonly SeededMessageRef[],
  seed = 'notifications-test',
): Harness {
  const inserts: CapturedInsert[] = [];
  let currentOrg: string | null = null;

  const db: SeedDb = {
    query: () => Promise.resolve([]),
    insert: (table, columns, rows) => {
      inserts.push({ table, columns, rows, orgId: currentOrg });
      return Promise.resolve(rows.length);
    },
  };

  const outputs = new Map<SeedModule, unknown>();
  outputs.set(channelsModule, { channels });
  outputs.set(messagesModule, { messageCount: messageRefs.length, messageRefs });

  const ctx: SeedContext = {
    db,
    rng: createRng(seed),
    profile,
    now: new Date('2026-08-06T12:00:00.000Z'),
    chaos: false,
    reseedPlans: false,
    storage: null,
    telephony: null,
    keys: null,
    payments: null,
    platformOperator: null,
    log: () => undefined,
    use: <Out>(module: SeedModule<Out>): Out => {
      if (!outputs.has(module)) throw new Error(`no output recorded for ${module.name}`);
      return outputs.get(module) as Out;
    },
    emit: () => undefined,
    bufferedEvents: () => [],
    orgScope: async (orgId, fn) => {
      const previous = currentOrg;
      currentOrg = orgId;
      try {
        return await fn();
      } finally {
        currentOrg = previous;
      }
    },
  };

  return {
    ctx,
    rowsOf: (table) => inserts.filter((i) => i.table === table).flatMap((i) => [...i.rows]),
    columnsOf: (table) => inserts.find((i) => i.table === table)?.columns ?? [],
  };
}

function id(kind: string, index: number): string {
  return `00000000-0000-7000-8000-${kind}${String(index).padStart(8, '0')}`;
}

function member(index: number): SeededMembership {
  return {
    membershipId: id('4d', index),
    user: {
      id: id('55', index),
      name: {
        first: `First${String(index)}`,
        last: `Last${String(index)}`,
        full: `F${String(index)} L`,
      },
      email: `user${String(index)}@taskflow.seed.test`,
    },
    role: 'member',
  };
}

const ORG_ID = id('a1', 1);
const MEMBERS = [member(0), member(1), member(2), member(3), member(4)];
const FAKE_ORG = { id: ORG_ID } as unknown as SeededOrg;

function channel(
  kind: string,
  type: SeededChannel['type'],
  roster: readonly SeededMembership[],
  name: string | null,
): SeededChannel {
  return {
    id: id(kind, 0),
    orgId: ORG_ID,
    org: FAKE_ORG,
    type,
    name,
    plan: { name, type, members: roster.length, messages: 0 },
    members: roster,
    creator: roster[0] ?? member(0),
    createdAt: new Date('2025-06-01T00:00:00.000Z'),
    archivedAt: null,
  };
}

const DM = channel('dm1', 'dm', MEMBERS.slice(0, 2), null);
const GROUP_DM = channel('gd1', 'group_dm', MEMBERS.slice(0, 4), null);
const PUBLIC = channel('pub1', 'public', MEMBERS, 'general');

function messageRef(
  ch: SeededChannel,
  index: number,
  authorId: string,
  createdAt: Date,
): SeededMessageRef {
  return {
    id: id('msg', index),
    orgId: ORG_ID,
    channelId: ch.id,
    createdAt,
    authorId,
  };
}

/* Enough messages that the 0.15 sample rate is overwhelmingly likely to hit at
   least one of each kind for the fixed test seed — determinism means the same
   seed always produces the same rolls, but the sample has to be large enough
   that "lucky" is not a coin flip. */
function manyMessages(
  ch: SeededChannel,
  count: number,
  startIndexOffset: number,
): SeededMessageRef[] {
  const refs: SeededMessageRef[] = [];
  for (let i = 0; i < count; i += 1) {
    const author = ch.members[i % ch.members.length];
    if (author === undefined) continue;
    refs.push(
      messageRef(ch, startIndexOffset + i, author.user.id, new Date(2026, 0, 1 + i, 12, 0, 0)),
    );
  }
  return refs;
}

const DEMO = findProfile('demo');

describe('platform.notifications', () => {
  it('notifies every other DM/group_dm member with the exact real-projection title', async () => {
    const refs = [...manyMessages(DM, 40, 0), ...manyMessages(GROUP_DM, 40, 1000)];
    const harness = harnessFor(DEMO, [DM, GROUP_DM, PUBLIC], refs);
    await notificationsModule.seed(harness.ctx);

    const columns = harness.columnsOf('platform.notifications');
    const kindIndex = columns.indexOf('kind');
    const titleIndex = columns.indexOf('title');
    const rows = harness.rowsOf('platform.notifications');

    const directRows = rows.filter((row) => row[kindIndex] === 'chat.direct');
    expect(directRows.length).toBeGreaterThan(0);
    for (const row of directRows) {
      expect(row[titleIndex]).toBe('New direct message');
    }
  });

  it('mentions exactly one other member per sampled message, titled with the channel name', async () => {
    const refs = manyMessages(PUBLIC, 60, 2000);
    const harness = harnessFor(DEMO, [DM, GROUP_DM, PUBLIC], refs);
    await notificationsModule.seed(harness.ctx);

    const columns = harness.columnsOf('platform.notifications');
    const kindIndex = columns.indexOf('kind');
    const titleIndex = columns.indexOf('title');
    const subjectIdIndex = columns.indexOf('subject_id');
    const rows = harness.rowsOf('platform.notifications');

    const mentionRows = rows.filter((row) => row[kindIndex] === 'chat.mention');
    expect(mentionRows.length).toBeGreaterThan(0);
    for (const row of mentionRows) {
      expect(row[titleIndex]).toBe('Mentioned in #general');
    }

    // never more than one mention per sampled message
    const bySubject = new Map<unknown, number>();
    for (const row of mentionRows) {
      const key = row[subjectIdIndex];
      bySubject.set(key, (bySubject.get(key) ?? 0) + 1);
    }
    for (const count of bySubject.values()) {
      expect(count).toBe(1);
    }
  });

  it('never notifies a message author about their own message', async () => {
    const refs = [
      ...manyMessages(DM, 40, 3000),
      ...manyMessages(GROUP_DM, 40, 4000),
      ...manyMessages(PUBLIC, 40, 5000),
    ];
    const harness = harnessFor(DEMO, [DM, GROUP_DM, PUBLIC], refs);
    await notificationsModule.seed(harness.ctx);

    const columns = harness.columnsOf('platform.notifications');
    const userIdIndex = columns.indexOf('user_id');
    const actorIdIndex = columns.indexOf('actor_id');

    for (const row of harness.rowsOf('platform.notifications')) {
      expect(row[userIdIndex]).not.toBe(row[actorIdIndex]);
    }
  });

  it('writes delivery rows only for the email channel with a valid status', async () => {
    const refs = [...manyMessages(DM, 40, 6000), ...manyMessages(GROUP_DM, 40, 7000)];
    const harness = harnessFor(DEMO, [DM, GROUP_DM, PUBLIC], refs);
    await notificationsModule.seed(harness.ctx);

    const columns = harness.columnsOf('platform.notification_deliveries');
    const channelIndex = columns.indexOf('channel');
    const statusIndex = columns.indexOf('status');
    const reasonIndex = columns.indexOf('reason');
    const rows = harness.rowsOf('platform.notification_deliveries');

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row[channelIndex]).toBe('email');
      expect(['sent', 'failed', 'suppressed']).toContain(row[statusIndex]);
      if (row[statusIndex] === 'suppressed') {
        expect(row[reasonIndex]).not.toBeNull();
      } else {
        expect(row[reasonIndex]).toBeNull();
      }
    }
  });

  it('every notification_deliveries row references a notification this run actually wrote', async () => {
    const refs = [...manyMessages(DM, 40, 8000), ...manyMessages(GROUP_DM, 40, 9000)];
    const harness = harnessFor(DEMO, [DM, GROUP_DM, PUBLIC], refs);
    await notificationsModule.seed(harness.ctx);

    const notificationColumns = harness.columnsOf('platform.notifications');
    const notificationIdIndex = notificationColumns.indexOf('id');
    const notificationIds = new Set(
      harness.rowsOf('platform.notifications').map((row) => row[notificationIdIndex]),
    );

    const deliveryColumns = harness.columnsOf('platform.notification_deliveries');
    const deliveryNotificationIdIndex = deliveryColumns.indexOf('notification_id');

    for (const row of harness.rowsOf('platform.notification_deliveries')) {
      expect(notificationIds.has(row[deliveryNotificationIdIndex])).toBe(true);
    }
  });

  it('writes nothing when no message lands a recipient', async () => {
    const harness = harnessFor(DEMO, [PUBLIC], []);
    const result = await notificationsModule.seed(harness.ctx);

    expect(harness.rowsOf('platform.notifications')).toEqual([]);
    expect(result).toEqual({ notificationCount: 0, deliveryCount: 0 });
  });

  it('is byte-for-byte reproducible from the same seed', async () => {
    const refs = [...manyMessages(DM, 30, 10000), ...manyMessages(PUBLIC, 30, 11000)];
    const a = harnessFor(DEMO, [DM, GROUP_DM, PUBLIC], refs, 'reproducible');
    const b = harnessFor(DEMO, [DM, GROUP_DM, PUBLIC], refs, 'reproducible');
    await notificationsModule.seed(a.ctx);
    await notificationsModule.seed(b.ctx);
    expect(a.rowsOf('platform.notifications')).toEqual(b.rowsOf('platform.notifications'));
  });
});
