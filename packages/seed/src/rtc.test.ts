import { describe, expect, it } from 'vitest';
import { createRng } from './rng.js';
import { findProfile, type Profile } from './profiles.js';
import { rtcModule } from './modules/rtc.calls.js';
import { channelsModule, type SeededChannel } from './modules/chat.channels.js';
import type { SeededMembership, SeededOrg } from './modules/tenancy.orgs.js';
import type { SeedContext, SeedDb } from './context.js';
import type { SeedModule } from './registry.js';

/**
 * Call history fixtures, held to the invariants the database enforces that a
 * fake harness can still check without Postgres: the mesh cap
 * (`sessions_max_participants_cap` mirrors `MESH_PARTICIPANT_CAP`), and the
 * shape rule this module adds on top of what any CHECK could catch — a call
 * against a public or private channel is a row the product cannot produce,
 * because public/private channels have no ring list (ai/phase-13-webrtc.md's
 * own still-open item).
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
  seed = 'rtc-test',
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

  const ctx: SeedContext = {
    db,
    rng: createRng(seed),
    profile,
    now: new Date('2026-08-06T12:00:00.000Z'),
    chaos: false,
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

/* -------------------------------------------------------------------------- *
 * A tenant with one of each channel type, small enough to read
 * -------------------------------------------------------------------------- */

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
): SeededChannel {
  return {
    id: id(kind, 0),
    orgId: ORG_ID,
    org: FAKE_ORG,
    type,
    name: type === 'public' ? 'general' : null,
    plan: { name: type === 'public' ? 'general' : null, type, members: roster.length, messages: 0 },
    members: roster,
    creator: roster[0] ?? member(0),
    createdAt: new Date('2025-06-01T00:00:00.000Z'),
    archivedAt: null,
  };
}

const CHANNELS: readonly SeededChannel[] = [
  channel('c1', 'dm', MEMBERS.slice(0, 2)),
  channel('c2', 'group_dm', MEMBERS.slice(0, 4)),
  channel('c3', 'public', MEMBERS),
  /* Enough additional dm/group_dm channels that at least one recording is
     overwhelmingly likely (not merely possible) for this fixture's fixed
     seed — determinism means a lucky roll here passes every run, but the
     sample still has to be large enough that "lucky" isn't a coin flip. */
  channel('c4', 'dm', MEMBERS.slice(1, 3)),
  channel('c5', 'dm', MEMBERS.slice(2, 4)),
  channel('c6', 'group_dm', MEMBERS.slice(0, 3)),
  channel('c7', 'group_dm', MEMBERS.slice(1, 4)),
  channel('c8', 'dm', MEMBERS.slice(3, 5)),
];

const DEMO = findProfile('demo');

describe('rtc.calls', () => {
  it('seeds calls only against dm and group_dm channels, never public or private', async () => {
    const harness = harnessFor(DEMO, CHANNELS);
    await rtcModule.seed(harness.ctx);

    const sessions = harness.rowsOf('rtc.sessions');
    expect(sessions.length).toBeGreaterThan(0);

    const columns = harness.columnsOf('rtc.sessions');
    const channelIdIndex = columns.indexOf('channel_id');
    const publicChannelId = channel('c3', 'public', MEMBERS).id;

    for (const row of sessions) {
      expect(row[channelIdIndex]).not.toBe(publicChannelId);
    }
  });

  it('never exceeds the mesh cap — joined_count <= max_participants on every row', async () => {
    const harness = harnessFor(DEMO, CHANNELS);
    await rtcModule.seed(harness.ctx);

    const columns = harness.columnsOf('rtc.sessions');
    const joinedIndex = columns.indexOf('joined_count');
    const maxIndex = columns.indexOf('max_participants');

    for (const row of harness.rowsOf('rtc.sessions')) {
      expect(row[joinedIndex] as number).toBeLessThanOrEqual(row[maxIndex] as number);
    }
  });

  it('produces both answered and missed calls, not just one shape', async () => {
    const harness = harnessFor(DEMO, CHANNELS);
    await rtcModule.seed(harness.ctx);

    const columns = harness.columnsOf('rtc.sessions');
    const reasonIndex = columns.indexOf('end_reason');
    const reasons = new Set(harness.rowsOf('rtc.sessions').map((row) => row[reasonIndex]));

    expect(reasons.has('hung_up')).toBe(true);
    expect(reasons.has('no_answer')).toBe(true);
  });

  it('every participant row references a session this run actually wrote', async () => {
    const harness = harnessFor(DEMO, CHANNELS);
    await rtcModule.seed(harness.ctx);

    const sessionColumns = harness.columnsOf('rtc.sessions');
    const sessionIdIndex = sessionColumns.indexOf('id');
    const sessionIds = new Set(harness.rowsOf('rtc.sessions').map((row) => row[sessionIdIndex]));

    const participantColumns = harness.columnsOf('rtc.participants');
    const participantSessionIdIndex = participantColumns.indexOf('session_id');

    for (const row of harness.rowsOf('rtc.participants')) {
      expect(sessionIds.has(row[participantSessionIdIndex])).toBe(true);
    }
  });

  it('attaches a recording only to an answered call, and only joined participants consented', async () => {
    const harness = harnessFor(DEMO, CHANNELS);
    await rtcModule.seed(harness.ctx);

    const recordings = harness.rowsOf('rtc.recordings');
    expect(recordings.length).toBeGreaterThan(0); // the demo mix eventually rolls one

    const sessionColumns = harness.columnsOf('rtc.sessions');
    const sIdIndex = sessionColumns.indexOf('id');
    const sReasonIndex = sessionColumns.indexOf('end_reason');
    const reasonBySession = new Map(
      harness.rowsOf('rtc.sessions').map((row) => [row[sIdIndex], row[sReasonIndex]]),
    );

    const recordingColumns = harness.columnsOf('rtc.recordings');
    const rSessionIdIndex = recordingColumns.indexOf('session_id');

    const participantColumns = harness.columnsOf('rtc.participants');
    const pSessionIdIndex = participantColumns.indexOf('session_id');
    const pStateIndex = participantColumns.indexOf('state');
    const pConsentIndex = participantColumns.indexOf('recording_consent_at');

    for (const row of recordings) {
      const sessionId = row[rSessionIdIndex];
      expect(reasonBySession.get(sessionId)).toBe('hung_up');

      const participants = harness
        .rowsOf('rtc.participants')
        .filter((p) => p[pSessionIdIndex] === sessionId);
      for (const p of participants) {
        expect(p[pStateIndex]).toBe('left'); // everyone in an answered call joined
        expect(p[pConsentIndex]).not.toBeNull();
      }
    }
  });

  it('writes nothing when there is no eligible channel', async () => {
    const harness = harnessFor(DEMO, [channel('c3', 'public', MEMBERS)]);
    const result = await rtcModule.seed(harness.ctx);

    expect(harness.rowsOf('rtc.sessions')).toEqual([]);
    expect(result).toEqual({ sessionCount: 0, recordingCount: 0 });
  });

  it('is byte-for-byte reproducible from the same seed', async () => {
    const a = harnessFor(DEMO, CHANNELS, 'reproducible');
    const b = harnessFor(DEMO, CHANNELS, 'reproducible');
    await rtcModule.seed(a.ctx);
    await rtcModule.seed(b.ctx);
    expect(a.rowsOf('rtc.sessions')).toEqual(b.rowsOf('rtc.sessions'));
  });
});
