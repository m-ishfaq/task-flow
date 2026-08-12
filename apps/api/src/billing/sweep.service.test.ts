import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { unsafeAsId, type OrgId, type RequestId, type UserId } from '@taskflow/contracts';
import { closeDatabase, initializeDatabase } from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import * as orgs from '../tenancy/org.service.js';
import { TEST_ENV } from '../testing/fixtures.js';
import { expireGracePeriod, expireTrial } from './sweep.service.js';

/**
 * The sweep's own write-side transitions, against real Postgres — proving
 * the conditional `WHERE billingStatus = <fromStatus>` actually refuses a
 * row already moved on by something else, which is the property the whole
 * "a sweep tick racing a webhook cannot double-apply" claim rests on.
 * `apps/worker`'s own `billing/sweep.ts` is the cross-tenant SCAN half —
 * untestable here without a real `taskflow_billing_sweep` connection, which
 * this suite does not open; it exercises the WRITE half these functions are.
 */

const OWNER = unsafeAsId<'UserId'>('0195dd30-0000-7000-8000-000000000001');
const requestId = unsafeAsId<'RequestId'>('0195dd30-0000-7000-8000-0000000000ff');
const actorOf = (userId: UserId): { userId: UserId; requestId: RequestId } => ({
  userId,
  requestId,
});

let admin: AdminConnection;
const created: OrgId[] = [];

async function newOrg(slug: string): Promise<OrgId> {
  const result = await orgs.createOrg({ name: `Org ${slug}`, slug }, actorOf(OWNER), {
    trialDays: 14,
  });
  created.push(result.orgId);
  return result.orgId;
}

beforeAll(async () => {
  await applyMigrations();
  admin = await connectAsMigrator();

  await admin.setOrg(null);
  await admin.query(`DELETE FROM identity.users WHERE id = $1`, [OWNER]);
  await admin.query(
    `INSERT INTO identity.users (id, email, email_normalized, email_verified_at)
     VALUES ($1, 'owner@billing-sweep.test', 'owner@billing-sweep.test', now())`,
    [OWNER],
  );

  initializeDatabase({ url: TEST_ENV.DATABASE_URL, applicationName: 'billing-sweep-test' });
});

afterAll(async () => {
  await admin.setOrg(null);
  for (const orgId of created) {
    await admin.query(`DELETE FROM identity.memberships WHERE org_id = $1`, [orgId]);
    await admin.query(`DELETE FROM platform.outbox WHERE org_id = $1`, [orgId]);
    await admin.query(`DELETE FROM identity.orgs WHERE id = $1`, [orgId]);
  }
  await admin.query(`DELETE FROM identity.users WHERE id = $1`, [OWNER]);
  await admin.end();
  await closeDatabase();
});

describe('expireTrial', () => {
  it('moves a trialing org to past_due with a grace deadline', async () => {
    const orgId = await newOrg('sweep-expire-trial');

    const applied = await expireTrial(orgId, { pastDueGraceDays: 7 });
    expect(applied).toBe(true);

    const row = await admin.query(
      `SELECT billing_status, billing_grace_ends_at FROM identity.orgs WHERE id = $1`,
      [orgId],
    );
    expect(row.rows[0]?.['billing_status']).toBe('past_due');
    expect(row.rows[0]?.['billing_grace_ends_at']).not.toBeNull();
  });

  it('is a no-op on a non-trialing org', async () => {
    const orgId = await newOrg('sweep-expire-trial-noop');
    await admin.query(`UPDATE identity.orgs SET billing_status = 'active' WHERE id = $1`, [orgId]);

    const applied = await expireTrial(orgId, { pastDueGraceDays: 7 });
    expect(applied).toBe(false);

    const row = await admin.query(`SELECT billing_status FROM identity.orgs WHERE id = $1`, [
      orgId,
    ]);
    expect(row.rows[0]?.['billing_status']).toBe('active');
  });
});

describe('expireGracePeriod', () => {
  it('cancels a past_due org and clears the grace deadline', async () => {
    const orgId = await newOrg('sweep-expire-grace');
    await admin.query(
      `UPDATE identity.orgs SET billing_status = 'past_due', billing_grace_ends_at = now() WHERE id = $1`,
      [orgId],
    );

    const applied = await expireGracePeriod(orgId);
    expect(applied).toBe(true);

    const row = await admin.query(
      `SELECT billing_status, billing_grace_ends_at FROM identity.orgs WHERE id = $1`,
      [orgId],
    );
    expect(row.rows[0]?.['billing_status']).toBe('canceled');
    expect(row.rows[0]?.['billing_grace_ends_at']).toBeNull();
  });

  it('is a no-op on a trialing org (nothing to expire yet)', async () => {
    const orgId = await newOrg('sweep-expire-grace-noop');

    const applied = await expireGracePeriod(orgId);
    expect(applied).toBe(false);

    const row = await admin.query(`SELECT billing_status FROM identity.orgs WHERE id = $1`, [
      orgId,
    ]);
    expect(row.rows[0]?.['billing_status']).toBe('trialing');
  });

  it('never moves a canceled org backward on a redundant call', async () => {
    const orgId = await newOrg('sweep-expire-grace-idempotent');
    await admin.query(`UPDATE identity.orgs SET billing_status = 'canceled' WHERE id = $1`, [
      orgId,
    ]);

    const applied = await expireGracePeriod(orgId);
    expect(applied).toBe(false);

    const row = await admin.query(`SELECT billing_status FROM identity.orgs WHERE id = $1`, [
      orgId,
    ]);
    expect(row.rows[0]?.['billing_status']).toBe('canceled');
  });
});
