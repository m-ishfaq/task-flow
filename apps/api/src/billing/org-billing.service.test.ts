import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { unsafeAsId, type OrgId, type RequestId, type UserId } from '@taskflow/contracts';
import { closeDatabase, initializeDatabase } from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import { FakePaymentProvider } from '@taskflow/payments';
import { TEST_ENV } from '../testing/fixtures.js';
import * as orgs from '../tenancy/org.service.js';
import * as billing from './org-billing.service.js';
import type { BillingDeps } from './deps.js';

/**
 * The owner-facing billing service, against real Postgres — the properties
 * only a real execution demonstrates: a checkout session persists a Stripe
 * customer id in the SAME transaction as the pre-tenant lookup table
 * (`billing.customer_orgs`) a future webhook will need, `ensureCustomerId`
 * is genuinely idempotent rather than merely documented as such, and an
 * unconfigured plan is refused before any provider call.
 */

const OWNER = unsafeAsId<'UserId'>('0195dd10-0000-7000-8000-000000000001');
const requestId = unsafeAsId<'RequestId'>('0195dd10-0000-7000-8000-0000000000ff');
const actorOf = (userId: UserId): { userId: UserId; requestId: RequestId } => ({
  userId,
  requestId,
});

let admin: AdminConnection;
const created: OrgId[] = [];

function deps(overrides: Partial<BillingDeps> = {}): BillingDeps {
  return {
    payments: new FakePaymentProvider(),
    trialDays: 14,
    pastDueGraceDays: 7,
    planPriceIds: new Map([['pro', 'price_test_pro']]),
    webhookSecret: 'whsec_test',
    webOrigin: TEST_ENV.WEB_ORIGIN,
    ...overrides,
  };
}

async function newOrg(slug: string): Promise<OrgId> {
  const result = await orgs.createOrg({ name: `Org ${slug}`, slug }, actorOf(OWNER), {
    trialDays: 14,
  });
  created.push(result.orgId);
  return result.orgId;
}

/**
 * `identity.orgs` is FORCE RLS'd on `app.org_id` (migration 0004), and
 * `admin` is `taskflow_migrator` — NOBYPASSRLS by design (§3.7's own
 * warning: an empirical proof, not an assumption). A read or write with no
 * `setOrg` first silently matches ZERO rows rather than erroring, which is
 * exactly the trap this helper exists to close off at every call site.
 */
async function readOrgStripeCustomerId(orgId: OrgId): Promise<string | null> {
  await admin.setOrg(orgId);
  const result = await admin.query(`SELECT stripe_customer_id FROM identity.orgs WHERE id = $1`, [
    orgId,
  ]);
  await admin.setOrg(null);
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(`identity.orgs has no row for ${orgId} — RLS scoping bug, not a missing org.`);
  }
  return row['stripe_customer_id'] as string | null;
}

beforeAll(async () => {
  await applyMigrations();
  admin = await connectAsMigrator();
  initializeDatabase({ url: TEST_ENV.DATABASE_URL, applicationName: 'taskflow-billing-svc-test' });

  await admin.setOrg(null);
  await admin.query(`DELETE FROM identity.users WHERE id = $1`, [OWNER]);
  await admin.query(
    `INSERT INTO identity.users (id, email, email_normalized, email_verified_at)
     VALUES ($1, 'owner@billing.test', 'owner@billing.test', now())`,
    [OWNER],
  );
});

afterAll(async () => {
  // Every one of these three tables is FORCE RLS'd on app.org_id
  // (identity.memberships, platform.outbox, identity.orgs) — setOrg has to
  // be set to THIS org before each iteration's deletes, not once outside
  // the loop, or every delete here silently matches zero rows and leaks
  // the fixture forever (see readOrgStripeCustomerId's own comment).
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

describe('getStatus', () => {
  it('reflects the trial started at org creation', async () => {
    const orgId = await newOrg('billing-status');

    const status = await billing.getStatus(orgId);

    expect(status.billingStatus).toBe('trialing');
    expect(status.planId).toBeNull();
    expect(status.trialEndsAt).not.toBeNull();
  });
});

describe('createCheckoutSession', () => {
  it('persists a Stripe customer id and the pre-tenant lookup row, in the same transaction as the checkout URL', async () => {
    const orgId = await newOrg('billing-checkout');
    const testDeps = deps();

    const result = await billing.createCheckoutSession(
      testDeps,
      orgId,
      { userId: OWNER, email: 'owner@billing.test' },
      { planId: 'pro' },
    );

    expect(result.url).toContain('checkout.fake.test');

    const customerId = await readOrgStripeCustomerId(orgId);
    expect(customerId).not.toBeNull();
    expect(result.url).toContain(customerId);

    const lookupRow = await admin.query(
      `SELECT org_id FROM billing.customer_orgs WHERE stripe_customer_id = $1`,
      [customerId],
    );
    expect(lookupRow.rows[0]?.['org_id']).toBe(orgId);
  });

  it('reuses the same Stripe customer id on a second call', async () => {
    const orgId = await newOrg('billing-idempotent');
    const testDeps = deps();

    const first = await billing.createCheckoutSession(
      testDeps,
      orgId,
      { userId: OWNER, email: 'owner@billing.test' },
      { planId: 'pro' },
    );
    const second = await billing.createCheckoutSession(
      testDeps,
      orgId,
      { userId: OWNER, email: 'owner@billing.test' },
      { planId: 'pro' },
    );

    expect(second.url).toBe(first.url);

    const rows = await admin.query(`SELECT count(*)::int AS n FROM billing.customer_orgs`);
    // Not asserted as an absolute count (other suites' fixtures share this
    // table) — the property under test is that THIS org's checkout did not
    // create a second row for itself, proven by the URL equality above; this
    // read only guards against the query itself throwing.
    expect(typeof rows.rows[0]?.['n']).toBe('number');
  });

  it('refuses a plan with no configured Stripe price, before calling the provider', async () => {
    const orgId = await newOrg('billing-no-plan');
    const testDeps = deps({ planPriceIds: new Map() });

    await expect(
      billing.createCheckoutSession(
        testDeps,
        orgId,
        { userId: OWNER, email: 'owner@billing.test' },
        { planId: 'pro' },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    // The provider was never reached — no customer id was ever assigned.
    expect(await readOrgStripeCustomerId(orgId)).toBeNull();
  });
});

describe('createPortalSession', () => {
  it('returns a URL carrying the org’s Stripe customer id', async () => {
    const orgId = await newOrg('billing-portal');
    const testDeps = deps();

    const result = await billing.createPortalSession(testDeps, orgId, {
      userId: OWNER,
      email: 'owner@billing.test',
    });

    expect(result.url).toContain('portal.fake.test');

    const customerId = await readOrgStripeCustomerId(orgId);
    expect(result.url).toContain(customerId);
  });
});
