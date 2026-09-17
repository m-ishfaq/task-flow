import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { unsafeAsId, type KeyProvider, type OrgId, type UserId } from '@taskflow/contracts';
import {
  closeDatabase,
  eq,
  initializeDatabase,
  initializeWebhookDatabase,
  schema,
  withOrgScope,
  withWebhookScope,
} from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import {
  masterKeysFromBase64,
  SoftwareKeyProvider,
  verifyWebhookSignature,
} from '@taskflow/security';
import { createWebhook, enqueueWebhookDelivery } from '@taskflow/api/automation/webhooks';
import { drainWebhookDeliveries, type DeliveryDeps } from './delivery.js';

/**
 * The webhook delivery loop (ai/phase-10-automation.md §5, Wave 2) against
 * real Postgres, with the two I/O seams injected:
 *
 *   - `fetchImpl` is a recording fake that answers locally, so no byte ever
 *     leaves the machine — and so the SSRF tests can assert the gate refused
 *     BEFORE any request was made (the `spend-gate` lesson: the assertion
 *     that matters is not that a refusal was returned, it is that the
 *     provider was never reached);
 *   - `lookup` is a fake resolver, because the delivery URL must pass
 *     `isAllowedUrl` at CREATION time (no literal IPs) and then resolve to
 *     something the gate will examine at DELIVERY time. A hostname resolving
 *     to a private address is exactly the attack this suite proves refused.
 *
 * Every test drives the REAL `drainWebhookDeliveries` through the REAL claim
 * role, the REAL encryption, and the REAL signature — a mocked claim would
 * prove the test agrees with itself.
 */

const OWNER = unsafeAsId<'UserId'>('0195ee32-0000-7000-8000-000000000001');

const requestId = unsafeAsId<'RequestId'>('0195ee32-0000-7000-8000-0000000000ff');

const MASTER_KEY_ID = 'test-master';
const keys = new SoftwareKeyProvider({
  currentMasterKeyId: MASTER_KEY_ID,
  masterKeys: masterKeysFromBase64({
    [MASTER_KEY_ID]: Buffer.alloc(32, 7).toString('base64'),
  }),
});

/* Not a literal IP — `isAllowedUrl` would refuse that at creation. The fake
   resolver below answers for it. */
const URL = 'https://hooks.example.test/on-release';

/** An address the SSRF gate accepts (not in any blocked range). */
const PUBLIC_ADDRESS = '93.184.216.34';

interface CapturedRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

/** The URL a mock received, as a string — `fetch`'s input is a union and the
    exact member types are not worth importing into a test, so the object
    forms are unwrapped duck-typed. The loop only ever sends strings: `current`
    stays a string across redirect hops, so the fallback is unreachable. */
function urlOf(input: unknown): string {
  if (typeof input === 'string') return input;
  const record = input as { readonly href?: unknown; readonly url?: unknown } | null;
  if (typeof record?.href === 'string') return record.href;
  if (typeof record?.url === 'string') return record.url;
  return '<non-string url>';
}

let admin: AdminConnection;
const created: OrgId[] = [];
let fixtureCounter = 0;

async function scaffold(slug: string): Promise<{
  orgId: OrgId;
  webhookId: string;
  signingSecret: string;
  owner: {
    readonly subject: { orgId: OrgId; userId: UserId; role: 'owner'; tuples: readonly unknown[] };
    readonly requestId: typeof requestId;
  };
}> {
  fixtureCounter += 1;
  const orgId = unsafeAsId<'OrgId'>(crypto.randomUUID());
  const userId = OWNER;

  await admin.setOrg(null);
  await admin.query(
    `INSERT INTO identity.users (id, email, email_normalized, email_verified_at)
     VALUES ($1, $2, $2, now())`,
    [userId, `webhook-${crypto.randomUUID().slice(0, 12)}@delivery.test`],
  );
  await admin.setOrg(orgId);
  await admin.query(`INSERT INTO identity.orgs (id, name, slug) VALUES ($1, $2, $3)`, [
    orgId,
    `Delivery ${slug}`,
    `wd-${fixtureCounter.toString(36)}-${slug.slice(0, 8)}-${crypto.randomUUID().slice(0, 8)}`,
  ]);
  await admin.query(
    `INSERT INTO identity.memberships (id, org_id, user_id, role, status)
     VALUES ($1, $2, $3, 'owner', 'active')`,
    [crypto.randomUUID(), orgId, userId],
  );
  await admin.setOrg(null);
  created.push(orgId);

  const owner = { subject: { orgId, userId, role: 'owner' as const, tuples: [] }, requestId };
  const { webhookId, signingSecret } = await createWebhook(owner, { name: slug, url: URL }, keys);

  return { orgId, webhookId, signingSecret, owner };
}

async function enqueue(
  webhookId: string,
  orgId: OrgId,
  name = 'card.status_changed',
): Promise<{ eventId: string; deliveryId: string }> {
  const eventId = crypto.randomUUID();
  const { deliveryId } = await enqueueWebhookDelivery(
    { subject: { orgId, userId: OWNER, role: 'owner', tuples: [] }, requestId },
    { webhookId, event: { id: eventId, name, payload: { cardId: 'c1' } } },
  );
  if (deliveryId === null) throw new Error('fresh enqueue must return a delivery id');
  return { eventId, deliveryId };
}

/** Forces a pending delivery's backoff to expire, so the next drain retries it.

    Runs as the CLAIM role, not the app role: `taskflow_app` holds SELECT and
    INSERT on `webhook_deliveries` and no UPDATE by design — the loop's role is
    the only one that may move a delivery forward. An UPDATE that fails here
    would be the grants test's job to catch, not this suite's. */
async function makeDue(orgId: OrgId, deliveryId: string): Promise<void> {
  await withWebhookScope(async (tx) => {
    await tx
      .update(schema.webhookDeliveries)
      .set({ nextAttemptAt: new Date(Date.now() - 1_000) })
      .where(eq(schema.webhookDeliveries.id, deliveryId));
  });
}

async function deliveryRow(orgId: OrgId, webhookId: string) {
  const rows = await withOrgScope(orgId, async (tx) =>
    tx
      .select({
        id: schema.webhookDeliveries.id,
        status: schema.webhookDeliveries.status,
        attempts: schema.webhookDeliveries.attempts,
        lastStatusCode: schema.webhookDeliveries.lastStatusCode,
        lastError: schema.webhookDeliveries.lastError,
        nextAttemptAt: schema.webhookDeliveries.nextAttemptAt,
      })
      .from(schema.webhookDeliveries)
      .where(eq(schema.webhookDeliveries.webhookId, webhookId)),
  );
  return rows[0];
}

async function webhookRow(orgId: OrgId, webhookId: string) {
  const rows = await withOrgScope(orgId, async (tx) =>
    tx
      .select({
        enabled: schema.webhooks.enabled,
        disabledAt: schema.webhooks.disabledAt,
        failureCount: schema.webhooks.failureCount,
        createdBy: schema.webhooks.createdBy,
      })
      .from(schema.webhooks)
      .where(eq(schema.webhooks.id, webhookId)),
  );
  return rows[0];
}

function makeDeps(
  overrides: {
    fetchImpl?: DeliveryDeps['fetchImpl'];
    lookup?: DeliveryDeps['lookup'];
    keys?: KeyProvider;
  } = {},
): { deps: DeliveryDeps; calls: CapturedRequest[] } {
  const calls: CapturedRequest[] = [];

  const deps: DeliveryDeps = {
    keys: overrides.keys ?? keys,
    fetchImpl:
      overrides.fetchImpl ??
      ((url, init) => {
        calls.push({
          url: urlOf(url),
          headers: (init?.headers as Record<string, string> | undefined) ?? {},
          body: typeof init?.body === 'string' ? init.body : '',
        });
        return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      }),
    lookup: overrides.lookup ?? (() => Promise.resolve([PUBLIC_ADDRESS])),
  };

  return { deps, calls };
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
    'platform.notifications',
    'platform.webhook_deliveries',
    'platform.webhooks',
    'identity.memberships',
  ]) {
    await admin.query(`DELETE FROM ${table} WHERE org_id = $1`, [orgId]);
  }
  await admin.query(`DELETE FROM identity.orgs WHERE id = $1`, [orgId]);
  await admin.setOrg(null);
  await admin.query(`DELETE FROM identity.users WHERE id = $1`, [OWNER]);
}

beforeAll(async () => {
  await applyMigrations();
  admin = await connectAsMigrator();

  /* Sweep residue from an aborted earlier run. */
  await admin.setOrg(null);
  await admin.query(
    `DELETE FROM identity.orgs WHERE id IN (
    SELECT org_id FROM identity.memberships WHERE user_id = $1)`,
    [OWNER],
  );
  await admin.query(`DELETE FROM identity.users WHERE id = $1`, [OWNER]);

  initializeDatabase({
    url: 'postgresql://taskflow_app:app-dev-secret@localhost:5433/taskflow_test',
    applicationName: 'taskflow-webhook-delivery-test',
  });
  initializeWebhookDatabase({
    url: 'postgresql://taskflow_webhook:webhook-dev-secret@localhost:5433/taskflow_test',
    applicationName: 'taskflow-webhook-delivery-test-claim',
  });
});

beforeEach(async () => {
  for (const orgId of created) await removeOrg(orgId);
  created.length = 0;
});

afterAll(async () => {
  for (const orgId of created) await removeOrg(orgId);
  await closeDatabase();
  await admin.setOrg(null);
  await admin.query(`DELETE FROM identity.users WHERE id = $1`, [OWNER]);
  await admin.end();
});

describe('delivering', () => {
  it('POSTs the canonical body signed with the real secret', async () => {
    const fx = await scaffold('happy');
    const { eventId } = await enqueue(fx.webhookId, fx.orgId);
    const { deps, calls } = makeDeps();

    const result = await drainWebhookDeliveries(deps);

    expect(result).toEqual({ processed: 1, delivered: 1, failed: 0, disabled: 0 });
    expect(calls).toHaveLength(1);

    const request = calls[0]!;
    expect(request.url).toBe(URL);
    expect(request.headers['content-type']).toBe('application/json');
    expect(request.headers['user-agent']).toBe('Rinavai-Webhook/1.0');

    /* The receiver's exact check, with the secret the test captured at
       creation: the signature must verify against the RAW body bytes.
       The header name is dynamic (`x-<product>-signature`), so we find
       it by pattern rather than hardcoding. */
    const body = JSON.parse(request.body) as Record<string, unknown>;
    expect(body['eventId']).toBe(eventId);
    expect(body['eventName']).toBe('card.status_changed');
    expect(body['payload']).toEqual({ cardId: 'c1' });
    const signatureHeader = Object.keys(request.headers).find((h) =>
      h.startsWith('x-') && h.endsWith('-signature'),
    );
    expect(signatureHeader).toBeDefined();
    expect(
      verifyWebhookSignature({
        secret: fx.signingSecret,
        body: request.body,
        signature: request.headers[signatureHeader!] ?? '',
        maxAgeSeconds: 300,
      }),
    ).toBe(true);

    const row = await deliveryRow(fx.orgId, fx.webhookId);
    expect(row?.status).toBe('succeeded');
    expect(row?.lastStatusCode).toBe(200);
    expect(row?.attempts).toBe(1);

    /* A success heals the endpoint's wound — the counter stays what a
       healthy endpoint has. */
    expect((await webhookRow(fx.orgId, fx.webhookId))?.failureCount).toBe(0);
  });

  it('re-checks a redirect hop and follows it when it is public', async () => {
    const fx = await scaffold('redirectok');
    await enqueue(fx.webhookId, fx.orgId);
    const { deps, calls } = makeDeps({
      fetchImpl: (url, init) => {
        calls.push({
          url: urlOf(url),
          headers: (init?.headers as Record<string, string> | undefined) ?? {},
          body: typeof init?.body === 'string' ? init.body : '',
        });
        if (calls.length === 1) {
          return Promise.resolve(
            new Response(null, {
              status: 302,
              headers: { location: 'https://hooks.example.test/final' },
            }),
          );
        }
        return Promise.resolve(new Response('ok', { status: 200 }));
      },
    });

    await drainWebhookDeliveries(deps);

    expect(calls.map((call) => call.url)).toEqual([URL, 'https://hooks.example.test/final']);
    expect((await deliveryRow(fx.orgId, fx.webhookId))?.status).toBe('succeeded');
  });

  it('refuses a redirect to a private address — the SSRF bypass, refused', async () => {
    const fx = await scaffold('redirectevil');
    await enqueue(fx.webhookId, fx.orgId);
    const { deps, calls } = makeDeps({
      fetchImpl: (url, init) => {
        calls.push({
          url: urlOf(url),
          headers: (init?.headers as Record<string, string> | undefined) ?? {},
          body: typeof init?.body === 'string' ? init.body : '',
        });
        /* The classic SSRF: the first hop passes every check, and the 302
           points at the metadata endpoint. A client following redirects with
           the gate applied only once is a fully working SSRF here. */
        return Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: 'http://169.254.169.254/latest/meta-data/' },
          }),
        );
      },
    });

    const result = await drainWebhookDeliveries(deps);

    expect(result.failed).toBe(1);
    /* THE assertion: the second hop was never fetched. The gate refused
       before any request reached the private address. */
    expect(calls).toHaveLength(1);
    /* One refusal, so the delivery is backoff-pending — the SSRF gate does
       not dead-letter on a single refusal, it just makes this attempt fail. */
    const row = await deliveryRow(fx.orgId, fx.webhookId);
    expect(row?.status).toBe('pending');
    expect(row?.attempts).toBe(1);
    expect(row?.lastError).toContain('refused to connect');
  });

  it('refuses a hostname that resolves to a private address, before any request', async () => {
    const fx = await scaffold('dnsrebind');
    await enqueue(fx.webhookId, fx.orgId);
    const { deps, calls } = makeDeps({
      /* The attack a hostname-only check cannot see: the name is public at
         CREATION and resolves to an internal address at DELIVERY. */
      lookup: () => Promise.resolve(['10.0.0.5']),
    });

    const result = await drainWebhookDeliveries(deps);

    expect(result.failed).toBe(1);
    expect(calls).toHaveLength(0);
    expect((await deliveryRow(fx.orgId, fx.webhookId))?.lastError).toContain('refused to connect');
  });
});

describe('failure, backoff, dead-letter', () => {
  it('records a failed attempt with backoff and stays pending', async () => {
    const fx = await scaffold('backoff');
    await enqueue(fx.webhookId, fx.orgId);
    const { deps } = makeDeps({
      fetchImpl: () => Promise.resolve(new Response('nope', { status: 500 })),
    });

    await drainWebhookDeliveries(deps);

    const row = await deliveryRow(fx.orgId, fx.webhookId);
    expect(row?.status).toBe('pending');
    expect(row?.attempts).toBe(1);
    expect(row?.lastStatusCode).toBe(500);
    expect(row?.lastError).toContain('500');
    /* The backoff IS the durability here: without it, a dead endpoint costs a
       claim every tick and starves the deliveries behind it. */
    expect(row!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 10_000);

    /* Not dead yet — the endpoint carries no wound. */
    expect((await webhookRow(fx.orgId, fx.webhookId))?.failureCount).toBe(0);
  });

  it('dead-letters after the attempt budget and disables the endpoint at the threshold, notifying its creator', async () => {
    const fx = await scaffold('deadletter');
    const { deliveryId } = await enqueue(fx.webhookId, fx.orgId);
    const { deps } = makeDeps({
      fetchImpl: () => Promise.resolve(new Response('nope', { status: 503 })),
    });

    /* Pre-wound the endpoint to one below the disable threshold, so this
       dead delivery crosses it — the threshold crossing is what is under
       test, not the arithmetic of the counter. */
    await admin.setOrg(fx.orgId);
    await admin.query(`UPDATE platform.webhooks SET failure_count = 4 WHERE id = $1`, [
      fx.webhookId,
    ]);
    await admin.setOrg(null);

    for (let attempt = 0; attempt < 6; attempt += 1) {
      await drainWebhookDeliveries(deps);
      if (attempt < 5) await makeDue(fx.orgId, deliveryId);
    }

    const row = await deliveryRow(fx.orgId, fx.webhookId);
    expect(row?.status).toBe('dead');
    expect(row?.attempts).toBe(6);

    const webhook = await webhookRow(fx.orgId, fx.webhookId);
    expect(webhook?.failureCount).toBe(5);
    expect(webhook?.enabled).toBe(false);
    expect(webhook?.disabledAt).not.toBeNull();

    /* The org notified — the person who set up the behaviour is the person
       who can fix it. */
    const notifications = await withOrgScope(fx.orgId, async (tx) =>
      tx
        .select({ userId: schema.notifications.userId, kind: schema.notifications.kind })
        .from(schema.notifications)
        .where(eq(schema.notifications.subjectId, fx.webhookId)),
    );
    expect(notifications).toEqual([{ userId: OWNER, kind: 'webhook.disabled' }]);

    /* The audit-log fact rides the outbox. */
    const events = await withOrgScope(fx.orgId, async (tx) =>
      tx
        .select({ name: schema.outbox.name })
        .from(schema.outbox)
        .where(eq(schema.outbox.name, 'webhook.auto_disabled')),
    );
    expect(events).toHaveLength(1);
  });

  it('a delivery whose secret cannot be decrypted fails only itself, then follows the budget', async () => {
    const fx = await scaffold('poison');
    await enqueue(fx.webhookId, fx.orgId);
    const { deps } = makeDeps({
      /* A permanent failure the receiver never sees — a missing master key
         makes decrypt throw. THE point: the throw must not abort the batch
         or strand the delivery; it is a failed attempt with a visible
         reason, and the budget path dead-letters it after six like any
         other failure. */
      keys: {
        unwrapDataKey: () => Promise.reject(new Error('master key unavailable')),
        generateDataKey: () => Promise.reject(new Error('unused in delivery')),
      } as unknown as KeyProvider,
    });

    const result = await drainWebhookDeliveries(deps);

    expect(result.failed).toBe(1);
    const row = await deliveryRow(fx.orgId, fx.webhookId);
    expect(row?.status).toBe('pending');
    expect(row?.attempts).toBe(1);
    expect(row?.lastError).toContain('master key unavailable');
  });

  it('marks a delivery dead without counting it when the endpoint was disabled first', async () => {
    const fx = await scaffold('turnedoff');
    await enqueue(fx.webhookId, fx.orgId);

    await admin.setOrg(fx.orgId);
    await admin.query(`UPDATE platform.webhooks SET enabled = false WHERE id = $1`, [fx.webhookId]);
    await admin.setOrg(null);

    const { deps } = makeDeps();
    const result = await drainWebhookDeliveries(deps);

    expect(result.failed).toBe(0);
    const row = await deliveryRow(fx.orgId, fx.webhookId);
    expect(row?.status).toBe('dead');
    expect(row?.lastError).toBe('endpoint disabled before delivery');

    /* A deliberate stop is not a wound — the counter and the bell both stay
       silent. */
    const webhook = await webhookRow(fx.orgId, fx.webhookId);
    expect(webhook?.failureCount).toBe(0);
    const notifications = await withOrgScope(fx.orgId, async (tx) =>
      tx.select({ id: schema.notifications.id }).from(schema.notifications),
    );
    expect(notifications).toHaveLength(0);
  });
});
