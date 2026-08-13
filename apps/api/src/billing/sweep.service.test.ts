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

/**
 * `identity.orgs` is FORCE RLS'd on `app.org_id` (migration 0004), and
 * `admin` is `taskflow_migrator` — NOBYPASSRLS by design. Every raw read or
 * write against it here has to bracket itself with `setOrg`, or it silently
 * matches zero rows instead of erroring — the exact trap these two helpers
 * exist to close off at every call site.
 */
async function setOrgBillingStatus(
  orgId: OrgId,
  billingStatus: string,
  extra?: { readonly graceEndsAtNow?: boolean },
): Promise<void> {
  await admin.setOrg(orgId);
  if (extra?.graceEndsAtNow === true) {
    await admin.query(
      `UPDATE identity.orgs SET billing_status = $2, billing_grace_ends_at = now() WHERE id = $1`,
      [orgId, billingStatus],
    );
  } else {
    await admin.query(`UPDATE identity.orgs SET billing_status = $2 WHERE id = $1`, [
      orgId,
      billingStatus,
    ]);
  }
  await admin.setOrg(null);
}

async function readOrgBilling(
  orgId: OrgId,
): Promise<{ billingStatus: string | null; billingGraceEndsAt: Date | null }> {
  await admin.setOrg(orgId);
  const result = await admin.query(
    `SELECT billing_status, billing_grace_ends_at FROM identity.orgs WHERE id = $1`,
    [orgId],
  );
  await admin.setOrg(null);
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(`identity.orgs has no row for ${orgId} — RLS scoping bug, not a missing org.`);
  }
  return {
    billingStatus: row['billing_status'] as string | null,
    billingGraceEndsAt: row['billing_grace_ends_at'] as Date | null,
  };
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
  // FORCE RLS on identity.memberships/platform.outbox/identity.orgs means
  // setOrg has to be scoped to THIS org inside the loop, not once outside
  // it — see setOrgBillingStatus's own comment.
  for (const orgId of created) {
    await admin.setOrg(orgId);
    await admin.query(`DELETE FROM identity.memberships WHERE org_id = $1`, [orgId]);
    await admin.query(`DELETE FROM platform.outbox WHERE org_id = $1`, [orgId]);
    await admin.query(`DELETE FROM identity.orgs WHERE id = $1`, [orgId]);
    await admin.setOrg(null);
  }
  await admin.query(`DELETE FROM identity.users WHERE id = $1`, [OWNER]);
  await admin.end();
  await closeDatabase();
});

describe('expireTrial', () => {
  it('lands a trialing org on the DEFAULT PLAN, never locked out', async () => {
    /* The Wave 4 behaviour, and the reason this assertion changed: a trial
       running out used to mean `past_due` with a grace countdown, which
       conflated "never had a payment method" with "a real charge was
       declined" and started a clock on someone who owed nothing. Now they
       land on the free plan, keep every row they created, and lose only what
       that plan does not include. */
    const orgId = await newOrg('sweep-expire-trial');

    const applied = await expireTrial(orgId);
    expect(applied).toBe(true);

    const row = await readOrgBilling(orgId);
    expect(row.billingStatus, 'active, not past_due — nobody is locked out').toBe('active');
    expect(row.billingGraceEndsAt, 'no countdown: nothing was owed').toBeNull();
  });

  it('is a no-op on a non-trialing org', async () => {
    const orgId = await newOrg('sweep-expire-trial-noop');
    await setOrgBillingStatus(orgId, 'active');

    const applied = await expireTrial(orgId);
    expect(applied).toBe(false);

    expect((await readOrgBilling(orgId)).billingStatus).toBe('active');
  });
});

describe('expireGracePeriod', () => {
  it('lands a lapsed org on the default plan rather than locking it out', async () => {
    /* Same Wave 4 change as `expireTrial`: the grace period ending stops the
       PAID features, not the product. `resolveOrgMembership` no longer
       refuses on any billing state, so a `canceled` status here would have
       been a lockout with nothing left to enforce it. */
    const orgId = await newOrg('sweep-expire-grace');
    await setOrgBillingStatus(orgId, 'past_due', { graceEndsAtNow: true });

    const applied = await expireGracePeriod(orgId);
    expect(applied).toBe(true);

    const row = await readOrgBilling(orgId);
    expect(row.billingStatus).toBe('active');
    expect(row.billingGraceEndsAt).toBeNull();
  });

  it('is a no-op on a trialing org (nothing to expire yet)', async () => {
    const orgId = await newOrg('sweep-expire-grace-noop');

    const applied = await expireGracePeriod(orgId);
    expect(applied).toBe(false);

    expect((await readOrgBilling(orgId)).billingStatus).toBe('trialing');
  });

  it('is a no-op on an org that already lapsed', async () => {
    /* The conditional UPDATE is what makes a second sweep tick harmless: only
       a `past_due` row matches, so a redundant call changes nothing and
       emits nothing. */
    const orgId = await newOrg('sweep-expire-grace-idempotent');
    await setOrgBillingStatus(orgId, 'canceled');

    const applied = await expireGracePeriod(orgId);
    expect(applied).toBe(false);

    expect((await readOrgBilling(orgId)).billingStatus).toBe('canceled');
  });
});
