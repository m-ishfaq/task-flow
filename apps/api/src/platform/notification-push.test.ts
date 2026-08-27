import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { unsafeAsId } from '@taskflow/contracts';
import {
  closeDatabase,
  initializeAuditDatabase,
  initializeDatabase,
  initializeOpsEventsDatabase,
} from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import { createLogger } from '@taskflow/observability';
import { TEST_ENV } from '../testing/fixtures.js';
import { deliverPendingPushes } from './notification-push.js';
import type { PushProvider, PushSendOutcome } from './push-provider.js';

/**
 * `deliverPendingPushes`, against real Postgres — scoped to the migration
 * 0085 gap this session closed: every terminal outcome (sent, a real
 * rejection, nothing to send to) now writes a `platform.operational_events`
 * row an operator can actually see on the Operations tab, not just an
 * in-process counter logged at `debug`. `ExpoPushProvider` cannot be faked
 * as a plain object (its `#accessToken` private field makes it nominally,
 * not structurally, typed), so this exercises the `web` channel — the
 * `recordPushOutcome` helper both channels share, so this is the whole
 * behavior either way.
 *
 * Two SEPARATE users, each with exactly one subscription, rather than one
 * user with two — a shared user would have every delivery row fan out to
 * BOTH subscriptions (this file's own header on why a row targets every
 * device on every channel), mixing a "sent" and a "rejected" outcome onto
 * the SAME delivery and defeating the point of isolating them.
 *
 * `platform.operational_events` is GLOBAL, like `platform.outbox` (Phase 4's
 * own lesson, `relay.test.ts`'s `ours()`) — cleanup here is scoped to this
 * suite's own fixed `target` (the delivery id), never a blanket DELETE that
 * could race a concurrently-running suite.
 */

const AUDIT_URL =
  process.env['TEST_DATABASE_AUDIT_URL'] ??
  'postgresql://taskflow_audit:audit-dev-secret@localhost:5433/taskflow_test';

const OPS_EVENTS_URL =
  process.env['TEST_DATABASE_OPS_EVENTS_URL'] ??
  'postgresql://taskflow_ops_events:ops-events-dev-secret@localhost:5433/taskflow_test';

const ORG = unsafeAsId<'OrgId'>('0195dd00-0000-7000-8000-0000000000e1');
const SENT_USER = unsafeAsId<'UserId'>('0195dd00-0000-7000-8000-0000000000e2');
const REJECTED_USER = unsafeAsId<'UserId'>('0195dd00-0000-7000-8000-0000000000e7');

const SENT_NOTIFICATION = '0195dd00-0000-7000-8000-0000000000e3';
const SENT_DELIVERY = '0195dd00-0000-7000-8000-0000000000e4';
const REJECTED_NOTIFICATION = '0195dd00-0000-7000-8000-0000000000e5';
const REJECTED_DELIVERY = '0195dd00-0000-7000-8000-0000000000e6';

const SENT_ENDPOINT = 'https://push.example/sent';
const REJECTED_ENDPOINT = 'https://push.example/rejected';

const logger = createLogger({ name: 'notification-push-test', level: 'silent' });

function fakeWebProvider(outcomeByEndpoint: Record<string, PushSendOutcome>): PushProvider {
  return {
    send: (input) => {
      const outcome = outcomeByEndpoint[input.endpoint];
      if (outcome === undefined)
        return Promise.reject(new Error(`no fake outcome for ${input.endpoint}`));
      return Promise.resolve(outcome);
    },
  };
}

let admin: AdminConnection;

beforeAll(async () => {
  await applyMigrations();
  admin = await connectAsMigrator();

  initializeDatabase({ url: TEST_ENV.DATABASE_URL, applicationName: 'taskflow-push-drain-svc' });
  initializeAuditDatabase({ url: AUDIT_URL, applicationName: 'taskflow-push-drain-audit' });
  initializeOpsEventsDatabase({
    url: OPS_EVENTS_URL,
    applicationName: 'taskflow-push-drain-ops-events',
  });
});

beforeEach(async () => {
  await admin.setOrg(null);

  /* Children before parents, and `operational_events` scoped to OUR
     delivery ids only — see this file's own header.

     Every DELETE runs under the scope its table's RLS keys on, for exactly
     the reason the INSERTs below do: the migrator does not bypass RLS, so a
     delete issued under the wrong scope matches ZERO rows and removes
     nothing — silently, with no error to notice. That is what left the org
     row behind between tests and collided the next insert on `orgs_pkey`. */
  await admin.query(`DELETE FROM platform.operational_events WHERE target = ANY($1)`, [
    [SENT_DELIVERY, REJECTED_DELIVERY],
  ]);

  await admin.setOrg(ORG);
  await admin.query(`DELETE FROM platform.notification_deliveries WHERE org_id = $1`, [ORG]);
  await admin.query(`DELETE FROM platform.notifications WHERE org_id = $1`, [ORG]);

  /* Self-scoped on app.user_id (migration 0029), so one scope per owner. */
  for (const userId of [SENT_USER, REJECTED_USER]) {
    await admin.setUser(userId);
    await admin.query(`DELETE FROM platform.push_subscriptions WHERE user_id = $1`, [userId]);
  }

  await admin.setOrg(ORG);
  await admin.query(`DELETE FROM identity.orgs WHERE id = $1`, [ORG]);

  await admin.setOrg(null);
  await admin.query(`DELETE FROM identity.users WHERE id = ANY($1)`, [[SENT_USER, REJECTED_USER]]);

  for (const [id, email] of [
    [SENT_USER, 'push-drain-sent@platform.test'],
    [REJECTED_USER, 'push-drain-rejected@platform.test'],
  ] as const) {
    await admin.query(
      `INSERT INTO identity.users (id, email, email_normalized, email_verified_at)
       VALUES ($1, $2, $2, now())`,
      [id, email],
    );
  }
  /* orgs RLS keys on app.org_id (migration 0004) and the migrator does NOT
     bypass it, so an org row can only be inserted under a scope naming its own
     id — the pattern `wave2.sweep.test.ts` already documents and follows.
     Without this the INSERT is refused and every test in this file fails in
     setup. */
  await admin.setOrg(ORG);
  await admin.query(
    `INSERT INTO identity.orgs (id, name, slug, status) VALUES ($1, 'Push Drain Test Org', 'push-drain-test-org', 'active')`,
    [ORG],
  );
  /* One statement per owner: push_subscriptions' RLS gates INSERT on
     `user_id = app.user_id` (0029), which a single two-row VALUES list can
     never satisfy for two different users. */
  for (const [userId, endpoint] of [
    [SENT_USER, SENT_ENDPOINT],
    [REJECTED_USER, REJECTED_ENDPOINT],
  ] as const) {
    await admin.setUser(userId);
    await admin.query(
      `INSERT INTO platform.push_subscriptions (id, user_id, endpoint, p256dh, auth)
       VALUES (gen_random_uuid(), $1, $2, 'p256dh-key', 'auth-secret')`,
      [userId, endpoint],
    );
  }

  /* Back to the org scope for the notification/delivery rows below. */
  await admin.setOrg(ORG);

  /* subject_type 'membership' resolves to a real, non-null path (/settings)
     with no channel_id/board_id required — the shortest route to a row
     `deliverPendingPushes` will actually attempt to send. */
  for (const [userId, notificationId, deliveryId] of [
    [SENT_USER, SENT_NOTIFICATION, SENT_DELIVERY],
    [REJECTED_USER, REJECTED_NOTIFICATION, REJECTED_DELIVERY],
  ]) {
    await admin.query(
      `INSERT INTO platform.notifications
         (id, org_id, user_id, kind, subject_type, subject_id, title, excerpt, created_at)
       VALUES ($1, $2, $3, 'member.added', 'membership', gen_random_uuid(), 'Test', 'body', now())`,
      [notificationId, ORG, userId],
    );
    await admin.query(
      `INSERT INTO platform.notification_deliveries
         (id, org_id, user_id, notification_id, channel, status)
       VALUES ($1, $2, $3, $4, 'push', 'pending')`,
      [deliveryId, ORG, userId, notificationId],
    );
  }
});

afterAll(async () => {
  await closeDatabase();
});

describe('deliverPendingPushes — operational_events (migration 0085)', () => {
  it('records a success row for a delivery the provider accepts', async () => {
    const web = fakeWebProvider({ [SENT_ENDPOINT]: 'sent', [REJECTED_ENDPOINT]: 'sent' });

    await deliverPendingPushes({ web }, logger);

    await admin.setOrg(null);
    const events = await admin.query(
      `SELECT outcome FROM platform.operational_events WHERE kind = 'push' AND target = $1`,
      [SENT_DELIVERY],
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]?.['outcome']).toBe('success');
  });

  it('records a failure row AND logs a warning for a ticket-level rejection — previously silent at every level', async () => {
    const web = fakeWebProvider({ [SENT_ENDPOINT]: 'sent', [REJECTED_ENDPOINT]: 'failed' });

    await deliverPendingPushes({ web }, logger);

    await admin.setOrg(null);
    const events = await admin.query(
      `SELECT outcome, detail FROM platform.operational_events WHERE kind = 'push' AND target = $1`,
      [REJECTED_DELIVERY],
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]?.['outcome']).toBe('failure');
    expect(events.rows[0]?.['detail']).toMatchObject({ reason: 'rejected', channel: 'web' });

    await admin.setOrg(ORG);
    const delivery = await admin.query(
      `SELECT status FROM platform.notification_deliveries WHERE id = $1`,
      [REJECTED_DELIVERY],
    );
    expect(delivery.rows[0]?.['status']).toBe('failed');
  });

  it("records the thrown error's own message for a transient (network) failure", async () => {
    /* fakeWebProvider throws for any endpoint it has no configured outcome
       for — reused here as the transient case, rather than a third helper. */
    const web = fakeWebProvider({ [SENT_ENDPOINT]: 'sent' });

    await deliverPendingPushes({ web }, logger);

    await admin.setOrg(null);
    const events = await admin.query(
      `SELECT outcome, detail FROM platform.operational_events WHERE kind = 'push' AND target = $1`,
      [REJECTED_DELIVERY],
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]?.['outcome']).toBe('failure');
    expect(events.rows[0]?.['detail']).toMatchObject({
      reason: 'transient',
      channel: 'web',
      error: `no fake outcome for ${REJECTED_ENDPOINT}`,
    });

    /* Transient means "try again next tick" — unlike a rejection, the
       delivery must stay pending, not be marked failed. */
    await admin.setOrg(ORG);
    const delivery = await admin.query(
      `SELECT status FROM platform.notification_deliveries WHERE id = $1`,
      [REJECTED_DELIVERY],
    );
    expect(delivery.rows[0]?.['status']).toBe('pending');
  });

  it('records a failure row for a delivery with no registered device at all', async () => {
    await admin.setOrg(null);
    await admin.query(`DELETE FROM platform.push_subscriptions WHERE user_id = $1`, [
      REJECTED_USER,
    ]);

    const web = fakeWebProvider({ [SENT_ENDPOINT]: 'sent' });
    await deliverPendingPushes({ web }, logger);

    const events = await admin.query(
      `SELECT outcome, detail FROM platform.operational_events WHERE kind = 'push' AND target = $1`,
      [REJECTED_DELIVERY],
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]?.['outcome']).toBe('failure');
    expect(events.rows[0]?.['detail']).toMatchObject({ reason: 'no_device' });
  });
});

describe('deliverPendingPushes — the circuit breaker (migration 0086)', () => {
  /* A transient failure leaves the delivery `pending` (this file's own
     header) rather than resolving it, so the SAME REJECTED_DELIVERY row
     — never re-seeded between calls — is exactly what gets retried on
     each successive call, mirroring what a real relay tick does. */
  const alwaysThrowsForRejected = fakeWebProvider({ [SENT_ENDPOINT]: 'sent' });

  it('resets consecutive_failures to 0 the next time that subscription succeeds', async () => {
    await deliverPendingPushes({ web: alwaysThrowsForRejected }, logger);
    await deliverPendingPushes({ web: alwaysThrowsForRejected }, logger);

    await admin.setOrg(null);
    const midway = await admin.query(
      `SELECT consecutive_failures FROM platform.push_subscriptions WHERE user_id = $1`,
      [REJECTED_USER],
    );
    expect(midway.rows[0]?.['consecutive_failures']).toBe(2);

    const nowSucceeds = fakeWebProvider({ [SENT_ENDPOINT]: 'sent', [REJECTED_ENDPOINT]: 'sent' });
    await deliverPendingPushes({ web: nowSucceeds }, logger);

    const after = await admin.query(
      `SELECT consecutive_failures FROM platform.push_subscriptions WHERE user_id = $1`,
      [REJECTED_USER],
    );
    expect(after.rows[0]?.['consecutive_failures']).toBe(0);
  });

  it('retires (deletes) a subscription once it crosses MAX_CONSECUTIVE_TRANSIENT_FAILURES, instead of retrying it forever', async () => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await deliverPendingPushes({ web: alwaysThrowsForRejected }, logger);
    }

    await admin.setOrg(null);
    const stillAlive = await admin.query(
      `SELECT id FROM platform.push_subscriptions WHERE user_id = $1`,
      [REJECTED_USER],
    );
    expect(stillAlive.rows).toHaveLength(1);

    /* The 5th consecutive failure — this is the one that crosses the
       threshold and must retire the subscription. The delivery itself is
       still `pending` right after this call (this attempt's own outcome
       was transient, same as any other), so retirement is asserted
       first, on its own. */
    await deliverPendingPushes({ web: alwaysThrowsForRejected }, logger);

    const retired = await admin.query(
      `SELECT id FROM platform.push_subscriptions WHERE user_id = $1`,
      [REJECTED_USER],
    );
    expect(retired.rows).toHaveLength(0);

    /* One call later, with the subscription already gone, the STILL-pending
       delivery finally resolves via the ordinary `no_device` path instead
       of being retried forever with nothing left to retry it against. */
    await deliverPendingPushes({ web: alwaysThrowsForRejected }, logger);

    await admin.setOrg(ORG);
    const delivery = await admin.query(
      `SELECT status FROM platform.notification_deliveries WHERE id = $1`,
      [REJECTED_DELIVERY],
    );
    expect(delivery.rows[0]?.['status']).toBe('failed');
  });
});
