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

async function newOrgWithCustomer(slug: string, customerId: string): Promise<OrgId> {
  const result = await orgs.createOrg({ name: `Org ${slug}`, slug }, actorOf(OWNER), {
    trialDays: 14,
  });
  created.push(result.orgId);

  await admin.query(`UPDATE identity.orgs SET stripe_customer_id = $2 WHERE id = $1`, [
    result.orgId,
    customerId,
  ]);
  await admin.query(
    `INSERT INTO billing.customer_orgs (stripe_customer_id, org_id) VALUES ($1, $2)`,
    [customerId, result.orgId],
  );

  return result.orgId;
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

  initializeDatabase({ url: TEST_ENV.DATABASE_URL, applicationName: 'billing-webhook-test' });
  app = await buildServer({ env: TEST_ENV });
});

afterAll(async () => {
  await app.close();
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
      }),
    });
    expect(response.statusCode).toBe(200);

    const orgRow = await admin.query(
      `SELECT billing_status, plan_id, stripe_subscription_id FROM identity.orgs WHERE id = $1`,
      [orgId],
    );
    expect(orgRow.rows[0]?.['billing_status']).toBe('active');
    expect(orgRow.rows[0]?.['plan_id']).toBe('pro');
    expect(orgRow.rows[0]?.['stripe_subscription_id']).toBe('sub_activate_1');

    const eventRow = await admin.query(
      `SELECT 1 FROM billing.webhook_events WHERE org_id = $1 AND provider_event_id = $2`,
      [orgId, 'evt_activate_1'],
    );
    expect(eventRow.rowCount).toBe(1);
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
    await admin.query(`UPDATE identity.orgs SET billing_status = 'canceled' WHERE id = $1`, [
      orgId,
    ]);

    const replayed = await app.inject({
      method: 'POST',
      url: '/webhooks/billing/stripe',
      ...event,
    });
    expect(replayed.statusCode).toBe(400);

    const orgRow = await admin.query(`SELECT billing_status FROM identity.orgs WHERE id = $1`, [
      orgId,
    ]);
    expect(orgRow.rows[0]?.['billing_status']).toBe('canceled');
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

    const orgRow = await admin.query(
      `SELECT billing_status, billing_grace_ends_at FROM identity.orgs WHERE id = $1`,
      [orgId],
    );
    expect(orgRow.rows[0]?.['billing_status']).toBe('past_due');
    expect(orgRow.rows[0]?.['billing_grace_ends_at']).not.toBeNull();
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

    const orgRow = await admin.query(`SELECT billing_status FROM identity.orgs WHERE id = $1`, [
      orgId,
    ]);
    expect(orgRow.rows[0]?.['billing_status']).toBe('canceled');
  });
});
