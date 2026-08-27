import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { unsafeAsId } from '@taskflow/contracts';
import { RecordingEventBus } from '@taskflow/events';
import {
  closeDatabase,
  initializeAuditDatabase,
  initializeDatabase,
  initializePlatformAdminDatabase,
} from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import type { PendingEmailSend } from '../platform/notification.projection.js';
import { TEST_ENV } from '../testing/fixtures.js';
import { resolveAudience } from './broadcast-audience.service.js';
import {
  getBroadcastHistory,
  resendBroadcast,
  sendBroadcast,
  type BroadcastDeps,
} from './broadcast.service.js';
import type { PlatformOperator } from './org-directory.service.js';

/** A `sendNotificationEmail` that just records what it was asked to send. */
function fakeEmailSender(): {
  readonly sent: PendingEmailSend[];
  readonly send: NonNullable<BroadcastDeps['sendNotificationEmail']>;
} {
  const sent: PendingEmailSend[] = [];
  return { sent, send: (send) => sent.push(send) };
}

/**
 * Operator broadcasts (migration 0083), against real Postgres.
 *
 * Scoped to what a mocked version could not prove, the same standard
 * `branding.service.test.ts` sets for this directory:
 *
 *   - `taskflow_platform_admin` can actually INSERT into
 *     `platform.notifications`/`notification_deliveries` — migration 0083's
 *     whole point is a new RLS policy for a role that sets no `app.org_id`,
 *     and a migration review agreeing that looks right is exactly what
 *     0022/0027 and Phase 6's backlinks relay both already taught this
 *     codebase is not sufficient (CLAUDE.md's own standing lesson).
 *   - `resolveAudience`'s three target modes actually filter
 *     `identity.memberships` correctly, including excluding a SUSPENDED
 *     membership — a query built against the wrong status is silent, not an
 *     error.
 *   - A 'user' target naming someone who is not an active member of the
 *     chosen org is refused, not silently sent to nobody.
 *   - `includeInOrgAudit: false` really does skip the org's own audit_log
 *     entry while the global operator chain and the notification rows still
 *     happen — three independent writes, one flag.
 */

const PLATFORM_ADMIN_URL =
  process.env['TEST_DATABASE_PLATFORM_ADMIN_URL'] ??
  'postgresql://taskflow_platform_admin:platform-admin-dev-secret@localhost:5433/taskflow_test';

const AUDIT_URL =
  process.env['TEST_DATABASE_AUDIT_URL'] ??
  'postgresql://taskflow_audit:audit-dev-secret@localhost:5433/taskflow_test';

const OPERATOR = unsafeAsId<'UserId'>('0195dd00-0000-7000-8000-0000000000c1');
const requestId = unsafeAsId<'RequestId'>('0195dd00-0000-7000-8000-0000000000cf');
const operator: PlatformOperator = { userId: OPERATOR, requestId };

const ORG = unsafeAsId<'OrgId'>('0195dd00-0000-7000-8000-0000000000c2');
const OWNER = unsafeAsId<'UserId'>('0195dd00-0000-7000-8000-0000000000c3');
const MEMBER = unsafeAsId<'UserId'>('0195dd00-0000-7000-8000-0000000000c4');
const SUSPENDED_MEMBER = unsafeAsId<'UserId'>('0195dd00-0000-7000-8000-0000000000c5');
const OUTSIDER = unsafeAsId<'UserId'>('0195dd00-0000-7000-8000-0000000000c6');

let admin: AdminConnection;

beforeAll(async () => {
  await applyMigrations();
  admin = await connectAsMigrator();

  initializeDatabase({ url: TEST_ENV.DATABASE_URL, applicationName: 'taskflow-broadcast-svc' });
  initializeAuditDatabase({ url: AUDIT_URL, applicationName: 'taskflow-broadcast-audit' });
  initializePlatformAdminDatabase({
    url: PLATFORM_ADMIN_URL,
    applicationName: 'taskflow-broadcast-admin',
  });
});

beforeEach(async () => {
  await admin.setOrg(null);

  /* Children before parents — this suite's own previous run, or a
     neighbour's, may leave rows referencing these ids. */
  await admin.query(`DELETE FROM platform.notification_deliveries WHERE org_id = $1`, [ORG]);
  await admin.query(`DELETE FROM platform.notifications WHERE org_id = $1`, [ORG]);
  await admin.query(`DELETE FROM platform.operator_broadcasts WHERE org_id = $1`, [ORG]);
  await admin.query(`DELETE FROM platform.operator_audit_log WHERE operator_id = $1`, [OPERATOR]);
  await admin.query(`DELETE FROM audit.audit_log WHERE org_id = $1`, [ORG]);
  await admin.query(`DELETE FROM identity.memberships WHERE org_id = $1`, [ORG]);
  await admin.query(`DELETE FROM identity.orgs WHERE id = $1`, [ORG]);
  await admin.query(`DELETE FROM identity.users WHERE id = ANY($1)`, [
    [OPERATOR, OWNER, MEMBER, SUSPENDED_MEMBER, OUTSIDER],
  ]);

  for (const [id, email] of [
    [OPERATOR, 'broadcast-operator@platform.test'],
    [OWNER, 'broadcast-owner@platform.test'],
    [MEMBER, 'broadcast-member@platform.test'],
    [SUSPENDED_MEMBER, 'broadcast-suspended@platform.test'],
    [OUTSIDER, 'broadcast-outsider@platform.test'],
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
    `INSERT INTO identity.orgs (id, name, slug, status) VALUES ($1, 'Broadcast Test Org', 'broadcast-test-org', 'active')`,
    [ORG],
  );

  for (const [userId, role, status] of [
    [OWNER, 'owner', 'active'],
    [MEMBER, 'member', 'active'],
    [SUSPENDED_MEMBER, 'member', 'suspended'],
  ] as const) {
    await admin.query(
      `INSERT INTO identity.memberships (id, org_id, user_id, role, status)
       VALUES (gen_random_uuid(), $1, $2, $3, $4)`,
      [ORG, userId, role, status],
    );
  }
  /* OUTSIDER is a real user with no membership in ORG at all — the negative
     case for the 'user' target. */
});

afterAll(async () => {
  await closeDatabase();
});

describe('resolveAudience', () => {
  it('returns every ACTIVE member for target "all", excluding the suspended one', async () => {
    const members = await resolveAudience({ orgId: ORG, target: 'all' });
    expect(members.map((m) => m.userId).sort()).toEqual([OWNER, MEMBER].sort());
  });

  it('filters by role for target "role"', async () => {
    const members = await resolveAudience({ orgId: ORG, target: 'role', membershipRole: 'owner' });
    expect(members.map((m) => m.userId)).toEqual([OWNER]);
  });

  it('returns exactly one row for target "users" naming a single active member', async () => {
    const members = await resolveAudience({ orgId: ORG, target: 'users', userIds: [MEMBER] });
    expect(members.map((m) => m.userId)).toEqual([MEMBER]);
  });

  it('returns every named row for target "users" naming several active members', async () => {
    const members = await resolveAudience({
      orgId: ORG,
      target: 'users',
      userIds: [OWNER, MEMBER],
    });
    expect(members.map((m) => m.userId).sort()).toEqual([OWNER, MEMBER].sort());
  });

  it('resolves only the ACTIVE subset of a "users" request — a partial match is not an error', async () => {
    const members = await resolveAudience({
      orgId: ORG,
      target: 'users',
      userIds: [MEMBER, OUTSIDER],
    });
    expect(members.map((m) => m.userId)).toEqual([MEMBER]);
  });

  it('refuses target "users" naming nobody who is an active member of this org', async () => {
    await expect(
      resolveAudience({ orgId: ORG, target: 'users', userIds: [OUTSIDER] }),
    ).rejects.toThrow();
  });

  it('refuses target "users" naming only the SUSPENDED member — suspended is not active', async () => {
    await expect(
      resolveAudience({ orgId: ORG, target: 'users', userIds: [SUSPENDED_MEMBER] }),
    ).rejects.toThrow();
  });

  it('refuses target "users" with an empty list', async () => {
    await expect(resolveAudience({ orgId: ORG, target: 'users', userIds: [] })).rejects.toThrow();
  });
});

describe('sendBroadcast', () => {
  it('writes a notification + a pending push delivery for every resolved member, and the tracking row', async () => {
    const events = new RecordingEventBus();

    const result = await sendBroadcast({ events }, operator, {
      audience: { orgId: ORG, target: 'all' },
      subject: 'Test announcement',
      body: 'This is a test broadcast body.',
      sendPush: true,
      sendEmail: false,
      includeInOrgAudit: true,
    });

    expect(result.recipientCount).toBe(2);

    await admin.setOrg(ORG);
    const notifications = await admin.query(
      `SELECT user_id, kind, subject_type, subject_id, title, actor_id FROM platform.notifications WHERE org_id = $1`,
      [ORG],
    );
    expect(notifications.rows).toHaveLength(2);
    for (const row of notifications.rows) {
      expect(row['kind']).toBe('operator_broadcast');
      expect(row['subject_type']).toBe('operator_broadcast');
      expect(row['subject_id']).toBe(result.broadcastId);
      expect(row['title']).toBe('Test announcement');
      /* Not the operator's own id — an operator is never guaranteed to be a
         member of the org they broadcast to, and a client resolving an
         actor label against the org's own roster (mobile's `personOf`,
         ported identically to web) finds nothing and falls back to
         printing the raw uuid. No actor is the honest shape here. */
      expect(row['actor_id']).toBeNull();
    }

    const deliveries = await admin.query(
      `SELECT channel, status FROM platform.notification_deliveries WHERE org_id = $1`,
      [ORG],
    );
    expect(deliveries.rows).toHaveLength(2);
    for (const row of deliveries.rows) {
      expect(row['channel']).toBe('push');
      expect(row['status']).toBe('pending');
    }

    await admin.setOrg(null);
    const tracking = await admin.query(
      `SELECT recipient_count, audience_target FROM platform.operator_broadcasts WHERE id = $1`,
      [result.broadcastId],
    );
    expect(tracking.rows[0]).toMatchObject({ recipient_count: 2, audience_target: 'all' });

    /* Guardrail 11 — the typed event, published on the bus (this role holds
       no outbox grant), never silently skipped. */
    expect(events.names()).toContain('platform.operator_broadcast_sent');
  });

  it("records the global operator chain always, and the org's own audit chain only when asked", async () => {
    const events = new RecordingEventBus();

    await sendBroadcast({ events }, operator, {
      audience: { orgId: ORG, target: 'role', membershipRole: 'owner' },
      subject: 'Not visible to the org',
      body: 'This send opts out of the org audit trail.',
      sendPush: true,
      sendEmail: false,
      includeInOrgAudit: false,
    });

    const operatorLog = await admin.query(
      `SELECT action FROM platform.operator_audit_log WHERE operator_id = $1`,
      [OPERATOR],
    );
    expect(operatorLog.rows.length).toBeGreaterThan(0);

    await admin.setOrg(ORG);
    const orgAudit = await admin.query(
      `SELECT action FROM audit.audit_log WHERE org_id = $1 AND action = 'platform.operator_broadcast_sent'`,
      [ORG],
    );
    expect(orgAudit.rows).toHaveLength(0);
  });

  it('refuses a send with neither channel enabled', async () => {
    const events = new RecordingEventBus();
    await expect(
      sendBroadcast({ events }, operator, {
        audience: { orgId: ORG, target: 'all' },
        subject: 'x',
        body: 'y',
        sendPush: false,
        sendEmail: false,
        includeInOrgAudit: true,
      }),
    ).rejects.toThrow();
  });

  it("actually hands each resolved member's email to sendNotificationEmail, and marks the delivery sent", async () => {
    const events = new RecordingEventBus();
    const emailSender = fakeEmailSender();

    const result = await sendBroadcast(
      { events, sendNotificationEmail: emailSender.send },
      operator,
      {
        audience: { orgId: ORG, target: 'role', membershipRole: 'member' },
        subject: 'Email test',
        body: 'This should actually be handed to the mailer.',
        sendPush: false,
        sendEmail: true,
        includeInOrgAudit: true,
      },
    );

    expect(result.recipientCount).toBe(1);
    expect(emailSender.sent).toHaveLength(1);
    expect(emailSender.sent[0]).toMatchObject({
      to: 'broadcast-member@platform.test',
      title: 'Email test',
      /* /home — notificationPath's operator_broadcast case, never null; a
         null path is exactly what left email undelivered before this. */
      path: '/home',
    });

    await admin.setOrg(ORG);
    const deliveries = await admin.query(
      `SELECT status FROM platform.notification_deliveries WHERE org_id = $1 AND channel = 'email'`,
      [ORG],
    );
    expect(deliveries.rows).toHaveLength(1);
    expect(deliveries.rows[0]?.['status']).toBe('sent');
  });

  it('leaves the email delivery pending when no sendNotificationEmail is configured', async () => {
    const events = new RecordingEventBus();

    await sendBroadcast({ events }, operator, {
      audience: { orgId: ORG, target: 'role', membershipRole: 'member' },
      subject: 'No mailer configured',
      body: 'body',
      sendPush: false,
      sendEmail: true,
      includeInOrgAudit: true,
    });

    await admin.setOrg(ORG);
    const deliveries = await admin.query(
      `SELECT status FROM platform.notification_deliveries WHERE org_id = $1 AND channel = 'email'`,
      [ORG],
    );
    expect(deliveries.rows).toHaveLength(1);
    expect(deliveries.rows[0]?.['status']).toBe('pending');
  });
});

describe('resendBroadcast', () => {
  it('replays the exact stored subject, body, audience and channels as a brand-new send', async () => {
    const events = new RecordingEventBus();
    const emailSender = fakeEmailSender();

    const original = await sendBroadcast(
      { events, sendNotificationEmail: emailSender.send },
      operator,
      {
        audience: { orgId: ORG, target: 'users', userIds: [OWNER, MEMBER] },
        subject: 'Original',
        body: 'Original body.',
        sendPush: true,
        sendEmail: true,
        includeInOrgAudit: true,
      },
    );

    const resent = await resendBroadcast(
      { events, sendNotificationEmail: emailSender.send },
      operator,
      original.broadcastId,
    );

    expect(resent.broadcastId).not.toBe(original.broadcastId);
    expect(resent.recipientCount).toBe(2);

    await admin.setOrg(null);
    const tracking = await admin.query(
      `SELECT subject, body, audience_target, send_push, send_email FROM platform.operator_broadcasts WHERE id = $1`,
      [resent.broadcastId],
    );
    expect(tracking.rows[0]).toMatchObject({
      subject: 'Original',
      body: 'Original body.',
      audience_target: 'users',
      send_push: true,
      send_email: true,
    });

    /* Two sends of two people each — the resend's own email hands, not the
       original's, since each send hands its OWN deliveries. */
    expect(emailSender.sent).toHaveLength(4);
  });

  it('refuses to resend a broadcast id that does not exist', async () => {
    const events = new RecordingEventBus();
    await expect(
      resendBroadcast({ events }, operator, '00000000-0000-7000-8000-000000000000'),
    ).rejects.toThrow();
  });
});

describe('getBroadcastHistory', () => {
  it('returns only sends marked includedInOrgAudit', async () => {
    const events = new RecordingEventBus();

    await sendBroadcast({ events }, operator, {
      audience: { orgId: ORG, target: 'all' },
      subject: 'Visible send',
      body: 'body',
      sendPush: true,
      sendEmail: false,
      includeInOrgAudit: true,
    });
    await sendBroadcast({ events }, operator, {
      audience: { orgId: ORG, target: 'all' },
      subject: 'Hidden send',
      body: 'body',
      sendPush: true,
      sendEmail: false,
      includeInOrgAudit: false,
    });

    const history = await getBroadcastHistory(ORG, 10);
    expect(history.map((h) => h.subject)).toEqual(['Visible send']);
  });

  it('returns the NEWEST sends first, not the oldest, when limited', async () => {
    /* Regression guard: the default ascending order plus `.limit()` returned
       the FIRST N sends and hid recent ones. A history view wants the most
       recent — send three, ask for two, expect the last two newest-first. */
    const events = new RecordingEventBus();

    for (const subject of ['Oldest', 'Middle', 'Newest']) {
      await sendBroadcast({ events }, operator, {
        audience: { orgId: ORG, target: 'all' },
        subject,
        body: 'body',
        sendPush: true,
        sendEmail: false,
        includeInOrgAudit: true,
      });
    }

    const history = await getBroadcastHistory(ORG, 2);
    expect(history.map((h) => h.subject)).toEqual(['Newest', 'Middle']);
  });
});
