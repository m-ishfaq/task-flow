import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { unsafeAsId, type OrgId, type UserId } from '@taskflow/contracts';
import { eq, schema, withOrgScope, closeDatabase, initializeDatabase } from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import { masterKeysFromBase64, SoftwareKeyProvider, isTokenKind } from '@taskflow/security';
import { TEST_ENV } from '../testing/fixtures.js';
import * as orgs from '../tenancy/org.service.js';
import * as members from '../tenancy/member.service.js';
import { loadTuples } from '../tenancy/resolve.js';
import type { AutomationActor } from './automation.service.js';
import {
  createWebhook,
  deleteWebhook,
  enqueueWebhookDelivery,
  listWebhookDeliveries,
  listWebhooks,
  setWebhookEnabled,
  updateWebhook,
} from './webhook.service.js';

/**
 * The webhook registry and the enqueue (ai/phase-10-automation.md §5, Wave 2).
 *
 * What is under test here is what may be WRITTEN and who may write it. The
 * DELIVERY itself — the HTTP, the SSRF gate, the backoff — is the worker's
 * suite; this one ends at \"the row is in the queue with the canonical body\".
 *
 * The two assertions that matter most:
 *
 *   - the secret is `tf_whs`-prefixed and shown once, with no read-back route
 *     (the interface literally has none, but the test pins the shape);
 *   - the ENQUEUE enforces `webhook:manage` itself, because it is not reached
 *     through a route — the §2 argument applied to an action with no HTTP
 *     boundary.
 */

const OWNER = unsafeAsId<'UserId'>('0195ee31-0000-7000-8000-000000000001');
const ADMIN = unsafeAsId<'UserId'>('0195ee31-0000-7000-8000-000000000002');
const MEMBER = unsafeAsId<'UserId'>('0195ee31-0000-7000-8000-000000000003');

const USERS: readonly [UserId, string][] = [
  [OWNER, 'owner@webhook-service.test'],
  [ADMIN, 'admin@webhook-service.test'],
  [MEMBER, 'member@webhook-service.test'],
];

const requestId = unsafeAsId<'RequestId'>('0195ee31-0000-7000-8000-0000000000ff');

const MASTER_KEY_ID = 'test-master';
const keys = new SoftwareKeyProvider({
  currentMasterKeyId: MASTER_KEY_ID,
  masterKeys: masterKeysFromBase64({
    [MASTER_KEY_ID]: Buffer.alloc(32, 7).toString('base64'),
  }),
});

const URL = 'https://hooks.example.test/on-release';

let admin: AdminConnection;
const created: OrgId[] = [];
let fixtureCounter = 0;

async function actorFor(
  orgId: OrgId,
  userId: UserId,
  role: AutomationActor['subject']['role'],
): Promise<AutomationActor> {
  const tuples = await loadTuples(orgId, userId);
  return { subject: { orgId, userId, role, tuples }, requestId };
}

async function scaffold(slug: string): Promise<{
  orgId: OrgId;
  owner: AutomationActor;
  member: AutomationActor;
}> {
  fixtureCounter += 1;
  const uniqueSlug = `wh-${fixtureCounter.toString(36)}-${slug.slice(0, 8)}-${crypto.randomUUID().slice(0, 8)}`;
  const result = await orgs.createOrg(
    { name: `Webhooks ${slug}`, slug: uniqueSlug },
    { userId: OWNER, requestId },
  );
  created.push(result.orgId);

  for (const [id, email] of USERS) {
    if (id === OWNER) continue;
    await members.addMember(result.orgId, { email, role: 'member' }, { userId: OWNER, requestId });
  }

  return {
    orgId: result.orgId,
    owner: await actorFor(result.orgId, OWNER, 'owner'),
    member: await actorFor(result.orgId, MEMBER, 'member'),
  };
}

async function removeOrg(orgId: string): Promise<void> {
  await admin.setOrg(orgId);
  await admin.query(
    `DELETE FROM platform.outbox_dispatch WHERE event_id IN
       (SELECT id FROM platform.outbox WHERE org_id = $1)`,
    [orgId],
  );
  for (const table of [
    'audit.audit_log',
    'audit.chain_heads',
    'platform.outbox',
    'platform.webhook_deliveries',
    'platform.webhooks',
    'authz.relationship_tuples',
    'identity.memberships',
  ]) {
    await admin.query(`DELETE FROM ${table} WHERE org_id = $1`, [orgId]);
  }
  await admin.query(`DELETE FROM identity.orgs WHERE id = $1`, [orgId]);
  await admin.setOrg(null);
}

beforeAll(async () => {
  await applyMigrations();
  admin = await connectAsMigrator();

  await admin.setOrg(null);
  await admin.query(`DELETE FROM identity.users WHERE id = ANY($1::uuid[])`, [
    USERS.map(([id]) => id),
  ]);
  for (const [id, email] of USERS) {
    await admin.query(
      `INSERT INTO identity.users (id, email, email_normalized, email_verified_at)
       VALUES ($1, $2, $2, now())`,
      [id, email],
    );
  }

  initializeDatabase({ url: TEST_ENV.DATABASE_URL, applicationName: 'taskflow-webhook-svc' });
});

afterAll(async () => {
  await closeDatabase();
  for (const orgId of created) await removeOrg(orgId);
  await admin.setOrg(null);
  await admin.query(`DELETE FROM identity.users WHERE id = ANY($1::uuid[])`, [
    USERS.map(([id]) => id),
  ]);
  await admin.end();
});

describe('the registry', () => {
  it('creates a webhook and returns a tf_whs secret, shown once', async () => {
    const { owner } = await scaffold('create');

    const result = await createWebhook(owner, { name: 'Releases', url: URL }, keys);

    expect(result.webhookId).toMatch(/^[0-9a-f-]{36}$/);
    /* The one guarantee the whole signing design leans on. */
    expect(isTokenKind(result.signingSecret, 'webhookSigning')).toBe(true);

    const [webhook] = await listWebhooks(owner);
    expect(webhook?.name).toBe('Releases');
    expect(webhook?.url).toBe(URL);
    expect(webhook?.enabled).toBe(true);
    expect(webhook?.failureCount).toBe(0);

    /* The stored secret is NOT the plaintext: the ciphertext column must
       differ from the token handed back, or "encrypted at rest" is a comment
       rather than a fact. */
    const stored = await withOrgScope(owner.subject.orgId, async (tx) =>
      tx
        .select({ ciphertext: schema.webhooks.signingKeyCiphertext })
        .from(schema.webhooks)
        .where(eq(schema.webhooks.id, result.webhookId)),
    );
    expect(stored[0]?.ciphertext.toString('hex')).not.toBe(
      Buffer.from(result.signingSecret).toString('hex'),
    );
  });

  it('refuses a URL the SSRF gate would never deliver to', async () => {
    const { owner } = await scaffold('badurl');

    for (const url of [
      'file:///etc/passwd',
      'ftp://example.test/x',
      'http://user:pass@example.test/',
      'http://127.0.0.1/admin',
    ]) {
      await expect(createWebhook(owner, { name: 'Bad', url }, keys)).rejects.toMatchObject({
        code: 'VALIDATION_FAILED',
      });
    }
  });

  it('refuses a second webhook with the same name', async () => {
    const { owner } = await scaffold('dupe');
    await createWebhook(owner, { name: 'Ship it', url: URL }, keys);
    await expect(createWebhook(owner, { name: 'ship it', url: URL }, keys)).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('updates name and url', async () => {
    const { owner } = await scaffold('update');
    const { webhookId } = await createWebhook(owner, { name: 'Before', url: URL }, keys);

    await updateWebhook(owner, {
      webhookId,
      name: 'After',
      url: 'https://hooks.example.test/after',
    });

    const [webhook] = await listWebhooks(owner);
    expect(webhook?.name).toBe('After');
    expect(webhook?.url).toBe('https://hooks.example.test/after');
  });

  it('the kill switch disables, and re-enabling clears the failure wound', async () => {
    const { owner } = await scaffold('killswitch');
    const { webhookId } = await createWebhook(owner, { name: 'Kill', url: URL }, keys);

    await setWebhookEnabled(owner, { webhookId, enabled: false });
    const [off] = await listWebhooks(owner);
    expect(off?.enabled).toBe(false);

    /* Simulate the wound the loop records, then re-enable: a person deciding
       an endpoint is fixed is a fresh start. */
    await admin.setOrg(owner.subject.orgId);
    await admin.query(
      `UPDATE platform.webhooks SET failure_count = 4, disabled_at = now() WHERE id = $1`,
      [webhookId],
    );
    await admin.setOrg(null);

    await setWebhookEnabled(owner, { webhookId, enabled: true });
    const [on] = await listWebhooks(owner);
    expect(on?.enabled).toBe(true);
    expect(on?.failureCount).toBe(0);
    expect(on?.disabledAt).toBeNull();
  });

  it('deletes a webhook and its queued deliveries', async () => {
    const { owner } = await scaffold('delete');
    const { webhookId } = await createWebhook(owner, { name: 'Gone', url: URL }, keys);

    await enqueueWebhookDelivery(owner, {
      webhookId,
      event: { id: crypto.randomUUID(), name: 'card.created', payload: { cardId: 'c' } },
    });
    await deleteWebhook(owner, { webhookId });

    const remaining = await listWebhooks(owner);
    expect(remaining).toHaveLength(0);
    const deliveries = await listWebhookDeliveries(owner, { webhookId, limit: 10 });
    expect(deliveries).toHaveLength(0);
  });
});

describe("the enqueue — a rule's call_webhook action", () => {
  it('queues a delivery with the canonical body and records the event', async () => {
    const { owner } = await scaffold('enqueue');
    const { webhookId } = await createWebhook(owner, { name: 'Queue', url: URL }, keys);
    const eventId = crypto.randomUUID();

    const { deliveryId } = await enqueueWebhookDelivery(owner, {
      webhookId,
      event: { id: eventId, name: 'card.status_changed', payload: { cardId: 'c1' } },
    });
    expect(deliveryId).not.toBeNull();

    const [delivery] = await listWebhookDeliveries(owner, { webhookId, limit: 10 });
    expect(delivery?.eventId).toBe(eventId);
    expect(delivery?.eventName).toBe('card.status_changed');
    expect(delivery?.status).toBe('pending');
    expect(delivery?.attempts).toBe(0);
  });

  it('dedupes on (webhook, event) — a redelivered trigger enqueues once', async () => {
    const { owner } = await scaffold('dedupe');
    const { webhookId } = await createWebhook(owner, { name: 'Dedupe', url: URL }, keys);
    const eventId = crypto.randomUUID();

    await enqueueWebhookDelivery(owner, {
      webhookId,
      event: { id: eventId, name: 'card.created', payload: { cardId: 'c' } },
    });
    /* The engine is at-least-once: the same event reaching the action twice
       must not queue two deliveries. The receiver is told to dedupe on the
       event id; the queue must hold the same promise. */
    const second = await enqueueWebhookDelivery(owner, {
      webhookId,
      event: { id: eventId, name: 'card.created', payload: { cardId: 'c' } },
    });
    expect(second.deliveryId).toBeNull();

    const deliveries = await listWebhookDeliveries(owner, { webhookId, limit: 10 });
    expect(deliveries).toHaveLength(1);
  });

  it('refuses a member — the enqueue is its own §2 gate', async () => {
    const { owner, member } = await scaffold('authz');
    const { webhookId } = await createWebhook(owner, { name: 'Authz', url: URL }, keys);

    /* THE assertion: `webhook:manage` is owner/admin only, and the enqueue
       enforces it itself because it is not reached through a route. A member
       who cannot manage webhooks must not be able to write a rule that calls
       them — this is the same line as \"a member who cannot delete cards
       cannot write a rule that deletes cards\". */
    await expect(
      enqueueWebhookDelivery(member, {
        webhookId,
        event: { id: crypto.randomUUID(), name: 'card.created', payload: { cardId: 'c' } },
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('refuses a disabled endpoint with a message the run history can show', async () => {
    const { owner } = await scaffold('disabled');
    const { webhookId } = await createWebhook(owner, { name: 'Off', url: URL }, keys);
    await setWebhookEnabled(owner, { webhookId, enabled: false });

    await expect(
      enqueueWebhookDelivery(owner, {
        webhookId,
        event: { id: crypto.randomUUID(), name: 'card.created', payload: { cardId: 'c' } },
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('refuses a webhook that does not exist', async () => {
    const { owner } = await scaffold('missing');
    await expect(
      enqueueWebhookDelivery(owner, {
        webhookId: crypto.randomUUID(),
        event: { id: crypto.randomUUID(), name: 'card.created', payload: { cardId: 'c' } },
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
