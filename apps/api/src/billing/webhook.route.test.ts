import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { closeDatabase, initializeDatabase } from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import { unsafeAsId, type OrgId, type RequestId, type UserId } from '@taskflow/contracts';
import { buildServer } from '../server.js';
import { TEST_ENV } from '../testing/fixtures.js';
import * as orgs from '../tenancy/org.service.js';

/**
 * The inbound Stripe webhook, end to end against real Postgres and a real
 * `buildServer()` — the one suite that would catch the route registration
 * bug this file's own header found: registering a SECOND root-level
 * `application/json` content-type parser throws `FST_ERR_CTP_ALREADY_PRESENT`
 * at boot, confirmed empirically against a real Fastify instance and fixed
 * by scoping the parser to this route's own encapsulated plugin registration
 * (`webhook.routes.ts`). A unit test of `verifyInboundBillingWebhook` alone
 * would never exercise route registration and would have stayed green.
 */

const OWNER = unsafeAsId<'UserId'>('0195dd20-0000-7000-8000-000000000001');
const requestId = unsafeAsId<'RequestId'>('0195dd20-0000-7000-8000-0000000000ff');
const actorOf = (userId: UserId): { userId: UserId; requestId: RequestId } => ({
  userId,
  requestId,
});

let app: FastifyInstance;
let admin: AdminConnection;
const created: OrgId[] = [];

/**
 * A sellable plan for this suite, written directly as the migrator — the same
 * shape `org-billing.service.test.ts` uses, and for the same reason: 0063's
 * seeded `pro` deliberately carries no `plan_prices` row (a migration cannot
 * call Stripe), so `resolvePlanFromPrice` has nothing to resolve `event.priceId`
 * against unless a suite seeds one, and mutating the shared `pro` row would
 * leave every other suite reading a catalog this file changed.
 */
const TEST_PLAN = 'billing-webhook-suite-plan';
const TEST_PRICE_ID = `price_${TEST_PLAN}_month`;

async function seedCatalog(): Promise<void> {
  await clearCatalog();
  await admin.query(
    `INSERT INTO billing.plans (id, name, stripe_product_id) VALUES ($1, 'Billing Webhook Suite Plan', $2)`,
    [TEST_PLAN, `prod_${TEST_PLAN}`],
  );
  await admin.query(
    `INSERT INTO billing.plan_prices (plan_id, interval, amount_cents, stripe_price_id, is_current)
     VALUES ($1, 'month', 2900, $2, true)`,
    [TEST_PLAN, TEST_PRICE_ID],
  );
}

/** Children before parents, and idempotent — `taskflow_test` persists. */
async function clearCatalog(): Promise<void> {
  await admin.query(`DELETE FROM billing.plan_prices WHERE plan_id = $1`, [TEST_PLAN]);
  await admin.query(`DELETE FROM billing.plans WHERE id = $1`, [TEST_PLAN]);
}

async function newOrgWithCustomer(slug: string, customerId: string): Promise<OrgId> {
  const result = await orgs.createOrg({ name: `Org ${slug}`, slug }, actorOf(OWNER), {
    trialDays: 14,
  });
  created.push(result.orgId);

  // identity.orgs is FORCE RLS'd — without setOrg this UPDATE silently
  // matches zero rows, and the webhook below would 400 on an unresolvable
  // customer id instead of exercising the path under test.
  await admin.setOrg(result.orgId);
  await admin.query(`UPDATE identity.orgs SET stripe_customer_id = $2 WHERE id = $1`, [
    result.orgId,
    customerId,
  ]);
  await admin.setOrg(null);
  // billing.customer_orgs has NO RLS (migration 0059's own header) — the
  // pre-tenant lookup a webhook resolves an org THROUGH, before any scope
  // can be opened.
  await admin.query(
    `INSERT INTO billing.customer_orgs (stripe_customer_id, org_id) VALUES ($1, $2)`,
    [customerId, result.orgId],
  );

  return result.orgId;
}

/** See newOrgWithCustomer's own comment on why setOrg brackets every read here too. */
async function readOrgRow<T extends string>(
  orgId: OrgId,
  columns: readonly T[],
): Promise<Record<T, unknown>> {
  await admin.setOrg(orgId);
  const result = await admin.query(
    `SELECT ${columns.join(', ')} FROM identity.orgs WHERE id = $1`,
    [orgId],
  );
  await admin.setOrg(null);
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error(`identity.orgs has no row for ${orgId} — RLS scoping bug, not a missing org.`);
  }
  return row;
}

/** billing.webhook_events is org-scoped RLS (migration 0059) — same reasoning. */
async function webhookEventExists(orgId: OrgId, providerEventId: string): Promise<boolean> {
  await admin.setOrg(orgId);
  const result = await admin.query(
    `SELECT 1 FROM billing.webhook_events WHERE org_id = $1 AND provider_event_id = $2`,
    [orgId, providerEventId],
  );
  await admin.setOrg(null);
  return result.rowCount === 1;
}

// TEST_ENV sets this explicitly (testing/fixtures.ts) so the webhook route
// is testable at all — see this file's own header on the 404 it would
// otherwise answer.
const WEBHOOK_SECRET = TEST_ENV.STRIPE_WEBHOOK_SECRET ?? '';

function signedRequest(event: object) {
  return {
    payload: JSON.stringify(event),
    headers: {
      'content-type': 'application/json',
      'stripe-signature': `fake_signed:${WEBHOOK_SECRET}`,
    },
  };
}

beforeAll(async () => {
  await applyMigrations();
  admin = await connectAsMigrator();

  await admin.setOrg(null);
  await admin.query(`DELETE FROM identity.users WHERE id = $1`, [OWNER]);
  await admin.query(
    `INSERT INTO identity.users (id, email, email_normalized, email_verified_at)
     VALUES ($1, 'owner@billing-webhook.test', 'owner@billing-webhook.test', now())`,
    [OWNER],
  );
  await seedCatalog();

  initializeDatabase({ url: TEST_ENV.DATABASE_URL, applicationName: 'billing-webhook-test' });
  /* Without an injected `deliver`, resolveMail() (server.ts) builds a REAL
     SMTP-backed queue against TEST_ENV's MAIL_HOST — Mailpit, which CI's
     workflow does not start (only Postgres is a service there). The
     payment_failed/subscription_canceled tests below queue a real
     sendBillingMail() send, and app.close()'s onClose hook awaits the queue
     draining that send — which then hangs retrying a connection to a port
     nothing is listening on. Every other buildServer() test in this app
     injects `deliver` for the same reason; this file just never sent mail
     until Wave 4's billing-mail.ts gave it a reason to. */
  app = await buildServer({ env: TEST_ENV, deliver: () => Promise.resolve() });
});

afterAll(async () => {
  await app.close();
  // FORCE RLS means setOrg has to be scoped to THIS org inside the loop,
  // not once outside it — see newOrgWithCustomer's own comment.
  for (const orgId of created) {
    await admin.setOrg(orgId);
    await admin.query(`DELETE FROM identity.memberships WHERE org_id = $1`, [orgId]);
    await admin.query(`DELETE FROM platform.outbox WHERE org_id = $1`, [orgId]);
    // Children before parents: an activated org's plan_id may reference
    // TEST_PLAN (orgs_plan_id_fk, ON DELETE RESTRICT), so the org row has to
    // go before clearCatalog() below can remove the plan it pointed at.
    await admin.query(`DELETE FROM identity.orgs WHERE id = $1`, [orgId]);
    await admin.setOrg(null);
  }
  await admin.query(`DELETE FROM identity.users WHERE id = $1`, [OWNER]);
  await clearCatalog();
  await admin.end();
  await closeDatabase();
});

describe('POST /webhooks/billing/stripe', () => {
  it('boots without a content-type-parser registration conflict', () => {
    // The assertion is that beforeAll above did not throw. A dedicated `it`
    // makes that a named, reportable fact rather than an implicit precondition
    // of every other test in this file.
    expect(app.hasRoute({ method: 'POST', url: '/webhooks/billing/stripe' })).toBe(true);
  });

  it('refuses a request with no signature', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/billing/stripe',
      payload: JSON.stringify({ kind: 'subscription_activated' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('refuses a wrong signature', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/billing/stripe',
      payload: JSON.stringify({ kind: 'subscription_activated', providerEventId: 'evt_x' }),
      headers: { 'content-type': 'application/json', 'stripe-signature': 'fake_signed:wrong' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('refuses an unknown customer id even with a valid signature', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/billing/stripe',
      ...signedRequest({
        kind: 'subscription_activated',
        providerEventId: 'evt_unknown_customer',
        customerId: 'cus_does_not_exist',
        subscriptionId: 'sub_1',
      }),
    });
    expect(response.statusCode).toBe(400);
  });

  it('activates a subscription and emits billing.subscription_activated', async () => {
    const orgId = await newOrgWithCustomer('webhook-activate', 'cus_webhook_activate');

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/billing/stripe',
      ...signedRequest({
        kind: 'subscription_activated',
        providerEventId: 'evt_activate_1',
        customerId: 'cus_webhook_activate',
        subscriptionId: 'sub_activate_1',
        priceId: TEST_PRICE_ID,
      }),
    });
    expect(response.statusCode).toBe(200);

    const orgRow = await readOrgRow(orgId, [
      'billing_status',
      'plan_id',
      'stripe_subscription_id',
    ] as const);
    expect(orgRow.billing_status).toBe('active');
    expect(orgRow.plan_id).toBe(TEST_PLAN);
    expect(orgRow.stripe_subscription_id).toBe('sub_activate_1');

    expect(await webhookEventExists(orgId, 'evt_activate_1')).toBe(true);
  });

  it('does not re-apply a replayed event a second time', async () => {
    const orgId = await newOrgWithCustomer('webhook-replay', 'cus_webhook_replay');
    const event = signedRequest({
      kind: 'subscription_activated',
      providerEventId: 'evt_replay_1',
      customerId: 'cus_webhook_replay',
      subscriptionId: 'sub_replay_1',
    });

    const first = await app.inject({ method: 'POST', url: '/webhooks/billing/stripe', ...event });
    expect(first.statusCode).toBe(200);

    // Cancel it directly, then replay the ORIGINAL activation event — if
    // replay protection failed, this would silently re-activate the org.
    await admin.setOrg(orgId);
    await admin.query(`UPDATE identity.orgs SET billing_status = 'canceled' WHERE id = $1`, [
      orgId,
    ]);
    await admin.setOrg(null);

    const replayed = await app.inject({
      method: 'POST',
      url: '/webhooks/billing/stripe',
      ...event,
    });
    expect(replayed.statusCode).toBe(400);

    expect((await readOrgRow(orgId, ['billing_status'] as const)).billing_status).toBe('canceled');
  });

  it('moves a trialing org to past_due on payment_failed, with a grace deadline', async () => {
    const orgId = await newOrgWithCustomer('webhook-past-due', 'cus_webhook_past_due');

    const canceled = await app.inject({
      method: 'POST',
      url: '/webhooks/billing/stripe',
      ...signedRequest({
        kind: 'payment_failed',
        providerEventId: 'evt_past_due_on_trial',
        customerId: 'cus_webhook_past_due',
      }),
    });
    expect(canceled.statusCode).toBe(200);

    const orgRow = await readOrgRow(orgId, ['billing_status', 'billing_grace_ends_at'] as const);
    expect(orgRow.billing_status).toBe('past_due');
    expect(orgRow.billing_grace_ends_at).not.toBeNull();
  });

  it('cancels a subscription immediately on subscription_canceled, skipping past_due', async () => {
    const orgId = await newOrgWithCustomer('webhook-cancel', 'cus_webhook_cancel');

    const response = await app.inject({
      method: 'POST',
      url: '/webhooks/billing/stripe',
      ...signedRequest({
        kind: 'subscription_canceled',
        providerEventId: 'evt_cancel_1',
        customerId: 'cus_webhook_cancel',
      }),
    });
    expect(response.statusCode).toBe(200);

    expect((await readOrgRow(orgId, ['billing_status'] as const)).billing_status).toBe('canceled');
  });
});
