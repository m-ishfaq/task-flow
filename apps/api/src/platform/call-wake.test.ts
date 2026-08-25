import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { unsafeAsId } from '@taskflow/contracts';
import type { OutboxRow } from '@taskflow/db';
import { closeDatabase, initializeAuditDatabase, initializeOpsEventsDatabase } from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import { createLogger } from '@taskflow/observability';
import { ExpoPushProvider } from './push-provider.js';
import { callWakeEvent, drainCallWake } from './call-wake.js';

/**
 * `callWakeEvent` — the one piece of `call-wake.ts` that needs no database to
 * test. The `describe('drainCallWake — operational_events', ...)` block below
 * covers the rest, against real Postgres: the exact gap this session's own
 * push-observability work closed for `notification-push.ts`, applied here —
 * this drain had NO operator-visible trace of an attempt at all before it,
 * which is precisely what made "why didn't my phone ring" undiagnosable.
 *
 * `ExpoPushProvider` cannot be faked as a plain object satisfying its TYPE —
 * its `#accessToken` private field makes it nominally, not structurally,
 * typed, the same fact `notification-push.test.ts`'s own header names. That
 * file sidesteps it by testing the (interface-typed) web channel instead;
 * `call-wake.ts` has no web channel to fall back to, so this constructs a
 * REAL `ExpoPushProvider` and stubs `global.fetch` — the one seam that
 * provider's own `send()` actually goes through — rather than reaching for
 * an unsafe cast this codebase otherwise avoids.
 */

const ALICE = '0195ee05-0000-7000-8000-000000000001';
const BOB = '0195ee05-0000-7000-8000-000000000002';

/** An outbox row shaped like the relay produces, with an overridable payload — mirrors `notification.projection.test.ts`'s own `row()`. */
function row(name: string, payload: unknown): OutboxRow {
  return {
    id: '0195ee05-0000-7000-8000-0000000000ff',
    orgId: '0195ee05-0000-7000-8000-00000000000a',
    name,
    version: 1,
    actorId: ALICE,
    occurredAt: new Date(),
    requestId: null,
    causationDepth: 0,
    payload,
    attempts: 0,
  };
}

describe('callWakeEvent', () => {
  it('reads channelId and invitedUserIds off a real rtc_session.started row', () => {
    const event = callWakeEvent(
      row('rtc_session.started', {
        sessionId: '0195ee05-0000-7000-8000-000000000030',
        channelId: '0195ee05-0000-7000-8000-000000000020',
        kind: 'audio',
        invitedCount: 2,
        invitedUserIds: [ALICE, BOB],
      }),
    );

    expect(event).toEqual({
      sessionId: '0195ee05-0000-7000-8000-000000000030',
      channelId: '0195ee05-0000-7000-8000-000000000020',
      callerId: ALICE,
      invitedUserIds: [ALICE, BOB],
    });
  });

  it('reads callerId off row.actorId, not the payload — the row has no such field', () => {
    const event = callWakeEvent(
      row('rtc_session.started', { sessionId: 's', channelId: 'x', invitedUserIds: [BOB] }),
    );
    expect(event?.callerId).toBe(ALICE);
  });

  it('ignores every other event name', () => {
    expect(
      callWakeEvent(
        row('rtc_session.ended', { sessionId: 's', channelId: 'x', invitedUserIds: [ALICE] }),
      ),
    ).toBeNull();
    expect(
      callWakeEvent(
        row('message.sent', { sessionId: 's', channelId: 'x', invitedUserIds: [ALICE] }),
      ),
    ).toBeNull();
  });

  it('rejects a payload missing channelId', () => {
    expect(
      callWakeEvent(row('rtc_session.started', { sessionId: 's', invitedUserIds: [ALICE] })),
    ).toBeNull();
  });

  it('rejects a payload missing sessionId', () => {
    expect(
      callWakeEvent(row('rtc_session.started', { channelId: 'x', invitedUserIds: [ALICE] })),
    ).toBeNull();
  });

  it('rejects a non-object payload', () => {
    expect(callWakeEvent(row('rtc_session.started', null))).toBeNull();
    expect(callWakeEvent(row('rtc_session.started', 'not an object'))).toBeNull();
  });

  it('defaults invitedUserIds to empty when absent or malformed, rather than throwing', () => {
    expect(callWakeEvent(row('rtc_session.started', { sessionId: 's', channelId: 'x' }))).toEqual({
      sessionId: 's',
      channelId: 'x',
      callerId: ALICE,
      invitedUserIds: [],
    });

    expect(
      callWakeEvent(
        row('rtc_session.started', {
          sessionId: 's',
          channelId: 'x',
          invitedUserIds: 'not-an-array',
        }),
      ),
    ).toEqual({ sessionId: 's', channelId: 'x', callerId: ALICE, invitedUserIds: [] });
  });

  it('filters non-string entries out of invitedUserIds rather than rejecting the whole row', () => {
    expect(
      callWakeEvent(
        row('rtc_session.started', {
          sessionId: 's',
          channelId: 'x',
          invitedUserIds: [ALICE, 42, null, BOB],
        }),
      ),
    ).toEqual({ sessionId: 's', channelId: 'x', callerId: ALICE, invitedUserIds: [ALICE, BOB] });
  });
});

const AUDIT_URL =
  process.env['TEST_DATABASE_AUDIT_URL'] ??
  'postgresql://taskflow_audit:audit-dev-secret@localhost:5433/taskflow_test';

const OPS_EVENTS_URL =
  process.env['TEST_DATABASE_OPS_EVENTS_URL'] ??
  'postgresql://taskflow_ops_events:ops-events-dev-secret@localhost:5433/taskflow_test';

const ORG = unsafeAsId<'OrgId'>('0195ee05-1000-7000-8000-000000000001');
const SENT_USER = unsafeAsId<'UserId'>('0195ee05-1000-7000-8000-000000000002');
const REJECTED_USER = unsafeAsId<'UserId'>('0195ee05-1000-7000-8000-000000000003');
const NO_DEVICE_USER = unsafeAsId<'UserId'>('0195ee05-1000-7000-8000-000000000004');

const SENT_TOKEN = 'ExponentPushToken[sent]';
const REJECTED_TOKEN = 'ExponentPushToken[rejected]';

const logger = createLogger({ name: 'call-wake-test', level: 'silent' });

/** Stubs the one seam `ExpoPushProvider.send` actually calls — see this file's own header. */
function stubExpoFetch(outcomeByToken: Record<string, 'sent' | 'gone' | 'rejected'>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: unknown, init: { readonly body: string }) => {
      const [message] = JSON.parse(init.body) as [{ readonly to: string }];
      const outcome = outcomeByToken[message.to];
      const ticket =
        outcome === 'sent'
          ? { status: 'ok' as const }
          : outcome === 'gone'
            ? { status: 'error' as const, details: { error: 'DeviceNotRegistered' } }
            : { status: 'error' as const, details: { error: 'MessageRateExceeded' } };
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [ticket] }) });
    }),
  );
}

/** Every `title` this tick actually sent Expo, read back off the stubbed `fetch`'s own recorded calls — the only place the value the DEVICE would show is observable from this test. */
function sentTitles(): readonly string[] {
  const calls = vi.mocked(fetch).mock.calls;
  return calls.map(([, init]) => {
    const [message] = JSON.parse((init as { readonly body: string }).body) as [
      { readonly title: string },
    ];
    return message.title;
  });
}

describe('drainCallWake — operational_events', () => {
  let admin: AdminConnection;

  beforeAll(async () => {
    await applyMigrations();
    admin = await connectAsMigrator();

    initializeAuditDatabase({ url: AUDIT_URL, applicationName: 'taskflow-call-wake-audit' });
    initializeOpsEventsDatabase({
      url: OPS_EVENTS_URL,
      applicationName: 'taskflow-call-wake-ops-events',
    });
  });

  beforeEach(async () => {
    await admin.setOrg(null);

    /* operational_events is GLOBAL (Phase 4's own lesson) — scoped to this
       suite's own session ids only, never a blanket DELETE. */
    await admin.query(`DELETE FROM platform.outbox_dispatch WHERE consumer = $1`, [
      'rtc-call-wake',
    ]);
    await admin.query(`DELETE FROM platform.outbox WHERE org_id = $1`, [ORG]);
    await admin.query(`DELETE FROM platform.expo_push_tokens WHERE user_id = ANY($1)`, [
      [SENT_USER, REJECTED_USER, NO_DEVICE_USER],
    ]);
    await admin.query(`DELETE FROM people.profiles WHERE user_id = ANY($1)`, [
      [SENT_USER, REJECTED_USER, NO_DEVICE_USER],
    ]);
    await admin.query(`DELETE FROM identity.orgs WHERE id = $1`, [ORG]);
    await admin.query(`DELETE FROM identity.users WHERE id = ANY($1)`, [
      [SENT_USER, REJECTED_USER, NO_DEVICE_USER],
    ]);

    for (const [id, email] of [
      [SENT_USER, 'call-wake-sent@platform.test'],
      [REJECTED_USER, 'call-wake-rejected@platform.test'],
      [NO_DEVICE_USER, 'call-wake-no-device@platform.test'],
    ] as const) {
      await admin.query(
        `INSERT INTO identity.users (id, email, email_normalized, email_verified_at)
         VALUES ($1, $2, $2, now())`,
        [id, email],
      );
    }
    await admin.query(
      `INSERT INTO identity.orgs (id, name, slug, status) VALUES ($1, 'Call Wake Test Org', 'call-wake-test-org', 'active')`,
      [ORG],
    );
    await admin.query(
      `INSERT INTO platform.expo_push_tokens (id, user_id, expo_push_token)
       VALUES
         (gen_random_uuid(), $1, $3),
         (gen_random_uuid(), $2, $4)`,
      [SENT_USER, REJECTED_USER, SENT_TOKEN, REJECTED_TOKEN],
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    await closeDatabase();
  });

  /** One `rtc_session.started` outbox row, inviting all three test users. */
  async function seedRingingCallEvent(): Promise<string> {
    const eventId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    await admin.query(
      `INSERT INTO platform.outbox (id, org_id, name, version, actor_id, occurred_at, payload)
       VALUES ($1, $2, 'rtc_session.started', 1, $3, now(), $4::jsonb)`,
      [
        eventId,
        ORG,
        SENT_USER,
        JSON.stringify({
          sessionId,
          channelId: crypto.randomUUID(),
          kind: 'audio',
          invitedCount: 3,
          invitedUserIds: [SENT_USER, REJECTED_USER, NO_DEVICE_USER],
        }),
      ],
    );
    return sessionId;
  }

  it('records success for a token Expo accepts', async () => {
    stubExpoFetch({ [SENT_TOKEN]: 'sent', [REJECTED_TOKEN]: 'sent' });
    const sessionId = await seedRingingCallEvent();

    await drainCallWake(new ExpoPushProvider(), logger);

    await admin.setOrg(null);
    const events = await admin.query(
      `SELECT outcome, detail FROM platform.operational_events
       WHERE kind = 'push' AND target = $1 AND detail->>'reason' = 'sent'`,
      [sessionId],
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]?.['outcome']).toBe('success');
    expect(events.rows[0]?.['detail']).toMatchObject({ pathway: 'call-wake' });
  });

  it('records a "no_device" failure, with no send attempted, for an invitee with no expo token — the exact silent case this closes', async () => {
    stubExpoFetch({ [SENT_TOKEN]: 'sent', [REJECTED_TOKEN]: 'sent' });
    const sessionId = await seedRingingCallEvent();

    const result = await drainCallWake(new ExpoPushProvider(), logger);

    /* Only 2 attempts — SENT_USER and REJECTED_USER — NOT 3. NO_DEVICE_USER
       never reaches expoPushProvider.send at all. */
    expect(result.attempted).toBe(2);

    await admin.setOrg(null);
    const events = await admin.query(
      `SELECT outcome, detail FROM platform.operational_events
       WHERE kind = 'push' AND target = $1 AND detail->>'reason' = 'no_device'`,
      [sessionId],
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]?.['outcome']).toBe('failure');
  });

  it('records a "rejected" failure for a ticket-level rejection, using the same vocabulary notification-push.ts uses', async () => {
    stubExpoFetch({ [SENT_TOKEN]: 'sent', [REJECTED_TOKEN]: 'rejected' });
    const sessionId = await seedRingingCallEvent();

    await drainCallWake(new ExpoPushProvider(), logger);

    await admin.setOrg(null);
    const events = await admin.query(
      `SELECT outcome, detail FROM platform.operational_events
       WHERE kind = 'push' AND target = $1 AND detail->>'reason' = 'rejected'`,
      [sessionId],
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]?.['outcome']).toBe('failure');
  });

  describe('the caller name in the title (migration 0087)', () => {
    it('names the caller when people.profiles has a display name for them', async () => {
      stubExpoFetch({ [SENT_TOKEN]: 'sent', [REJECTED_TOKEN]: 'sent' });
      await admin.query(`INSERT INTO people.profiles (user_id, display_name) VALUES ($1, $2)`, [
        SENT_USER,
        'Alice Caller',
      ]);
      // seedRingingCallEvent's actor_id is always SENT_USER — see its own definition.
      await seedRingingCallEvent();

      await drainCallWake(new ExpoPushProvider(), logger);

      expect(sentTitles().every((title) => title === 'Incoming call from Alice Caller')).toBe(true);
    });

    it('falls back to the caller email when they have no display name set', async () => {
      stubExpoFetch({ [SENT_TOKEN]: 'sent', [REJECTED_TOKEN]: 'sent' });
      // No people.profiles row for SENT_USER this time — only the identity.users
      // row beforeEach already seeded, so resolveActorLabels' second tier answers.
      await seedRingingCallEvent();

      await drainCallWake(new ExpoPushProvider(), logger);

      expect(
        sentTitles().every((title) => title === 'Incoming call from call-wake-sent@platform.test'),
      ).toBe(true);
    });

    it('falls back to the plain, name-free title when the caller cannot be resolved at all', async () => {
      stubExpoFetch({ [SENT_TOKEN]: 'sent', [REJECTED_TOKEN]: 'sent' });
      // A caller id with no identity.users row at all — a deleted account,
      // the one case resolveActorLabels legitimately returns nothing for.
      const ghostCallerId = crypto.randomUUID();
      const sessionId = crypto.randomUUID();
      await admin.query(
        `INSERT INTO platform.outbox (id, org_id, name, version, actor_id, occurred_at, payload)
         VALUES ($1, $2, 'rtc_session.started', 1, $3, now(), $4::jsonb)`,
        [
          crypto.randomUUID(),
          ORG,
          ghostCallerId,
          JSON.stringify({
            sessionId,
            channelId: crypto.randomUUID(),
            kind: 'audio',
            invitedCount: 1,
            invitedUserIds: [SENT_USER],
          }),
        ],
      );

      await drainCallWake(new ExpoPushProvider(), logger);

      expect(sentTitles()).toEqual(['Incoming call']);
    });
  });
});
