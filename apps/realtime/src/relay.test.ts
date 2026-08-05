import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  appendToOutbox,
  claimPending,
  closeDatabase,
  initializeAuditDatabase,
  initializeDatabase,
  initializeRealtimeDatabase,
  listenForOutboxAppends,
  withAuditScope,
  withOrgScope,
  withRealtimeScope,
  type OrgId,
  type OutboxListener,
  type OutboxRow,
} from '@taskflow/db';
import { connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import { createLogger } from '@taskflow/observability';
import type { DomainEvent } from '@taskflow/events';
import { CONSUMER, startRealtimeRelay } from './relay.js';

/**
 * The realtime relay against real Postgres (ai/phase-4-realtime.md §3.5, §7.3,
 * §6.4).
 *
 * §6.4: "a fan-out test proving two consumers draining outbox_dispatch do not
 * starve each other — which packages/db/src/audit.test.ts already has for
 * 'audit' vs 'realtime' as a stand-in consumer name; extend it to prove the
 * REAL realtime consumer that Wave 1 adds behaves the same way against a live
 * gateway, not just the table." This suite drives that consumer through
 * `startRealtimeRelay` — the actual module `apps/realtime/src/main.ts` runs —
 * rather than calling `claimPending(tx, 'realtime')` directly, so a bug in the
 * relay's own claim/dispatch/mark wiring would show up here even though the
 * underlying table-level property is already proven elsewhere.
 */

const APP_URL =
  process.env['TEST_DATABASE_URL'] ??
  'postgresql://taskflow_app:app-dev-secret@localhost:5433/taskflow_test';
const AUDIT_URL =
  process.env['TEST_DATABASE_AUDIT_URL'] ??
  'postgresql://taskflow_audit:audit-dev-secret@localhost:5433/taskflow_test';
const REALTIME_URL =
  process.env['TEST_DATABASE_REALTIME_URL'] ??
  'postgresql://taskflow_realtime:realtime-dev-secret@localhost:5433/taskflow_test';
const MIGRATION_URL =
  process.env['TEST_DATABASE_MIGRATION_URL'] ??
  'postgresql://taskflow_migrator:migrator-dev-secret@localhost:5433/taskflow_test';

const ORG = '0195ff00-0000-7000-8000-0000000000c1' as OrgId;
const ACTOR = '0195ff00-0000-7000-8000-0000000000c2';

const logger = createLogger({ name: 'relay-test', level: 'silent' });

let idCounter = 0;
function eventFor(name = 'card.moved'): DomainEvent {
  idCounter += 1;
  const suffix = String(idCounter).padStart(12, '0');
  return {
    id: `0195ff00-0000-7000-8000-${suffix}`,
    name,
    version: 1,
    orgId: ORG,
    actorId: ACTOR,
    occurredAt: new Date().toISOString(),
    requestId: 'req-relay-test',
    payload: { boardId: 'board-relay-test' },
  } as DomainEvent;
}

let admin: AdminConnection;

async function clearOutbox(): Promise<void> {
  // A method call on the migrator's test connection, not a raw `sql` tag —
  // guardrail 2's ban on raw SQL outside packages/db applies to feature code
  // and, correctly, to this test file too; @taskflow/db/testing exists so
  // fixtures can reach across orgs without reimporting `pg` (see its own
  // header comment).
  //
  // Scoped to THIS suite's org, deliberately. Emptying the whole table would
  // make this file delete fixtures belonging to suites it knows nothing about —
  // the same hazard apps/api/vitest.config.ts's note describes. The cost is
  // that assertions here must not read GLOBAL queue state; see `ours()` below.
  await admin.setOrg(ORG);
  await admin.query(`DELETE FROM platform.outbox WHERE org_id = $1`, [ORG]);
  await admin.setOrg(null);
}

/**
 * Narrows a claim to the events THIS suite wrote.
 *
 * The outbox is one global queue by design — a consumer drains every org (§3.5)
 * — so `claimPending` legitimately returns other suites' rows when the test
 * database has any. `apps/api`'s tests leave `org.created` / `project.created`
 * events behind that nothing dispatches to 'audit', and an assertion like
 * `expect(forAudit).toHaveLength(1)` then fails with `expected 3 to be 1`,
 * which reads as a batching bug in the relay rather than as a dirty fixture.
 *
 * Filtering by org keeps the property each test is actually about — "MY event
 * was drained", "MY event is still owed to audit" — without either emptying a
 * table this suite does not own or depending on the order suites happen to run
 * in.
 */
function ours(rows: readonly OutboxRow[]): readonly OutboxRow[] {
  return rows.filter((row) => row.orgId === ORG);
}

beforeAll(async () => {
  admin = await connectAsMigrator({ url: MIGRATION_URL });

  // `platform.outbox` FKs to `identity.orgs` AND `identity.users` (actor_id)
  // — both need real rows before any event can be written, same as
  // audit.test.ts's fixture.
  await admin.setOrg(null);
  await admin.query(`DELETE FROM identity.users WHERE id = $1`, [ACTOR]);
  await admin.query(
    `INSERT INTO identity.users (id, email, email_normalized, email_verified_at)
     VALUES ($1, 'relay-test-actor@example.test', 'relay-test-actor@example.test', now())`,
    [ACTOR],
  );

  await admin.setOrg(ORG);
  await admin.query(`DELETE FROM identity.orgs WHERE id = $1`, [ORG]);
  await admin.query(`INSERT INTO identity.orgs (id, name, slug) VALUES ($1, $2, $3)`, [
    ORG,
    'Relay Test Org',
    'relay-test-org',
  ]);
  await admin.setOrg(null);

  initializeDatabase({ url: APP_URL, applicationName: 'taskflow-relay-test-app' });
  initializeAuditDatabase({ url: AUDIT_URL, applicationName: 'taskflow-relay-test-audit' });
  initializeRealtimeDatabase({ url: REALTIME_URL, applicationName: 'taskflow-relay-test' });
});

afterEach(async () => {
  await clearOutbox();
});

afterAll(async () => {
  await closeDatabase();
  await admin.setOrg(ORG);
  await admin.query(`DELETE FROM identity.orgs WHERE id = $1`, [ORG]);
  await admin.setOrg(null);
  await admin.query(`DELETE FROM identity.users WHERE id = $1`, [ACTOR]);
  await admin.end();
});

describe('startRealtimeRelay', () => {
  it('drains a pending event through the real "realtime" consumer name', async () => {
    await withOrgScope(ORG, async (tx) => appendToOutbox(tx, [eventFor()]));

    const dispatch = vi.fn((_row: OutboxRow) => undefined);
    const relay = startRealtimeRelay({ logger, dispatch, pollIntervalMs: 300_000 });

    /** This suite's own dispatched rows — see `ours()`. */
    const delivered = (): readonly OutboxRow[] => ours(dispatch.mock.calls.map(([row]) => row));

    try {
      await relay.drainNow();

      expect(delivered()).toHaveLength(1);
      expect(delivered()[0]).toMatchObject({
        orgId: ORG,
        name: 'card.moved',
        payload: { boardId: 'board-relay-test' },
      });

      // Not redelivered on a second drain — CONSUMER's own dispatch row is
      // now marked, and this is the exact property migration 0015 exists for:
      // a single published_at would have made this event invisible to every
      // consumer the instant ANY of them marked it, not just this one.
      await relay.drainNow();
      expect(delivered()).toHaveLength(1);
    } finally {
      await relay.stop();
    }
  });

  it('does not consume the "audit" relay’s backlog, and vice versa', async () => {
    await withOrgScope(ORG, async (tx) => appendToOutbox(tx, [eventFor()]));

    const dispatch = vi.fn((_row: OutboxRow) => undefined);
    const relay = startRealtimeRelay({ logger, dispatch, pollIntervalMs: 300_000 });

    try {
      await relay.drainNow();
      expect(ours(dispatch.mock.calls.map(([row]) => row))).toHaveLength(1);

      // 'realtime' marking this event dispatched must not hide it from
      // 'audit' — the CONSUMER export is asserted to be the literal string
      // migration 0016's WITH CHECK pins, so this is the real name, not a
      // stand-in.
      expect(CONSUMER).toBe('realtime');
      const forAudit = await withAuditScope(async (tx) => claimPending(tx, 'audit'));
      expect(ours(forAudit)).toHaveLength(1);
    } finally {
      await relay.stop();
    }
  });

  it('leaves a failing event claimable and counts the attempt, without abandoning the rest of the batch', async () => {
    await withOrgScope(ORG, async (tx) =>
      appendToOutbox(tx, [eventFor('card.moved'), eventFor('card.created')]),
    );

    let calls = 0;
    const dispatch = vi.fn((row: OutboxRow) => {
      calls += 1;
      if (row.name === 'card.moved') throw new Error('dispatch exploded');
    });

    const relay = startRealtimeRelay({ logger, dispatch, pollIntervalMs: 300_000 });

    try {
      const delivered = await relay.drainNow();

      // Both were attempted; only the non-throwing one counts as delivered.
      expect(calls).toBe(2);
      expect(delivered).toBe(1);

      const retry = await withRealtimeScope((tx) => claimPending(tx, CONSUMER));
      expect(retry).toHaveLength(1);
      expect(retry[0]?.name).toBe('card.moved');
      expect(retry[0]?.attempts).toBe(1);
    } finally {
      await relay.stop();
    }
  });
});

describe('LISTEN/NOTIFY wake-up (§7.3)', () => {
  it('an outbox append notifies a live listener', async () => {
    let resolveAppend: (() => void) | undefined;
    const appended = new Promise<void>((resolve) => {
      resolveAppend = resolve;
    });

    const listener: OutboxListener = await listenForOutboxAppends({
      onAppend: () => resolveAppend?.(),
    });

    try {
      await withOrgScope(ORG, async (tx) => appendToOutbox(tx, [eventFor()]));

      // The trigger fires AFTER INSERT, on commit — real network round trip
      // to Postgres and back, so this needs a real (short) timeout rather
      // than asserting synchronously.
      await Promise.race([
        appended,
        new Promise((_resolve, reject) => {
          setTimeout(() => {
            reject(new Error('no notification within 2s'));
          }, 2_000);
        }),
      ]);
    } finally {
      await listener.stop();
    }
  });
});
