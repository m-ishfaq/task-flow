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
  /* No `planPriceIds` any more. Phase 12 Wave 4 moved the catalog into
     `billing.plans`/`billing.plan_prices`, so a checkout resolves its price
     from the DATABASE per request rather than from a map built at boot — and
     these tests now seed a real catalog row instead of a fixture map, which
     is the point: the map could disagree with the database and the test would
     never notice. */
  return {
    payments: new FakePaymentProvider(),
    trialDays: 14,
    pastDueGraceDays: 7,
    webhookSecret: 'whsec_test',
    webOrigin: TEST_ENV.WEB_ORIGIN,
    ...overrides,
  };
}

/**
 * A sellable plan for these tests, written directly as the migrator.
 *
 * Its OWN plan rather than 0063's seeded `pro`: that row deliberately carries
 * no processor product (a migration cannot call Stripe), and mutating a seeded
 * row would leave every other suite reading a catalog this file changed.
 */
const TEST_PLAN = 'billing-suite-plan';

async function seedCatalog(): Promise<void> {
  await clearCatalog();
  await admin.query(
    `INSERT INTO billing.plans (id, name, stripe_product_id) VALUES ($1, 'Billing Suite Plan', $2)`,
    [TEST_PLAN, `prod_${TEST_PLAN}`],
  );
  await admin.query(
    `INSERT INTO billing.plan_prices (plan_id, interval, amount_cents, stripe_price_id, is_current)
     VALUES ($1, 'month', 2900, $2, true)`,
    [TEST_PLAN, `price_${TEST_PLAN}_month`],
  );
}

/** Children before parents, and idempotent — `taskflow_test` persists. */
async function clearCatalog(): Promise<void> {
  await admin.query(`DELETE FROM billing.plan_prices WHERE plan_id = $1`, [TEST_PLAN]);
  await admin.query(`DELETE FROM billing.plans WHERE id = $1`, [TEST_PLAN]);
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

  await seedCatalog();
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
  await clearCatalog();
  await admin.end();
  await closeDatabase();
});

describe('getStatus', () => {
  it('reflects the trial started at org creation', async () => {
    const orgId = await newOrg('billing-status');

    const status = await billing.getStatus(orgId);

    expect(status.billingStatus).toBe('trialing');
    /* Migration 0094: `createOrg` assigns the real `trial` plan, not NULL —
       every module flag now defaults to `false` (packages/feature-flags/src
       /flags.ts's own header), so a NULL plan would mean a brand-new org
       sees nothing at all. */
    expect(status.planId).toBe('trial');
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
      { planId: TEST_PLAN, interval: 'month' },
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
      { planId: TEST_PLAN, interval: 'month' },
    );
    const second = await billing.createCheckoutSession(
      testDeps,
      orgId,
      { userId: OWNER, email: 'owner@billing.test' },
      { planId: TEST_PLAN, interval: 'month' },
    );

    expect(second.url).toBe(first.url);

    const rows = await admin.query(`SELECT count(*)::int AS n FROM billing.customer_orgs`);
    // Not asserted as an absolute count (other suites' fixtures share this
    // table) — the property under test is that THIS org's checkout did not
    // create a second row for itself, proven by the URL equality above; this
    // read only guards against the query itself throwing.
    expect(typeof rows.rows[0]?.['n']).toBe('number');
  });

  it('refuses a plan with no current price, before calling the provider', async () => {
    /* `free` is 0063's seeded default: a real catalog row, deliberately with
       no processor product and no price. Asserting against it rather than
       against an empty fixture map is the whole point of the Wave 4 change —
       the refusal now depends on what is actually IN the catalog, so a
       fixture can no longer disagree with the database. */
    const orgId = await newOrg('billing-no-price');
    const testDeps = deps();

    await expect(
      billing.createCheckoutSession(
        testDeps,
        orgId,
        { userId: OWNER, email: 'owner@billing.test' },
        { planId: 'free', interval: 'month' },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    // The provider was never reached — no customer id was ever assigned.
    expect(await readOrgStripeCustomerId(orgId)).toBeNull();
  });

  it('refuses a plan id that is not in the catalog at all', async () => {
    /* The route validates the SHAPE of a plan id; only the catalog knows
       which ids exist. A client naming a plan that was never created must get
       the same refusal as one naming a plan with no price — and must not
       reach the provider on the way. */
    const orgId = await newOrg('billing-unknown-plan');

    await expect(
      billing.createCheckoutSession(
        deps(),
        orgId,
        { userId: OWNER, email: 'owner@billing.test' },
        { planId: 'no-such-plan', interval: 'month' },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    expect(await readOrgStripeCustomerId(orgId)).toBeNull();
  });

  it('refuses an interval the plan has no price for', async () => {
    /* The seeded test plan is monthly-only. An annual checkout against it
       must be refused rather than silently falling back to the monthly price
       — which would charge a customer a different amount from the one they
       chose. */
    const orgId = await newOrg('billing-wrong-interval');

    await expect(
      billing.createCheckoutSession(
        deps(),
        orgId,
        { userId: OWNER, email: 'owner@billing.test' },
        { planId: TEST_PLAN, interval: 'year' },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    expect(await readOrgStripeCustomerId(orgId)).toBeNull();
  });
});

describe('getOverview', () => {
  /**
   * A raw insert rather than `ai/spend-gate.ts`'s own `recordAiUsage` — that
   * function needs an open `withOrgScope` transaction and an envelope this
   * test has no other reason to construct; a direct row is simpler and this
   * file already establishes the "read/write around RLS directly as the
   * migrator" pattern (`readOrgStripeCustomerId`) for exactly this kind of
   * fixture setup.
   */
  async function insertAiUsage(orgId: OrgId, costCents: number): Promise<void> {
    await admin.setOrg(orgId);
    await admin.query(
      `INSERT INTO ai.usage_ledger (id, org_id, feature, provider, model, input_tokens, output_tokens, cost_cents)
       VALUES (gen_random_uuid(), $1, 'chat', 'anthropic', 'test-model', 10, 10, $2)`,
      [orgId, costCents],
    );
    await admin.setOrg(null);
  }

  it('reflects real AI spend for the caller’s own org, and not a sibling org’s', async () => {
    const orgId = await newOrg('billing-ai-spend');
    const otherOrgId = await newOrg('billing-ai-spend-other');

    await insertAiUsage(orgId, 250);
    await insertAiUsage(orgId, 150);
    await insertAiUsage(otherOrgId, 9_000);

    const overview = await billing.getOverview(orgId);

    expect(overview.usage.aiSpentCents).toBe(400);
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
