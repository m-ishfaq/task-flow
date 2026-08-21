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
import { createLogger } from '@taskflow/observability';
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

/* deliverPendingPushes requires a logger; silent keeps a passing run quiet. */
const silentLogger = createLogger({ name: 'wave2-sweep-test', level: 'silent' });

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

/* A second, SUSPENDED tenant (Phase 12 Wave 1 §3.9). Seeded once in
   beforeAll like the base tenant; the §3.9 tests assert that every one of
   the four delivery paths refuses its rows. */
const SUSPENDED: OrgId = unsafeAsId('0195ee10-0000-7000-8000-00000000001a');
const SUSPENDED_USER: UserId = unsafeAsId('0195ee10-0000-7000-8000-000000000003');
const SUSPENDED_PROJECT = '0195ee10-0000-7000-8000-00000000001b';
const SUSPENDED_BOARD = '0195ee10-0000-7000-8000-00000000001c';
const SUSPENDED_LIST = '0195ee10-0000-7000-8000-00000000001d';
const SUSPENDED_CARD = '0195ee10-0000-7000-8000-00000000001e';

let admin: AdminConnection;

/* Removes every TEST-SPECIFIC row, leaving the base tenant (users, org,
   project, board, list seeded in `beforeAll`) standing — cards, deliveries
   and notifications are what each test seeds and tears down. */
async function clearAll(): Promise<void> {
  /* Deliveries explicitly, not just via the notifications cascade: a failed
     earlier run can leave orphans a cascade from a now-gone notification row
     cannot reach. Both test tenants — the base ORG and the suspended one
     (§3.9) — are cleared the same way.

     Each tenant is cleared under its OWN setOrg, one at a time. Every table
     below is RLS-scoped on app.org_id and the migrator does not bypass it
     (FORCE ROW LEVEL SECURITY), so a single `org_id = ANY(both)` delete run
     while app.org_id holds ORG clears ORG's rows and silently matches ZERO
     of the suspended tenant's — no error, just a delete that names rows the
     policy hides. The suspended tenant then leaks into the next test. */
  for (const orgId of [ORG, SUSPENDED]) {
    await admin.setOrg(orgId);
    await admin.query(`DELETE FROM platform.notification_deliveries WHERE org_id = $1`, [orgId]);
    await admin.query(`DELETE FROM platform.notifications WHERE org_id = $1`, [orgId]);
    await admin.query(`DELETE FROM platform.outbox WHERE org_id = $1`, [orgId]);
    await admin.query(`DELETE FROM work.cards WHERE org_id = $1`, [orgId]);
  }
  await admin.setOrg(ORG);
  /* Prefs have no DELETE policy (0027 grants SELECT/INSERT/UPDATE only), so a
     delete would silently match zero rows and LEAK the previous test's rows
     into the next — the delivery rows prove the leak. Disable instead: the
     `self_update` policy keys on app.user_id, so declare whose row is being
     amended, exactly as a real request would. */
  for (const userId of [USER, OTHER]) {
    await admin.query(`SELECT set_config('app.user_id', $1, false)`, [userId]);
    await admin.query(
      `UPDATE identity.notification_prefs SET enabled = false
       WHERE user_id = $1 AND (category, channel) = ('activity', 'email')`,
      [userId],
    );
  }
  await admin.query(`SELECT set_config('app.user_id', '', false)`);
  await admin.setOrg(null);
}

/* Removes the base tenant itself. Only for afterAll — beforeAll seeds it. */
async function clearTenant(): Promise<void> {
  /* One tenant at a time, under its own setOrg — see clearAll's comment: a
     delete naming both orgs only ever reaches the one app.org_id names, and
     `identity.orgs`' own policy keys on `id`, so the suspended org ROW
     survived every teardown. beforeAll then re-seeded it and Postgres
     answered `duplicate key value violates unique constraint "orgs_pkey"` —
     on the second run of the suite, never the first. */
  for (const orgId of [ORG, SUSPENDED]) {
    await admin.setOrg(orgId);
    await admin.query(`DELETE FROM platform.notification_deliveries WHERE org_id = $1`, [orgId]);
    await admin.query(`DELETE FROM platform.notifications WHERE org_id = $1`, [orgId]);
    await admin.query(`DELETE FROM platform.outbox WHERE org_id = $1`, [orgId]);
    await admin.query(`DELETE FROM work.cards WHERE org_id = $1`, [orgId]);
    await admin.query(`DELETE FROM work.lists WHERE org_id = $1`, [orgId]);
    await admin.query(`DELETE FROM work.boards WHERE org_id = $1`, [orgId]);
    await admin.query(`DELETE FROM work.projects WHERE org_id = $1`, [orgId]);
    await admin.query(`DELETE FROM identity.memberships WHERE org_id = $1`, [orgId]);
    await admin.query(`DELETE FROM identity.orgs WHERE id = $1`, [orgId]);
  }
  /* Users and prefs are not org-scoped — one pass, outside the loop. */
  await admin.setOrg(ORG);
  await admin.query(`DELETE FROM identity.notification_prefs WHERE user_id = ANY($1::uuid[])`, [
    [USER, OTHER, SUSPENDED_USER],
  ]);
  await admin.query(`DELETE FROM identity.users WHERE id = ANY($1::uuid[])`, [
    [USER, OTHER, SUSPENDED_USER],
  ]);
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

/** A due card in the SUSPENDED tenant — the §3.9 org filter must refuse it. */
async function seedSuspendedCard(dueInHours: number): Promise<void> {
  await admin.setOrg(SUSPENDED);
  await admin.query(
    `INSERT INTO work.cards
       (id, org_id, project_id, board_id, list_id, number, title, rank, assignee_ids, due_date)
     VALUES ($1, $2, $3, $4, $5, 1, 'Suspended Card', 'a0', $6, now() + ($7 || ' hours')::interval)`,
    [
      SUSPENDED_CARD,
      SUSPENDED,
      SUSPENDED_PROJECT,
      SUSPENDED_BOARD,
      SUSPENDED_LIST,
      [SUSPENDED_USER],
      String(dueInHours),
    ],
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
    [SUSPENDED_USER, 'suspended@wave2.test'],
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

  /* The suspended tenant (§3.9) — same hierarchy shape as the base one,
     with status = 'suspended' on the org row. Every §3.9 test asserts one of
     the four delivery paths refuses this tenant's rows. orgs RLS keys on
     app.org_id (0004) and the migrator does NOT bypass it — the insert must
     run under setOrg(SUSPENDED), exactly like the base org's own insert
     above runs under setOrg(ORG). */
  await admin.setOrg(SUSPENDED);
  await admin.query(
    `INSERT INTO identity.orgs (id, name, slug, status)
     VALUES ($1, 'Wave2 Suspended', 'wave2-suspended', 'suspended')`,
    [SUSPENDED],
  );
  await admin.query(
    `INSERT INTO identity.memberships (id, org_id, user_id, role)
     VALUES (gen_random_uuid(), $1, $2, 'member')`,
    [SUSPENDED, SUSPENDED_USER],
  );
  await admin.query(
    `INSERT INTO work.projects (id, org_id, name, key) VALUES ($1, $2, 'Wave2 Suspended', 'WS')`,
    [SUSPENDED_PROJECT, SUSPENDED],
  );
  await admin.query(
    `INSERT INTO work.boards (id, org_id, project_id, name, rank)
     VALUES ($1, $2, $3, 'Suspended Board', 'a0')`,
    [SUSPENDED_BOARD, SUSPENDED, SUSPENDED_PROJECT],
  );
  await admin.query(
    `INSERT INTO work.lists (id, org_id, project_id, board_id, name, rank)
     VALUES ($1, $2, $3, $4, 'Suspended List', 'a0')`,
    [SUSPENDED_LIST, SUSPENDED, SUSPENDED_PROJECT, SUSPENDED_BOARD],
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

async function countNotifications(
  kind: string,
  subjectId: string = CARD,
  orgId: OrgId = ORG,
): Promise<number> {
  return withAuditScope(async (tx) => {
    const rows = await tx
      .select({ id: schema.notifications.id })
      .from(schema.notifications)
      .where(
        and(
          eq(schema.notifications.orgId, orgId),
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

describe('the §3.9 org-status filter (ai/phase-12-admin.md)', () => {
  it('does not remind for a card in a suspended org', async () => {
    await seedSuspendedCard(2);
    const result = await runDueReminderSweep(new Date(), 24);

    /* The org join refuses the card before the insert loop ever sees it —
       and therefore neither a notification nor the delivery rows that would
       have followed. */
    expect(result.written).toBe(0);
    expect(await countNotifications('card.due_soon', SUSPENDED_CARD, SUSPENDED)).toBe(0);
  });

  it("does not collect a suspended org's pending activity email into the digest", async () => {
    /* A delivery decided (and written) BEFORE the org was suspended must not
       ride the next digest while it is suspended — the row stays pending,
       and reactivation resumes it. */
    await admin.setOrg(SUSPENDED);
    await admin.query(
      `INSERT INTO platform.notifications
         (id, org_id, user_id, kind, subject_type, subject_id, title)
       VALUES (gen_random_uuid(), $1, $2, 'card.due_soon', 'card',
               '0195ee10-0000-7000-8000-0000000000ee', 'Due soon: Suspended Card')`,
      [SUSPENDED, SUSPENDED_USER],
    );
    await admin.query(
      `INSERT INTO platform.notification_deliveries
         (id, org_id, user_id, notification_id, channel, status)
       SELECT gen_random_uuid(), n.org_id, n.user_id, n.id, 'email', 'pending'
       FROM platform.notifications n
       WHERE n.org_id = $1 AND n.kind = 'card.due_soon'`,
      [SUSPENDED],
    );
    await admin.setOrg(null);

    const batches = await collectDigestBatches();
    expect(batches.every((batch) => batch.to !== 'suspended@wave2.test')).toBe(true);
  });

  it("does not send a suspended org's pending push", async () => {
    /* The provider is a fake that RECORDS every call — a push sent despite
       the filter would fail the assertion, the same prove-the-side-effect
       discipline the spend-gate suite applies to the carrier. */
    let calls = 0;
    const provider: PushProvider = {
      /* Not `async` — the method never awaits, and `require-await` flags a
         fake whose body is synchronous. `Promise.resolve` keeps the return
         type the interface declares. */
      send: () => {
        calls += 1;
        return Promise.resolve('sent');
      },
    };

    await admin.setOrg(SUSPENDED);
    await admin.query(
      `INSERT INTO platform.notifications
         (id, org_id, user_id, kind, subject_type, subject_id, title)
       VALUES (gen_random_uuid(), $1, $2, 'chat.direct', 'message',
               '0195ee10-0000-7000-8000-0000000000dd', 'New direct message')`,
      [SUSPENDED, SUSPENDED_USER],
    );
    await admin.query(
      `INSERT INTO platform.notification_deliveries
         (id, org_id, user_id, notification_id, channel, status)
       SELECT gen_random_uuid(), n.org_id, n.user_id, n.id, 'push', 'pending'
       FROM platform.notifications n
       WHERE n.org_id = $1 AND n.kind = 'chat.direct'`,
      [SUSPENDED],
    );
    await admin.setOrg(null);

    await deliverPendingPushes({ web: provider }, silentLogger);
    expect(calls).toBe(0);
  });

  it("creates no notification for a suspended org's event", async () => {
    /* The projection runs on the relay tick, not at request time — but a
       suspended org's event is consumed (dispatched) and produces nothing:
       no in-app row, no delivery. */
    await admin.setOrg(SUSPENDED);
    await admin.query(
      `INSERT INTO platform.outbox
         (id, org_id, name, version, occurred_at, payload)
       VALUES (gen_random_uuid(), $1, 'card.assigned', 1, now(), $2::jsonb)`,
      [
        SUSPENDED,
        JSON.stringify({
          cardId: SUSPENDED_CARD,
          boardId: SUSPENDED_BOARD,
          before: [],
          after: [SUSPENDED_USER],
        }),
      ],
    );
    await admin.setOrg(null);

    const drained = await drainNotificationsFully();
    expect(drained.written).toBe(0);
    expect(await countNotifications('card.assigned', SUSPENDED_CARD, SUSPENDED)).toBe(0);
  });
});
