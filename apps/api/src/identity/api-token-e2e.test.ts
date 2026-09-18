import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { closeDatabase, initializeApiTokenAuthDatabase, initializeDatabase, initializePlatformAdminDatabase } from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import { buildServer } from '../server.js';
import type { DeliverableLink } from '../identity/identity.service.js';
import { TEST_ENV } from '../testing/fixtures.js';
import type { Env } from '../config/env.js';

/**
 * The API-token round trip, end to end (ai/phase-10-automation.md §6.6, Wave
 * 3 slice 6). Where api-token-auth.test.ts proves the gate through the
 * in-process caller, this boots the real server and drives the real HTTP
 * pipeline: register → verify → login → create an org → mint a token (a
 * step-up route, so the session must be fresh) → drive the webhook surface
 * with the token → prove scope and org refusals → revoke → prove the
 * credential is dead. Every layer is real; only the database is test.
 *
 * The standing lesson this file answers: a credential path that has never
 * carried a real HTTP request can be green forever. The mint route could
 * agree with the auth path about the token's shape while the header dispatch
 * never reached it — nothing short of a request proves the two halves
 * connect. (The same lesson Phase 7 learned from a live carrier.)
 */

const env: Env = TEST_ENV;
const PASSWORD = 'correct horse battery staple 42';
/* The same hardcoded consumer-role URL the auth and grants suites use. */
const API_TOKEN_AUTH_URL =
  'postgresql://taskflow_api_token_auth:api-token-auth-dev-secret@localhost:5433/taskflow_test';

let app: FastifyInstance;
let admin: AdminConnection;
const deliveries: DeliverableLink[] = [];
const createdOrgs: string[] = [];

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
    'platform.api_tokens',
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

  initializeDatabase({ url: env.DATABASE_URL, applicationName: 'api-token-e2e' });
  /* The runtime initializes this connection in main.ts; a test server must do
     the same or every token request answers UNAUTHENTICATED — the auth
     path's lookup would fail closed, exactly as it would on an instance
     without DATABASE_API_TOKEN_URL. */
  initializeApiTokenAuthDatabase({
    url: API_TOKEN_AUTH_URL,
    applicationName: 'api-token-e2e-auth',
  });
  initializePlatformAdminDatabase({
    url:
      process.env['TEST_DATABASE_PLATFORM_ADMIN_URL'] ??
      'postgresql://taskflow_platform_admin:platform-admin-dev-secret@localhost:5433/taskflow_test',
    applicationName: 'api-token-e2e-admin',
  });

  app = await buildServer({
    env,
    deliver: (message) => {
      deliveries.push(message);
      return Promise.resolve();
    },
  });
});

afterAll(async () => {
  await app.close();
  await closeDatabase();
  for (const orgId of createdOrgs) await removeOrg(orgId);
  await admin.setOrg(null);
  /* identity.sessions cascades on user delete (0002), so the user alone is
     enough to take the whole login family with it. */
  await admin.query(`DELETE FROM identity.users WHERE email LIKE 'e2e-%@example.test'`);
  await admin.end();
});

/** Register → verify → login, returning a fresh access token. */
async function registerFresh(email: string): Promise<string> {
  await app.inject({
    method: 'POST',
    url: '/trpc/auth.register',
    payload: { email, password: PASSWORD, name: 'Test User' },
  });

  const link = deliveries.find(
    (message) => message.kind === 'verify_email' && message.email === email,
  );
  expect(link).toBeDefined();
  await app.inject({
    method: 'POST',
    url: '/trpc/auth.verifyEmail',
    payload: { token: link?.token ?? '' },
  });

  const response = await app.inject({
    method: 'POST',
    url: '/trpc/auth.login',
    payload: { email, password: PASSWORD },
  });
  const body: { result?: { data?: { accessToken?: string } } } = response.json();
  const accessToken = body.result?.data?.accessToken ?? '';
  expect(accessToken).not.toBe('');
  return accessToken;
}

describe('the API-token round trip over HTTP', () => {
  it('mint → use → scope refusal → org refusal → quota → revoke → dead, all through real routes', async () => {
    const session = await registerFresh(`e2e-${crypto.randomUUID().slice(0, 8)}@example.test`);

    /* The org — created by the session, which becomes its owner. */
    const orgResponse = await app.inject({
      method: 'POST',
      url: '/trpc/tenancy.orgs.create',
      headers: { authorization: `Bearer ${session}` },
      payload: { name: 'E2E Org', slug: `e2e-${crypto.randomUUID().slice(0, 8)}` },
    });
    expect(orgResponse.statusCode).toBe(200);
    /* `app.inject().json()` is `any`; the status assertion above is what
       guarantees these fields exist, and the typed body keeps the lint rules
       honest about it (the same shape server.test.ts uses). */
    const orgBody: { result: { data: { orgId: string } } } = orgResponse.json();
    const orgId: string = orgBody.result.data.orgId;
    createdOrgs.push(orgId);

    /* Mint — a step-up route, passed because the login is fresh. The router
       is mounted at the root (`apiToken:`), so the procedure path is
       `apiToken.create` — the `api.` in the client's `api.apiToken` is the
       tRPC client namespace, not a route segment. */
    const mint = await app.inject({
      method: 'POST',
      url: '/trpc/apiToken.create',
      headers: { authorization: `Bearer ${session}`, 'x-rinavai-org': orgId },
      payload: { name: 'Release CI', scopes: ['webhook:manage'] },
    });
    expect(mint.statusCode).toBe(200);
    const mintBody: { result: { data: { token: string; tokenId: string } } } = mint.json();
    const token: string = mintBody.result.data.token;
    const tokenId: string = mintBody.result.data.tokenId;
    expect(token.startsWith('tf_pat_')).toBe(true);

    /* The token drives the webhook surface with NO org header — the org comes
       from the token row, never from anything the client says. */
    const create = await app.inject({
      method: 'POST',
      url: '/trpc/automation.webhooks.create',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Release', url: 'https://hooks.example.test/release' },
    });
    expect(create.statusCode).toBe(200);
    const createBody: { result: { data: { signingSecret?: string } } } = create.json();
    expect(typeof createBody.result.data.signingSecret).toBe('string');

    const list = await app.inject({
      method: 'GET',
      url: '/trpc/automation.webhooks.list?input={}',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(list.statusCode).toBe(200);
    const listBody: {
      result: {
        data: { webhooks: { webhookId: string; name: string }[]; nextCursor: string | null };
      };
    } = list.json();
    const webhooks = listBody.result.data.webhooks;
    expect(webhooks.some((webhook) => webhook.name === 'Release')).toBe(true);

    /* The durable quota counter moved — a Postgres row, not an in-process
       window a restart would forgive. The token has made at least two
       requests (create + list). */
    await admin.setOrg(orgId);
    const quota = await admin.query(
      `SELECT used_count::int AS used FROM platform.api_token_quota WHERE token_id = $1`,
      [tokenId],
    );
    expect(Number(quota.rows[0]?.['used'])).toBeGreaterThanOrEqual(2);
    await admin.setOrg(null);

    /* A second token, scoped only for cards, is refused on the webhook
       surface — the scope intersection, over real HTTP. */
    const narrow = await app.inject({
      method: 'POST',
      url: '/trpc/apiToken.create',
      headers: { authorization: `Bearer ${session}`, 'x-rinavai-org': orgId },
      payload: { name: 'Narrow', scopes: ['card:read'] },
    });
    expect(narrow.statusCode).toBe(200);
    const narrowBody: { result: { data: { token: string } } } = narrow.json();
    const narrowToken: string = narrowBody.result.data.token;

    const refused = await app.inject({
      method: 'GET',
      url: '/trpc/automation.webhooks.list?input={}',
      headers: { authorization: `Bearer ${narrowToken}` },
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: { data: { code: 'FORBIDDEN' } } });

    /* A header that disagrees with the token's org is a REFUSAL, not a
       redirect (decision 11) — a token minted for org A must not be steerable
       at org B by sending a header. */
    const steered = await app.inject({
      method: 'GET',
      url: '/trpc/automation.webhooks.list?input={}',
      headers: { authorization: `Bearer ${token}`, 'x-rinavai-org': crypto.randomUUID() },
    });
    expect(steered.statusCode).toBe(401);
    expect(steered.json()).toMatchObject({ error: { data: { code: 'UNAUTHENTICATED' } } });

    /* Revoke through the session (step-up), and the credential dies on the
       very next request — the lookup's WHERE carries revoked_at IS NULL. */
    const revoke = await app.inject({
      method: 'POST',
      url: '/trpc/apiToken.revoke',
      headers: { authorization: `Bearer ${session}`, 'x-rinavai-org': orgId },
      payload: { tokenId },
    });
    expect(revoke.statusCode).toBe(200);

    const after = await app.inject({
      method: 'GET',
      url: '/trpc/automation.webhooks.list?input={}',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(after.statusCode).toBe(401);
  });
});
