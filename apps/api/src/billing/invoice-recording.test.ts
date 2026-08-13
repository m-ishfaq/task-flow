import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  closeDatabase,
  eq,
  initializeDatabase,
  schema,
  withOrgScope,
} from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import {
  unsafeAsId,
  type BillingWebhookEvent,
  type OrgId,
  type RequestId,
  type UserId,
} from '@taskflow/contracts';
import { FakePaymentProvider } from '@taskflow/payments';
import { TEST_ENV } from '../testing/fixtures.js';
import * as orgs from '../tenancy/org.service.js';
import { applyBillingWebhookEvent } from './webhook-apply.service.js';
import { resetEntitlementCache } from './entitlement-resolver.js';
import type { BillingDeps } from './deps.js';

/**
 * Invoice recording and plan resolution, against real Postgres (Phase 12
 * Wave 4).
 *
 * Two properties, each of which a weaker test would have missed entirely:
 *
 *   1. **A replayed webhook UPSERTS.** Stripe retries an event it could not
 *      confirm was handled, and an invoice's status changes over its life
 *      (`open` then `paid`), so the same document arrives repeatedly. An
 *      insert-only implementation passes any test that sends one event and
 *      leaves a customer's history showing the same invoice three times in
 *      three states.
 *
 *   2. **The plan comes from the PRICE, not from a literal.** Until this wave
 *      `applyBillingWebhookEvent` hardcoded `planId: 'pro'`. Every existing
 *      test passed — because `pro` was the only plan and the hardcoded value
 *      happened to be right. The assertion that catches it has to check out
 *      against a DIFFERENT tier and demand that tier back.
 */

const OWNER = unsafeAsId<'UserId'>('0195dd30-0000-7000-8000-000000000001');
const requestId = unsafeAsId<'RequestId'>('0195dd30-0000-7000-8000-0000000000ff');
const actorOf = (userId: UserId): { userId: UserId; requestId: RequestId } => ({
  userId,
  requestId,
});

/** Two tiers, so "resolved the right one" is a real question. */
const PRO_PLAN = 'invoice-test-pro';
const BUSINESS_PLAN = 'invoice-test-business';
const PRO_PRICE = 'price_invoice_test_pro';
const BUSINESS_PRICE = 'price_invoice_test_business';

let admin: AdminConnection;
const created: OrgId[] = [];

function deps(): BillingDeps {
  return {
    payments: new FakePaymentProvider(),
    trialDays: 14,
    pastDueGraceDays: 7,
    webhookSecret: 'whsec_test',
    webOrigin: TEST_ENV.WEB_ORIGIN,
  };
}

async function newOrg(slug: string): Promise<OrgId> {
  const result = await orgs.createOrg({ name: `Org ${slug}`, slug }, actorOf(OWNER), {
    trialDays: 14,
  });
  created.push(result.orgId);
  return result.orgId;
}

/** Applies one event through the real service, in the real org scope. */
async function apply(orgId: OrgId, event: BillingWebhookEvent): Promise<void> {
  await withOrgScope(orgId, async (tx) => {
    await applyBillingWebhookEvent(tx, deps(), orgId, event, requestId);
  });
  resetEntitlementCache();
}

async function readInvoices(orgId: OrgId) {
  return withOrgScope(orgId, async (tx) =>
    tx.select().from(schema.invoices).where(eq(schema.invoices.orgId, orgId)),
  );
}

async function readPlanId(orgId: OrgId): Promise<string | null> {
  return withOrgScope(orgId, async (tx) => {
    const rows = await tx
      .select({ planId: schema.orgs.planId })
      .from(schema.orgs)
      .where(eq(schema.orgs.id, orgId))
      .limit(1);
    return rows[0]?.planId ?? null;
  });
}

async function clearCatalog(): Promise<void> {
  await admin.query(`DELETE FROM billing.plan_prices WHERE plan_id = ANY($1)`, [
    [PRO_PLAN, BUSINESS_PLAN],
  ]);
  await admin.query(`DELETE FROM billing.plans WHERE id = ANY($1)`, [[PRO_PLAN, BUSINESS_PLAN]]);
}

beforeAll(async () => {
  await applyMigrations();
  admin = await connectAsMigrator();
  initializeDatabase({ url: TEST_ENV.DATABASE_URL, applicationName: 'taskflow-invoice-test' });

  await admin.setOrg(null);
  await admin.query(`DELETE FROM identity.users WHERE id = $1`, [OWNER]);
  await admin.query(
    `INSERT INTO identity.users (id, email, email_normalized, email_verified_at)
     VALUES ($1, 'owner@invoice.test', 'owner@invoice.test', now())`,
    [OWNER],
  );

  /* Before, not only after — an aborted previous run skips teardown, and
     `taskflow_test` persists between runs. */
  await clearCatalog();
  await admin.query(
    `INSERT INTO billing.plans (id, name, stripe_product_id) VALUES ($1, 'Pro', $3), ($2, 'Business', $4)`,
    [PRO_PLAN, BUSINESS_PLAN, `prod_${PRO_PLAN}`, `prod_${BUSINESS_PLAN}`],
  );
  await admin.query(
    `INSERT INTO billing.plan_prices (plan_id, interval, amount_cents, stripe_price_id, is_current)
     VALUES ($1, 'month', 2900, $3, true), ($2, 'month', 9900, $4, true)`,
    [PRO_PLAN, BUSINESS_PLAN, PRO_PRICE, BUSINESS_PRICE],
  );
});

afterEach(() => {
  resetEntitlementCache();
});

afterAll(async () => {
  for (const orgId of created) {
    await admin.query(`DELETE FROM billing.invoices WHERE org_id = $1`, [orgId]);
    await admin.setOrg(orgId);
    await admin.query(`DELETE FROM identity.memberships WHERE org_id = $1`, [orgId]);
    await admin.query(`DELETE FROM platform.outbox WHERE org_id = $1`, [orgId]);
    await admin.query(`DELETE FROM identity.orgs WHERE id = $1`, [orgId]);
    await admin.setOrg(null);
  }
  await clearCatalog();
  await admin.query(`DELETE FROM identity.users WHERE id = $1`, [OWNER]);
  await admin.end();
  await closeDatabase();
});

describe('the plan comes from the price, not from a literal', () => {
  it('records BUSINESS when the customer checked out the business price', async () => {
    /* THE assertion. The previous implementation hardcoded `'pro'` and passed
       every test in this codebase, because `pro` was the only plan that could
       exist — so the failing case has to demand a DIFFERENT tier back. */
    const orgId = await newOrg('invoice-business');

    await apply(orgId, {
      kind: 'subscription_activated',
      providerEventId: 'evt_business',
      customerId: 'cus_business',
      subscriptionId: 'sub_business',
      priceId: BUSINESS_PRICE,
    });

    expect(await readPlanId(orgId)).toBe(BUSINESS_PLAN);
  });

  it('resolves a RETIRED price too — a grandfathered customer renews on one', async () => {
    /* The whole point of §3.2's append-and-archive design is that an existing
       subscriber keeps billing against a price that is no longer current.
       A resolver filtering on `is_current` would fail to resolve exactly the
       customers grandfathering exists to protect, and they would silently
       keep whatever plan they already had. */
    const orgId = await newOrg('invoice-grandfathered');

    const retiredPrice = 'price_invoice_test_retired';
    await admin.query(
      `INSERT INTO billing.plan_prices (plan_id, interval, amount_cents, stripe_price_id, is_current, archived_at)
       VALUES ($1, 'month', 1900, $2, false, now())`,
      [BUSINESS_PLAN, retiredPrice],
    );

    await apply(orgId, {
      kind: 'subscription_activated',
      providerEventId: 'evt_grandfathered',
      customerId: 'cus_grandfathered',
      priceId: retiredPrice,
    });

    expect(await readPlanId(orgId)).toBe(BUSINESS_PLAN);
  });

  it('leaves the plan alone when the price is unknown, rather than guessing a tier', async () => {
    /* An unresolvable price is a reason to change nothing. Falling back to a
       literal would put a customer on a tier nobody sold them. */
    const orgId = await newOrg('invoice-unknown-price');
    await admin.setOrg(orgId);
    await admin.query(`UPDATE identity.orgs SET plan_id = $2 WHERE id = $1`, [orgId, PRO_PLAN]);
    await admin.setOrg(null);

    await apply(orgId, {
      kind: 'subscription_activated',
      providerEventId: 'evt_unknown',
      customerId: 'cus_unknown',
      priceId: 'price_that_does_not_exist',
    });

    expect(await readPlanId(orgId)).toBe(PRO_PLAN);
  });
});

describe('invoice recording is idempotent', () => {
  const invoiceOf = (status: 'open' | 'paid', amountPaid: number) => ({
    providerInvoiceId: 'in_replay_test',
    number: 'A1B2C3-0001',
    status,
    amountDueCents: 2900,
    amountPaidCents: amountPaid,
    currency: 'usd',
    issuedAt: new Date('2026-08-01T00:00:00Z'),
    hostedInvoiceUrl: 'https://invoice.stripe.test/in_replay_test',
  });

  it('upserts on replay instead of duplicating, and carries the new status through', async () => {
    const orgId = await newOrg('invoice-replay');

    /* The same invoice, three times, as Stripe genuinely sends it: issued,
       then paid, then a retry of the paid event because we answered slowly. */
    await apply(orgId, {
      kind: 'payment_failed',
      providerEventId: 'evt_inv_1',
      customerId: 'cus_replay',
      invoice: invoiceOf('open', 0),
    });
    await apply(orgId, {
      kind: 'payment_recovered',
      providerEventId: 'evt_inv_2',
      customerId: 'cus_replay',
      invoice: invoiceOf('paid', 2900),
    });
    await apply(orgId, {
      kind: 'payment_recovered',
      providerEventId: 'evt_inv_2',
      customerId: 'cus_replay',
      invoice: invoiceOf('paid', 2900),
    });

    const rows = await readInvoices(orgId);

    expect(rows, 'one row, not three').toHaveLength(1);
    expect(rows[0]?.status, 'the LATEST status wins').toBe('paid');
    expect(rows[0]?.amountPaidCents).toBe(2900);
  });

  it('records the invoice even when the status transition itself is a no-op', async () => {
    /* `payment_recovered` is a CONDITIONAL update — it only fires for an org
       in `past_due`, and matches zero rows otherwise. The invoice must still
       land: it is a fact about what the processor did, and a customer's
       history must not depend on whether a state machine happened to move. */
    const orgId = await newOrg('invoice-noop-transition');

    await apply(orgId, {
      kind: 'payment_recovered',
      providerEventId: 'evt_noop',
      customerId: 'cus_noop',
      invoice: {
        providerInvoiceId: 'in_noop',
        status: 'paid',
        amountDueCents: 1000,
        amountPaidCents: 1000,
        currency: 'usd',
        issuedAt: new Date('2026-08-02T00:00:00Z'),
      },
    });

    const rows = await readInvoices(orgId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.providerInvoiceId).toBe('in_noop');
  });

  it('keeps the processor’s own issue date across a replay, not our clock', async () => {
    /* `issuedAt` is deliberately NOT in the upsert's SET clause. A retry can
       arrive days late; rewriting the date on every event would reorder a
       customer's history behind whatever arrived most recently. */
    const orgId = await newOrg('invoice-issued-at');
    const issuedAt = new Date('2026-07-15T09:30:00Z');

    const invoice = {
      providerInvoiceId: 'in_issued_at',
      status: 'open' as const,
      amountDueCents: 500,
      amountPaidCents: 0,
      currency: 'usd',
      issuedAt,
    };

    await apply(orgId, {
      kind: 'payment_failed',
      providerEventId: 'evt_date_1',
      customerId: 'cus_date',
      invoice,
    });
    await apply(orgId, {
      kind: 'payment_recovered',
      providerEventId: 'evt_date_2',
      customerId: 'cus_date',
      invoice: { ...invoice, status: 'paid', amountPaidCents: 500 },
    });

    const rows = await readInvoices(orgId);
    expect(rows[0]?.issuedAt.toISOString()).toBe(issuedAt.toISOString());
  });
});
