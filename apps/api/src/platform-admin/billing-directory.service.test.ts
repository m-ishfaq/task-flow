import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { unsafeAsId, type OrgId, type UserId } from '@taskflow/contracts';
import { RecordingEventBus } from '@taskflow/events';
import {
  closeDatabase,
  initializeAuditDatabase,
  initializeDatabase,
  initializePlatformAdminDatabase,
} from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import { TEST_ENV } from '../testing/fixtures.js';
import * as orgs from '../tenancy/org.service.js';
import { grantExtension, listBilling } from './billing-directory.service.js';
import type { PlatformOperator } from './org-directory.service.js';

/**
 * The platform console's billing view, against real Postgres — proving
 * `listBilling` returns real rows THROUGH `withPlatformAdminScope` (the
 * §3.7-class bug: a plain `withGlobalScope` read of `identity.orgs` would
 * silently return `[]`) and that `grantExtension` refuses a non-past_due
 * org, extends from the LATER of now and an existing deadline, and writes
 * into the org's own audit chain.
 *
 * Deliberately does NOT touch `platform.operator_audit_log` or
 * `platform.operators` — both are GLOBAL tables `platform-admin.service
 * .test.ts` resets in its own beforeEach, and Vitest runs test files in this
 * package in parallel; a second file resetting the same global chain would
 * race it. `PlatformOperator` here is a plain `{ userId, requestId }` value
 * — these service functions take it as a parameter and do not themselves
 * check `isPlatformOperator`, so no row in `platform.operators` is needed to
 * call them directly.
 */

const OPERATOR = unsafeAsId<'UserId'>('0195dd40-0000-7000-8000-000000000001');
const OWNER = unsafeAsId<'UserId'>('0195dd40-0000-7000-8000-000000000002');
const requestId = unsafeAsId<'RequestId'>('0195dd40-0000-7000-8000-0000000000ff');

function operatorOf(userId: UserId): PlatformOperator {
  return { userId, requestId };
}

let admin: AdminConnection;
const created: OrgId[] = [];

async function newOrg(slug: string): Promise<OrgId> {
  const result = await orgs.createOrg(
    { name: `Org ${slug}`, slug },
    { userId: OWNER, requestId },
    {
      trialDays: 14,
    },
  );
  created.push(result.orgId);
  return result.orgId;
}

beforeAll(async () => {
  await applyMigrations();
  admin = await connectAsMigrator();

  await admin.setOrg(null);
  await admin.query(`DELETE FROM identity.users WHERE id = ANY($1::uuid[])`, [[OPERATOR, OWNER]]);
  for (const [id, email] of [
    [OPERATOR, 'operator@billing-directory.test'],
    [OWNER, 'owner@billing-directory.test'],
  ] as const) {
    await admin.query(
      `INSERT INTO identity.users (id, email, email_normalized, email_verified_at)
       VALUES ($1, $2, $2, now())`,
      [id, email],
    );
  }

  initializeDatabase({ url: TEST_ENV.DATABASE_URL, applicationName: 'billing-directory-test' });
  initializeAuditDatabase({
    url:
      process.env['TEST_DATABASE_AUDIT_URL'] ??
      'postgresql://taskflow_audit:audit-dev-secret@localhost:5433/taskflow_test',
    applicationName: 'billing-directory-audit-test',
  });
  initializePlatformAdminDatabase({
    url:
      process.env['TEST_DATABASE_PLATFORM_ADMIN_URL'] ??
      'postgresql://taskflow_platform_admin:platform-admin-dev-secret@localhost:5433/taskflow_test',
    applicationName: 'billing-directory-platform-admin-test',
  });
});

afterAll(async () => {
  // Every one of these tables is FORCE RLS'd on app.org_id — setOrg has to
  // be scoped to THIS org inside the loop, not once outside it, or every
  // delete here silently matches zero rows (identity.orgs is
  // NOBYPASSRLS'd even for taskflow_migrator — migration 0004's own
  // comment on FORCE).
  for (const orgId of created) {
    await admin.setOrg(orgId);
    await admin.query(`DELETE FROM identity.memberships WHERE org_id = $1`, [orgId]);
    await admin.query(`DELETE FROM platform.outbox WHERE org_id = $1`, [orgId]);
    await admin.query(`DELETE FROM audit.audit_log WHERE org_id = $1`, [orgId]);
    await admin.query(`DELETE FROM audit.chain_heads WHERE org_id = $1`, [orgId]);
    await admin.query(`DELETE FROM identity.orgs WHERE id = $1`, [orgId]);
    await admin.setOrg(null);
  }
  // `grantExtension`'s own dual-write leaves rows in the GLOBAL operator
  // chain referencing OPERATOR — scoped to this file's own operator id
  // (never a blanket delete, unlike platform-admin.service.test.ts's own
  // reset, which is exactly what this file's header says to avoid racing).
  // Without this, deleting OPERATOR below fails its own FK.
  await admin.query(`DELETE FROM platform.operator_audit_log WHERE operator_id = $1`, [OPERATOR]);
  await admin.query(`DELETE FROM identity.users WHERE id = ANY($1::uuid[])`, [[OPERATOR, OWNER]]);
  await admin.end();
  await closeDatabase();
});

describe('listBilling', () => {
  it('returns a real org row through withPlatformAdminScope', async () => {
    const orgId = await newOrg('billing-directory-list');

    const result = await listBilling(operatorOf(OPERATOR), { cursor: null, limit: 100 });

    const row = result.orgs.find((entry) => entry.orgId === orgId);
    expect(row).toBeDefined();
    expect(row?.billingStatus).toBe('trialing');
    expect(row?.trialEndsAt).not.toBeNull();
  });
});

describe('grantExtension', () => {
  it('refuses an org that is not currently past_due', async () => {
    const orgId = await newOrg('billing-directory-not-past-due');
    const events = new RecordingEventBus();

    await expect(
      grantExtension({ events }, operatorOf(OPERATOR), { orgId, extendByDays: 7 }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('extends the grace deadline and writes into the org’s own audit chain', async () => {
    const orgId = await newOrg('billing-directory-extend');
    // identity.orgs is FORCE RLS'd — without setOrg this UPDATE silently
    // matches zero rows, leaving billing_status at its 'trialing' default,
    // and grantExtension below would then (correctly) refuse it.
    await admin.setOrg(orgId);
    await admin.query(
      `UPDATE identity.orgs SET billing_status = 'past_due', billing_grace_ends_at = now() + interval '1 day' WHERE id = $1`,
      [orgId],
    );
    await admin.setOrg(null);
    const events = new RecordingEventBus();

    const result = await grantExtension({ events }, operatorOf(OPERATOR), {
      orgId,
      extendByDays: 7,
    });

    // Extended from the EXISTING deadline (now + 1 day), not reset to
    // "now + 7" — the result should land roughly 8 days out, not 7.
    const hoursFromNow = (result.billingGraceEndsAt.getTime() - Date.now()) / (60 * 60 * 1000);
    expect(hoursFromNow).toBeGreaterThan(7 * 24);
    expect(hoursFromNow).toBeLessThan(9 * 24);

    await admin.setOrg(orgId);
    const chainRow = await admin.query(
      `SELECT action FROM audit.audit_log WHERE org_id = $1 AND action = 'billing.grace_extended'`,
      [orgId],
    );
    await admin.setOrg(null);
    expect(chainRow.rowCount).toBe(1);
  });

  it('never shortens a deadline further out than "now + extendByDays"', async () => {
    const orgId = await newOrg('billing-directory-extend-later-base');
    await admin.setOrg(orgId);
    await admin.query(
      `UPDATE identity.orgs SET billing_status = 'past_due', billing_grace_ends_at = now() + interval '30 days' WHERE id = $1`,
      [orgId],
    );
    await admin.setOrg(null);
    const events = new RecordingEventBus();

    const result = await grantExtension({ events }, operatorOf(OPERATOR), {
      orgId,
      extendByDays: 1,
    });

    const daysFromNow = (result.billingGraceEndsAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    // 30 days already on the clock, + 1 more — not reset down to ~1.
    expect(daysFromNow).toBeGreaterThan(29);
  });
});
