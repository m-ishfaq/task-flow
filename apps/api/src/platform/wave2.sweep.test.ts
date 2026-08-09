import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { unsafeAsId, type OrgId, type UserId } from '@taskflow/contracts';
import {
  and,
  closeDatabase,
  eq,
  initializeAuditDatabase,
  initializeSweepDatabase,
  schema,
  withAuditScope,
} from '@taskflow/db';
import { createLogger, type Logger } from '@taskflow/observability';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import { runDueReminderSweep } from './due-reminders.js';
import { collectDigestBatches, markDigestSent } from './digest.js';
import { deliverPendingPushes } from './notification-push.js';
import { drainNotificationsFully } from './notification.projection.js';
import type { PushProvider } from './push-provider.js';

/**
 * Phase 9 Wave 2's sweeps, against real Postgres (`docker compose up -d`).
 *
 * Three properties that only a real execution can demonstrate:
 *
 *   - The due-reminder sweep is IDEMPOTENT — the unique index
 *     `notifications_event_user_key` refuses a second row for the same
 *     (org, subject, user, kind), so an hourly sweep over a still-due card
 *     writes exactly one reminder. A mocked database would happily insert
 *     duplicates; the constraint is the mechanism.
 *   - A due-date EDIT clears the fired reminder through the projection, so
 *     the NEXT sweep pass re-fires against the new date — the one gap the
 *     unique index does not close on its own.
 *   - The digest sweep collects pending activity-email rows grouped per
 *     recipient, and its conditional mark means a second pass does not
 *     re-collect what the first marked sent.
 *
 * The sweep and digest run as TWO different system roles — the sweep as
 * `taskflow_notification_sweep` (migration 0029's new column-limited role),
 * the digest as `taskflow_audit` — so both pools must be initialized here,
 * exactly as `main.ts` does in production.
 */

const AUDIT_URL =
  process.env['TEST_DATABASE_AUDIT_URL'] ??
  'postgresql://taskflow_audit:audit-dev-secret@localhost:5433/taskflow_test';
const SWEEP_URL =
  process.env['TEST_DATABASE_NOTIFICATION_SWEEP_URL'] ??
  'postgresql://taskflow_notification_sweep:sweep-dev-secret@localhost:5433/taskflow_test';

/* Annotated (not just `unsafeAsId<'OrgId'>`) because the no-unused-vars rule
   does not count a generic type ARGUMENT as use — the imported types must
   appear in a real annotation or they are reported unused. */
const ORG: OrgId = unsafeAsId('0195ee10-0000-7000-8000-00000000000a');
const USER: UserId = unsafeAsId('0195ee10-0000-7000-8000-000000000001');
const OTHER: UserId = unsafeAsId('0195ee10-0000-7000-8000-000000000002');
const PROJECT = '0195ee10-0000-7000-8000-000000000010';
const BOARD = '0195ee10-0000-7000-8000-000000000011';
const LIST = '0195ee10-0000-7000-8000-000000000012';
const CARD = '0195ee10-0000-7000-8000-000000000013';

let admin: AdminConnection;

/* Removes every TEST-SPECIFIC row, leaving the base tenant (users, org,
   project, board, list seeded in `beforeAll`) standing — cards, deliveries
   and notifications are what each test seeds and tears down. */
async function clearAll(): Promise<void> {
  await admin.setOrg(ORG);
  /* Deliveries explicitly, not just via the notifications cascade: a failed
     earlier run can leave orphans a cascade from a now-gone notification row
     cannot reach. */
  await admin.query(`DELETE FROM platform.notification_deliveries WHERE org_id = $1`, [ORG]);
  await admin.query(`DELETE FROM platform.notifications WHERE org_id = $1`, [ORG]);
  await admin.query(`DELETE FROM platform.outbox WHERE org_id = $1`, [ORG]);
  await admin.query(`DELETE FROM work.cards WHERE org_id = $1`, [ORG]);
  /* A leaked 'suspended' status from Phase 12 §3.9's own tests must not bleed
     into every other test in this file, whose sweeps all assume the base
     tenant is reachable. */
  await admin.query(`UPDATE identity.orgs SET status = 'active' WHERE id = $1`, [ORG]);
  /* Prefs have no DELETE policy (0027 grants SELECT/INSERT/UPDATE only), so a
     delete would silently match zero rows and LEAK the previous test's rows
     into the next — the delivery rows prove the leak. Disable instead: the
     `self_update` policy keys on app.user_id, so declare whose row is being
     amended, exactly as a real request would. */
  for (const userId of [USER, OTHER]) {
    await admin.query(`SELECT set_config('app.user_id', $1, false)`, [userId]);
    await admin.query(
      `UPDATE identity.notification_prefs SET enabled = false
       WHERE user_id = $1 AND category = 'activity' AND channel IN ('email', 'push')`,
      [userId],
    );
  }
  await admin.query(`SELECT set_config('app.user_id', '', false)`);
  await admin.setOrg(null);
}

/* Removes the base tenant itself. Only for afterAll — beforeAll seeds it. */
async function clearTenant(): Promise<void> {
  await admin.setOrg(ORG);
  await admin.query(`DELETE FROM platform.notification_deliveries WHERE org_id = $1`, [ORG]);
  await admin.query(`DELETE FROM platform.notifications WHERE org_id = $1`, [ORG]);
  await admin.query(`DELETE FROM platform.outbox WHERE org_id = $1`, [ORG]);
  await admin.query(`DELETE FROM work.cards WHERE org_id = $1`, [ORG]);
  await admin.query(`DELETE FROM work.lists WHERE org_id = $1`, [ORG]);
  await admin.query(`DELETE FROM work.boards WHERE org_id = $1`, [ORG]);
  await admin.query(`DELETE FROM work.projects WHERE org_id = $1`, [ORG]);
  await admin.query(`DELETE FROM identity.notification_prefs WHERE user_id = ANY($1::uuid[])`, [
    [USER, OTHER],
  ]);
  await admin.query(`DELETE FROM identity.memberships WHERE org_id = $1`, [ORG]);
  await admin.query(`DELETE FROM identity.orgs WHERE id = $1`, [ORG]);
  await admin.query(`DELETE FROM identity.users WHERE id = ANY($1::uuid[])`, [[USER, OTHER]]);
  await admin.setOrg(null);
}

async function seedCard(dueInHours: number, cardId: string = CARD): Promise<void> {
  await admin.setOrg(ORG);
  await admin.query(
    `INSERT INTO work.cards
       (id, org_id, project_id, board_id, list_id, number, title, rank, assignee_ids, due_date)
     VALUES ($1, $2, $3, $4, $5, 1, 'Sweep Card', 'a0', $6, now() + ($7 || ' hours')::interval)`,
    [cardId, ORG, PROJECT, BOARD, LIST, [USER], String(dueInHours)],
  );
  await admin.setOrg(null);
}

async function seedPrefs(enabled: boolean): Promise<void> {
  await admin.setOrg(ORG);
  /* `notification_prefs`'s self-scoped RLS keys on app.user_id (0027) —
     seeding as the migrator must declare whose preference this is, exactly
     as a real request would. */
  await admin.query(`SELECT set_config('app.user_id', $1, false)`, [USER]);
  await admin.query(
    `INSERT INTO identity.notification_prefs (user_id, category, channel, enabled)
     VALUES ($1, 'activity', 'email', $2)
     ON CONFLICT (user_id, category, channel) DO UPDATE SET enabled = EXCLUDED.enabled`,
    [USER, enabled],
  );
  await admin.query(`SELECT set_config('app.user_id', '', false)`);
  await admin.setOrg(null);
}

beforeAll(async () => {
  await applyMigrations();
  admin = await connectAsMigrator();

  await admin.setOrg(null);
  await clearTenant();
  for (const [id, email] of [
    [USER, 'sweep@wave2.test'],
    [OTHER, 'other@wave2.test'],
  ] as const) {
    await admin.query(
      `INSERT INTO identity.users (id, email, email_normalized, email_verified_at)
       VALUES ($1, $2, $2, now())`,
      [id, email],
    );
  }

  await admin.setOrg(ORG);
  await admin.query(`INSERT INTO identity.orgs (id, name, slug) VALUES ($1, 'Wave2', 'wave2')`, [
    ORG,
  ]);
  await admin.query(
    `INSERT INTO identity.memberships (id, org_id, user_id, role)
     VALUES (gen_random_uuid(), $1, $2, 'member')`,
    [ORG, USER],
  );
  await admin.query(
    `INSERT INTO work.projects (id, org_id, name, key) VALUES ($1, $2, 'Wave2', 'W2')`,
    [PROJECT, ORG],
  );
  await admin.query(
    `INSERT INTO work.boards (id, org_id, project_id, name, rank)
     VALUES ($1, $2, $3, 'Wave2 Board', 'a0')`,
    [BOARD, ORG, PROJECT],
  );
  await admin.query(
    `INSERT INTO work.lists (id, org_id, project_id, board_id, name, rank)
     VALUES ($1, $2, $3, $4, 'Wave2 List', 'a0')`,
    [LIST, ORG, PROJECT, BOARD],
  );
  await admin.setOrg(null);

  initializeAuditDatabase({ url: AUDIT_URL, applicationName: 'taskflow-wave2-test-audit' });
  initializeSweepDatabase({ url: SWEEP_URL, applicationName: 'taskflow-wave2-test-sweep' });
});

beforeEach(async () => {
  await clearAll();
});

afterAll(async () => {
  await clearTenant();
  await closeDatabase();
  await admin.end();
});

async function countNotifications(kind: string, subjectId: string = CARD): Promise<number> {
  return withAuditScope(async (tx) => {
    const rows = await tx
      .select({ id: schema.notifications.id })
      .from(schema.notifications)
      .where(
        and(
          eq(schema.notifications.orgId, ORG),
          eq(schema.notifications.kind, kind),
          eq(schema.notifications.subjectId, subjectId),
        ),
      );
    return rows.length;
  });
}

describe('the due-reminder sweep (§3.8)', () => {
  it('writes one reminder for a card due within the horizon', async () => {
    await seedCard(2);
    const result = await runDueReminderSweep(new Date(), 24);

    expect(result.written).toBe(1);
    expect(await countNotifications('card.due_soon')).toBe(1);
  });

  it('is idempotent — a second pass over the same card writes nothing', async () => {
    await seedCard(2);
    await runDueReminderSweep(new Date(), 24);
    const second = await runDueReminderSweep(new Date(), 24);

    /* The whole point of the unique index: an hourly sweep against a still-due
       card must not ring the bell again. */
    expect(second.written).toBe(0);
    expect(await countNotifications('card.due_soon')).toBe(1);
  });

  it('ignores a card due beyond the horizon', async () => {
    await seedCard(48);
    const result = await runDueReminderSweep(new Date(), 24);

    expect(result.written).toBe(0);
    expect(await countNotifications('card.due_soon')).toBe(0);
  });

  it('writes an email delivery row the digest can later collect, when activity/email is on', async () => {
    await seedCard(2);
    await seedPrefs(true);
    const result = await runDueReminderSweep(new Date(), 24);

    expect(result.written).toBe(1);

    /* The delivery decision at write time (§3.2): card.due_soon is an
       `activity` kind, so its email is DIGEST, sitting pending for the daily
       sweep rather than being sent immediately. */
    const rows = await withAuditScope(async (tx) =>
      tx
        .select({ channel: schema.notificationDeliveries.channel })
        .from(schema.notificationDeliveries)
        .where(eq(schema.notificationDeliveries.orgId, ORG)),
    );
    expect(rows).toEqual([{ channel: 'email' }]);
  });

  it('writes no email delivery when activity/email is off', async () => {
    await seedCard(2);
    const result = await runDueReminderSweep(new Date(), 24);

    expect(result.written).toBe(1);
    /* Scoped to OUR org: taskflow_audit's policy is `USING true`, so an
       unscoped read would surface other suites' rows (turbo runs packages in
       parallel against one taskflow_test — the exact trap relay.test.ts's
       `ours()` documents). */
    const rows = await withAuditScope(async (tx) =>
      tx
        .select({ channel: schema.notificationDeliveries.channel })
        .from(schema.notificationDeliveries)
        .where(eq(schema.notificationDeliveries.orgId, ORG)),
    );
    expect(rows).toEqual([]);
  });

  it('re-fires after a due-date edit clears the fired reminder', async () => {
    /* The one gap the unique index does not close: the reminder already fired
       for a date that was then pushed out. The projection deletes the old row
       on `card.updated` with a changed dueDate, and the next sweep pass
       re-inserts against the new date — the exact flow §3.8 describes. */
    await seedCard(2);
    await runDueReminderSweep(new Date(), 24);
    expect(await countNotifications('card.due_soon')).toBe(1);

    /* An outbox `card.updated` row whose due date moved, exactly as
       work/events.ts emits it. Drained through the real projection so the
       DELETE runs as taskflow_audit with the 0029 grant that makes it work. */
    await admin.setOrg(ORG);
    await admin.query(
      `INSERT INTO platform.outbox
         (id, org_id, name, version, occurred_at, payload)
       VALUES (gen_random_uuid(), $1, 'card.updated', 1, now(), $2::jsonb)`,
      [
        ORG,
        JSON.stringify({
          cardId: CARD,
          changed: ['dueDate'],
          before: { dueDate: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString() },
          after: { dueDate: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString() },
        }),
      ],
    );
    await admin.setOrg(null);

    const drained = await drainNotificationsFully();
    expect(drained.written).toBe(0);
    expect(await countNotifications('card.due_soon')).toBe(0);

    /* The date is still inside the horizon, so the next pass re-fires. */
    const refired = await runDueReminderSweep(new Date(), 24);
    expect(refired.written).toBe(1);
    expect(await countNotifications('card.due_soon')).toBe(1);
  });
});

describe('the digest sweep (§3.4)', () => {
  it('collects pending activity email rows grouped per recipient, oldest first', async () => {
    await seedCard(2);
    await seedPrefs(true);
    await runDueReminderSweep(new Date(), 24);

    const batches = await collectDigestBatches();
    expect(batches).toHaveLength(1);
    expect(batches[0]?.to).toBe('sweep@wave2.test');
    expect(batches[0]?.items[0]?.title).toContain('Due soon');
    expect(batches[0]?.deliveryIds).toHaveLength(1);
  });

  it('marks a batch sent, and a second collection does not re-collect it', async () => {
    await seedCard(2);
    await seedPrefs(true);
    await runDueReminderSweep(new Date(), 24);

    const first = await collectDigestBatches();
    expect(first).toHaveLength(1);
    await markDigestSent(first[0]!.deliveryIds);

    const second = await collectDigestBatches();
    expect(second).toHaveLength(0);
  });

  it('never collects a DIRECT kind — a mention is not digest material', async () => {
    /* The filter that keeps a @mention from sitting in tomorrow's digest. A
       direct-email row pending because the mailer was briefly down must be
       retried by the relay, never swept. */
    await admin.setOrg(ORG);
    await admin.query(
      `INSERT INTO platform.notifications
         (id, org_id, user_id, kind, subject_type, subject_id, title)
       VALUES (gen_random_uuid(), $1, $2, 'chat.direct', 'message',
               '0195ee10-0000-7000-8000-0000000000ff', 'New direct message')`,
      [ORG, USER],
    );
    await admin.query(
      `INSERT INTO platform.notification_deliveries
         (id, org_id, user_id, notification_id, channel, status)
       SELECT gen_random_uuid(), n.org_id, n.user_id, n.id, 'email', 'pending'
       FROM platform.notifications n
       WHERE n.org_id = $1 AND n.kind = 'chat.direct'`,
      [ORG],
    );
    await admin.setOrg(null);

    const batches = await collectDigestBatches();
    expect(batches).toHaveLength(0);
  });
});

/** A silent logger — these tests assert on return values, not log lines. */
const SILENT_LOGGER: Logger = createLogger({ name: 'wave2-sweep-test', level: 'silent' });

/** A provider that must never be reached — every push in this block is filtered before it would send. */
const UNREACHABLE_PUSH_PROVIDER: PushProvider = {
  send: () => {
    throw new Error('push provider reached — the org-suspended filter did not exclude this row');
  },
};

async function setOrgStatus(status: 'active' | 'suspended'): Promise<void> {
  await admin.setOrg(ORG);
  await admin.query(`UPDATE identity.orgs SET status = $1 WHERE id = $2`, [status, ORG]);
  await admin.setOrg(null);
}

describe('Phase 12 §3.9 — a suspended org stops reaching its members', () => {
  it('the due-reminder sweep writes nothing at all for a suspended org', async () => {
    await seedCard(2);
    await setOrgStatus('suspended');

    const result = await runDueReminderSweep(new Date(), 24);

    expect(result.written).toBe(0);
    expect(await countNotifications('card.due_soon')).toBe(0);

    /* Reactivating does not backfill what the sweep never wrote — the next
       ordinary pass just sees the card as newly due, exactly as it would for
       a card created after reactivation. */
    await setOrgStatus('active');
    const refired = await runDueReminderSweep(new Date(), 24);
    expect(refired.written).toBe(1);
  });

  it('the digest sweep skips a pending row while suspended, and collects it once reactivated', async () => {
    await seedCard(2);
    await seedPrefs(true);
    await runDueReminderSweep(new Date(), 24);

    await setOrgStatus('suspended');
    expect(await collectDigestBatches()).toHaveLength(0);

    await setOrgStatus('active');
    const batches = await collectDigestBatches();
    expect(batches).toHaveLength(1);
  });

  it('the push relay skips a pending row while suspended, and picks it up once reactivated', async () => {
    /* No subscription is seeded — deliverPendingPushes would mark an
       unreachable row `failed` on its own "no device registered" path, and
       that write is the tell: if the org-suspended filter did not exclude
       this row, it would flip to `failed` during suspension instead of
       staying `pending`. */
    await admin.setOrg(ORG);
    const notificationId = '0195ee10-0000-7000-8000-0000000000fe';
    const deliveryId = '0195ee10-0000-7000-8000-0000000000fd';
    await admin.query(
      `INSERT INTO platform.notifications
         (id, org_id, user_id, kind, subject_type, subject_id, title)
       VALUES ($1, $2, $3, 'card.assigned', 'card', $4, 'You were assigned a card')`,
      [notificationId, ORG, USER, CARD],
    );
    await admin.query(
      `INSERT INTO platform.notification_deliveries
         (id, org_id, user_id, notification_id, channel, status)
       VALUES ($1, $2, $3, $4, 'push', 'pending')`,
      [deliveryId, ORG, USER, notificationId],
    );
    await admin.setOrg(null);

    async function statusOf(): Promise<string> {
      const rows = await withAuditScope(async (tx) =>
        tx
          .select({ status: schema.notificationDeliveries.status })
          .from(schema.notificationDeliveries)
          .where(eq(schema.notificationDeliveries.id, deliveryId)),
      );
      return rows[0]?.status ?? 'missing';
    }

    await setOrgStatus('suspended');
    const whileSuspended = await deliverPendingPushes(UNREACHABLE_PUSH_PROVIDER, SILENT_LOGGER);
    expect(whileSuspended.attempted).toBe(0);
    expect(await statusOf()).toBe('pending');

    await setOrgStatus('active');
    const afterReactivation = await deliverPendingPushes(UNREACHABLE_PUSH_PROVIDER, SILENT_LOGGER);
    /* No subscription exists, so the row is picked up and marked `failed` —
       the "no device registered" path, not the "org excluded" path. That
       transition IS the proof: the row was reachable once the org went
       active again. */
    expect(afterReactivation.attempted).toBe(0);
    expect(await statusOf()).toBe('failed');
  });

  it('the notification projection writes the in-app bell but skips email/push delivery for a suspended org', async () => {
    await admin.setOrg(ORG);
    await admin.query(`SELECT set_config('app.user_id', $1, false)`, [OTHER]);
    await admin.query(
      `INSERT INTO identity.notification_prefs (user_id, category, channel, enabled)
       VALUES ($1, 'activity', 'email', true), ($1, 'activity', 'push', true)
       ON CONFLICT (user_id, category, channel) DO UPDATE SET enabled = EXCLUDED.enabled`,
      [OTHER],
    );
    await admin.query(`SELECT set_config('app.user_id', '', false)`);

    await setOrgStatus('suspended');

    await admin.setOrg(ORG);
    await admin.query(
      `INSERT INTO platform.outbox
         (id, org_id, name, version, occurred_at, payload, actor_id)
       VALUES (gen_random_uuid(), $1, 'card.assigned', 1, now(), $2::jsonb, $3)`,
      [ORG, JSON.stringify({ cardId: CARD, boardId: BOARD, before: [], after: [OTHER] }), USER],
    );
    await admin.setOrg(null);

    const drained = await drainNotificationsFully();
    expect(drained.written).toBe(1);
    expect(await countNotifications('card.assigned')).toBe(1);

    /* The in-app bell is unaffected — only outbound reach stops. */
    const deliveries = await withAuditScope(async (tx) =>
      tx
        .select({ channel: schema.notificationDeliveries.channel })
        .from(schema.notificationDeliveries)
        .where(
          and(
            eq(schema.notificationDeliveries.orgId, ORG),
            eq(schema.notificationDeliveries.userId, OTHER),
          ),
        ),
    );
    expect(deliveries).toEqual([]);
  });
});
