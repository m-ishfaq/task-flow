import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { unsafeAsId } from '@taskflow/contracts';
import {
  closeDatabase,
  initializeDatabase,
  initializeOpsEventsDatabase,
  initializePlatformAdminDatabase,
  recordOperationalEvent,
} from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import { TEST_ENV } from '../testing/fixtures.js';
import { readOperatorAudit } from './audit.js';
import { listOperationalEvents } from './operations.js';
import type { PlatformOperator } from './org-directory.service.js';

/**
 * The operations dashboard (§14–§21 of this session's work), against real
 * Postgres.
 *
 * Two properties a type check cannot see, the same class of gap §6 of the
 * platform-admin suite names for the org directory:
 *
 *   - `recordOperationalEvent` writes through `taskflow_ops_events`, and
 *     `listOperationalEvents` reads the SAME row back through
 *     `taskflow_platform_admin` — a different role. Getting either role's
 *     grant wrong (migration 0061) fails here, not in a type check.
 *   - `recordOperationalEvent` NEVER throws into its caller, even when the
 *     underlying write genuinely fails — its own header's whole reason for
 *     existing. Asserted against a REAL write failure (an unserializable
 *     jsonb payload), not a mock, because only a real driver error proves
 *     the try/catch actually wraps something.
 */

const PLATFORM_ADMIN_URL =
  process.env['TEST_DATABASE_PLATFORM_ADMIN_URL'] ??
  'postgresql://taskflow_platform_admin:platform-admin-dev-secret@localhost:5433/taskflow_test';

const OPS_EVENTS_URL =
  process.env['TEST_DATABASE_OPS_EVENTS_URL'] ??
  'postgresql://taskflow_ops_events:ops-events-dev-secret@localhost:5433/taskflow_test';

const OPERATOR = unsafeAsId<'UserId'>('0195dd00-0000-7000-8000-0000000000b1');
const requestId = unsafeAsId<'RequestId'>('0195dd00-0000-7000-8000-0000000000ff');
const operator: PlatformOperator = { userId: OPERATOR, requestId };

let admin: AdminConnection;

beforeAll(async () => {
  await applyMigrations();
  admin = await connectAsMigrator();

  initializeDatabase({ url: TEST_ENV.DATABASE_URL, applicationName: 'taskflow-operations-svc' });
  initializeOpsEventsDatabase({
    url: OPS_EVENTS_URL,
    applicationName: 'taskflow-operations-ops-events',
  });
  initializePlatformAdminDatabase({
    url: PLATFORM_ADMIN_URL,
    applicationName: 'taskflow-operations-platform-admin',
  });

  await admin.setOrg(null);
  /* Children before parents (the `clearTenant` discipline): the sibling
     branding suite leaves BOTH the global operator chain and the branding
     singleton's `updated_by` pointing at the same OPERATOR id — deleting the
     user first would trip their foreign keys and skip this whole file. The
     operator chain is global and shared, so it is reset here rather than
     assumed clean. */
  await admin.query(`DELETE FROM platform.operational_events`);
  await admin.query(`DELETE FROM platform.operator_audit_log`);
  await admin.query(`UPDATE platform.branding SET updated_by = NULL WHERE id = true`);
  await admin.query(`DELETE FROM identity.users WHERE id = $1`, [OPERATOR]);
  await admin.query(
    `INSERT INTO identity.users (id, email, email_normalized, email_verified_at)
     VALUES ($1, $2, $2, now())`,
    [OPERATOR, 'operations-operator@platform.test'],
  );
});

/* Reset before each test, not after — a failing test leaves its rows to
   inspect, the same convention platform-admin.service.test.ts uses. The
   operator chain is global, so it is reset alongside the table under test. */
beforeEach(async () => {
  await admin.setOrg(null);
  await admin.query(`DELETE FROM platform.operational_events`);
  await admin.query(`DELETE FROM platform.operator_audit_log`);
  await admin.query(
    `UPDATE platform.operator_chain_head SET seq = 0, hash = '\\x'::bytea WHERE id = true`,
  );
});

afterAll(async () => {
  await admin.setOrg(null);
  /* Same children-before-parents order as beforeAll: the branding singleton
     can still point at OPERATOR (a mid-chain run leaves it set), and the
     next suite's beforeAll deletes this user. */
  await admin.query(`DELETE FROM platform.operational_events`);
  await admin.query(`DELETE FROM platform.operator_audit_log`);
  await admin.query(`UPDATE platform.branding SET updated_by = NULL WHERE id = true`);
  await admin.query(`DELETE FROM identity.users WHERE id = $1`, [OPERATOR]);
  await admin.end();
  await closeDatabase();
});

describe('recordOperationalEvent', () => {
  it('writes through taskflow_ops_events, readable back through taskflow_platform_admin', async () => {
    await recordOperationalEvent({
      kind: 'mail',
      outcome: 'success',
      target: 'someone@example.com',
      detail: { subject: 'Verify your email' },
    });

    const result = await listOperationalEvents(operator, { cursor: null, limit: 10, kind: null });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.kind).toBe('mail');
    expect(result.events[0]?.outcome).toBe('success');
    expect(result.events[0]?.target).toBe('someone@example.com');
    expect(result.events[0]?.detail).toEqual({ subject: 'Verify your email' });
  });

  it('never throws into its caller, even on a real write failure', async () => {
    /* A circular object cannot be JSON-serialized — node-postgres's own
       parameter encoding throws on it, which is a REAL driver-level failure,
       not a simulated one. recordOperationalEvent's whole reason for
       existing is that this must surface through onWriteFailure, never as
       a rejected promise. */
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;

    let caught: unknown;
    await expect(
      recordOperationalEvent({ kind: 'mail', outcome: 'failure', detail: circular }, (error) => {
        caught = error;
      }),
    ).resolves.toBeUndefined();

    expect(caught).toBeDefined();

    // And no row was written — the failed write left no trace.
    const result = await listOperationalEvents(operator, { cursor: null, limit: 10, kind: null });
    expect(result.events).toHaveLength(0);
  });
});

describe('listOperationalEvents', () => {
  it('filters by kind', async () => {
    await recordOperationalEvent({ kind: 'mail', outcome: 'success' });
    await recordOperationalEvent({ kind: 'billing_webhook', outcome: 'failure' });
    await recordOperationalEvent({ kind: 'billing_sweep', outcome: 'success' });

    const mailOnly = await listOperationalEvents(operator, {
      cursor: null,
      limit: 10,
      kind: 'mail',
    });
    expect(mailOnly.events).toHaveLength(1);
    expect(mailOnly.events[0]?.kind).toBe('mail');

    const everything = await listOperationalEvents(operator, {
      cursor: null,
      limit: 10,
      kind: null,
    });
    expect(everything.events).toHaveLength(3);
  });

  it('orders newest first', async () => {
    await admin.query(
      `INSERT INTO platform.operational_events (kind, outcome, occurred_at)
       VALUES ('mail', 'success', now() - interval '1 hour'),
              ('billing_sweep', 'success', now())`,
    );

    const result = await listOperationalEvents(operator, { cursor: null, limit: 10, kind: null });
    expect(result.events.map((row) => row.kind)).toEqual(['billing_sweep', 'mail']);
  });

  it('records an operator action for the read (§5s acceptance criterion)', async () => {
    await recordOperationalEvent({ kind: 'billing_sweep', outcome: 'success' });
    await listOperationalEvents(operator, { cursor: null, limit: 10, kind: null });

    const entries = await readOperatorAudit({ limit: 10, before: null });
    expect(entries.some((entry) => entry.action === 'operations.list')).toBe(true);
  });
});
