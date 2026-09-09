import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { unsafeAsId, type CardId, type OrgId, type UserId } from '@taskflow/contracts';
import { closeDatabase, initializeDatabase, initializeIntegrationAuthDatabase } from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import {
  encryptString,
  masterKeysFromBase64,
  signGitHubRequest,
  signSlackRequest,
  SoftwareKeyProvider,
} from '@taskflow/security';
import type { Subject } from '@taskflow/policy';
import { TEST_ENV } from '../testing/fixtures.js';
import * as orgs from '../tenancy/org.service.js';
import { loadTuples } from '../tenancy/resolve.js';
import * as projects from '../work/project.service.js';
import * as boards from '../work/board.service.js';
import * as lists from '../work/list.service.js';
import * as cards from '../work/card.service.js';
import { linkCardPullRequest } from '../work/card-pull-request.service.js';
import type { WorkActor } from '../work/shared.js';
import {
  registerIntegrationWebhooks,
  type IntegrationWebhookDeps,
} from './integration-webhooks.js';
import { integrationTokenAad } from './integration.service.js';

/**
 * Inbound connector ingestion (ai/phase-10-automation.md §7.3–§7.5, slice 3).
 *
 * What is under test is the ORDER OF OPERATIONS, which is the control:
 *
 *   - Slack verifies with the deployment-wide secret FIRST (freshness window
 *     included), and only then resolves team_id → org; a revoked workspace
 *     answers 404 like an unknown one;
 *   - GitHub resolves the org from the UNVERIFIED body's repository
 *     full_name, then verifies against THAT org's stored secret, and the
 *     X-GitHub-Delivery dedupe row is written on SUCCESS in the handler's
 *     own transaction — a replay answers 403 having written nothing;
 *   - both routes refuse BEFORE any write on every rejection, and every
 *     verified event lands in the org's outbox as a synthetic trigger.
 *
 * The signatures are GENUINELY computed (signSlackRequest/signGitHubRequest),
 * never stubbed — a webhook test whose signature check is mocked asserts that
 * the handler works on trusted input, which is the one case it is not
 * defending against. The Fastify instances are BARE and keep the built-in
 * default json parser: the scoped raw-body parser inside
 * `registerIntegrationWebhooks` is the only thing that makes `request.body`
 * arrive as the raw string the signatures cover. A harness that installed
 * its own string parser would mask a missing one and the suite would pass
 * while every real delivery failed (the exact failure the plugin's comment
 * warns about), so this suite deliberately supplies nothing.
 */

const OWNER = unsafeAsId<'UserId'>('0195ee32-0000-7000-8000-0000000000a1');

const MASTER_KEY_ID = 'test-master';
const keys = new SoftwareKeyProvider({
  currentMasterKeyId: MASTER_KEY_ID,
  masterKeys: masterKeysFromBase64({
    [MASTER_KEY_ID]: Buffer.alloc(32, 7).toString('base64'),
  }),
});

const SLACK_SIGNING_SECRET = 'test-slack-signing-secret';
const GITHUB_VERIFY_SECRET = 'ghs_test_verify_secret_0123456789abcdef';

let admin: AdminConnection;
let app: FastifyInstance;
const created: OrgId[] = [];
let fixtureCounter = 0;

async function scaffold(slug: string): Promise<OrgId> {
  fixtureCounter += 1;
  const uniqueSlug = `wh-${fixtureCounter.toString(36)}-${slug.slice(0, 8)}-${crypto.randomUUID().slice(0, 8)}`;
  const result = await orgs.createOrg(
    { name: `Webhooks ${slug}`, slug: uniqueSlug },
    { userId: OWNER, requestId: unsafeAsId<'RequestId'>('0195ee32-0000-7000-8000-0000000000ff') },
  );
  created.push(result.orgId);
  return result.orgId;
}

/** Inserts a connector row as the migrator — the webhook routes never connect one. */
async function insertConnector(input: {
  readonly orgId: string;
  readonly provider: 'slack' | 'github';
  readonly providerScope: string;
  readonly status: 'connected' | 'disconnected';
  readonly verifySecret?: string;
}): Promise<void> {
  const integrationId = crypto.randomUUID();
  let verifyCiphertext: Buffer | null = null;
  let verifyWrapped: Buffer | null = null;
  let verifyMasterId: string | null = null;

  if (input.verifySecret !== undefined) {
    const dataKey = await keys.generateDataKey({ orgId: input.orgId });
    verifyCiphertext = Buffer.from(
      encryptString(
        dataKey.plaintext.key,
        input.verifySecret,
        integrationTokenAad(input.orgId, integrationId),
      ),
    );
    verifyWrapped = Buffer.from(dataKey.wrapped.wrapped);
    verifyMasterId = dataKey.wrapped.masterKeyId;
  }

  await admin.setOrg(input.orgId);
  await admin.query(
    `INSERT INTO platform.integrations
       (id, org_id, provider, name, provider_scope, status,
        verify_ciphertext, verify_wrapped, verify_master_id, created_by, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())`,
    [
      integrationId,
      input.orgId,
      input.provider,
      input.providerScope,
      input.providerScope,
      input.status,
      verifyCiphertext,
      verifyWrapped,
      verifyMasterId,
      OWNER,
    ],
  );
  await admin.setOrg(null);
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
    'platform.integration_deliveries',
    'platform.integrations',
    'authz.relationship_tuples',
    'identity.memberships',
  ]) {
    await admin.query(`DELETE FROM ${table} WHERE org_id = $1`, [orgId]);
  }
  await admin.query(`DELETE FROM identity.orgs WHERE id = $1`, [orgId]);
  await admin.setOrg(null);
}

/** The org's connector-trigger events, in order. */
async function triggerEvents(
  orgId: string,
): Promise<{ name: string; payload: Record<string, unknown> }[]> {
  await admin.setOrg(orgId);
  const result = await admin.query(
    `SELECT name, payload FROM platform.outbox
     WHERE org_id = $1 AND name LIKE 'integration.%' ORDER BY occurred_at`,
    [orgId],
  );
  await admin.setOrg(null);
  return result.rows as { name: string; payload: Record<string, unknown> }[];
}

/** Every outbox row for the org, unfiltered — `triggerEvents`'s own
    `LIKE 'integration.%'` excludes the `card.pull_request_*` events the
    pull_request derivatives below emit, which are ordinary card events, not
    connector-trigger ones. */
async function allEvents(
  orgId: string,
): Promise<{ name: string; payload: Record<string, unknown> }[]> {
  await admin.setOrg(orgId);
  const result = await admin.query(
    `SELECT name, payload FROM platform.outbox WHERE org_id = $1 ORDER BY occurred_at`,
    [orgId],
  );
  await admin.setOrg(null);
  return result.rows as { name: string; payload: Record<string, unknown> }[];
}

async function actorFor(orgId: OrgId, userId: UserId, role: Subject['role']): Promise<WorkActor> {
  const tuples = await loadTuples(orgId, userId);
  return {
    subject: { orgId, userId, role, tuples },
    requestId: unsafeAsId<'RequestId'>('0195ee32-0000-7000-8000-0000000000ff'),
  };
}

/** A real project/board/list/card, for the `pull_request` derivative tests
    below — the only tests in this file that need a real Work hierarchy
    rather than just an org and a connector row. */
async function cardFixture(
  orgId: OrgId,
): Promise<{ owner: WorkActor; cardId: CardId; reference: string }> {
  const owner = await actorFor(orgId, OWNER, 'owner');
  const project = await projects.createProject(owner, {
    name: 'Website',
    key: `W${fixtureCounter.toString(36).toUpperCase()}`,
    description: null,
  });
  const board = await boards.createBoard(owner, { projectId: project.projectId, name: 'Delivery' });
  const list = await lists.createList(owner, {
    boardId: board.boardId,
    name: 'Todo',
    wipLimit: null,
  });
  const card = await cards.createCard(owner, {
    listId: list.listId,
    title: 'Fix login bug',
    description: null,
  });
  return { owner, cardId: card.cardId, reference: card.reference };
}

async function deliveryRows(orgId: string): Promise<number> {
  await admin.setOrg(orgId);
  const result = await admin.query(
    `SELECT count(*)::int AS n FROM platform.integration_deliveries WHERE org_id = $1`,
    [orgId],
  );
  await admin.setOrg(null);
  return (result.rows[0] as { n: number }).n;
}

beforeAll(async () => {
  await applyMigrations();
  admin = await connectAsMigrator();

  await admin.setOrg(null);
  await admin.query(`DELETE FROM identity.users WHERE id = $1`, [OWNER]);
  await admin.query(
    `INSERT INTO identity.users (id, email, email_normalized, email_verified_at)
     VALUES ($1, $2, $2, now())`,
    [OWNER, 'owner@integration-webhooks.test'],
  );

  initializeDatabase({
    url: TEST_ENV.DATABASE_URL,
    applicationName: 'taskflow-integration-webhooks',
  });
  initializeIntegrationAuthDatabase({
    url: 'postgresql://taskflow_integration_auth:integration-auth-dev-secret@localhost:5433/taskflow_test',
    applicationName: 'taskflow-integration-webhooks-auth',
  });

  const deps: IntegrationWebhookDeps = { keys, slackSigningSecret: SLACK_SIGNING_SECRET };
  app = Fastify();
  /* Deliberately NO parser here: the plugin must provide it. Registering a
     string parser at the root here would (a) make the child scope's own
     addContentTypeParser throw FST_ERR_CTP_ALREADY_PRESENT — fastify copies
     the parent's parser map into every child scope, so a root-level custom
     json parser is inherited and redefining it in the child is an error —
     and (b) hide the plugin's parser behind the harness's, so the suite
     would pass even if the plugin's were deleted. Bare Fastify with the
     default parser is the honest fixture. */
  registerIntegrationWebhooks(app, deps);
  await app.ready();
});

afterAll(async () => {
  await closeDatabase();
  for (const orgId of created) await removeOrg(orgId);
  await admin.setOrg(null);
  await admin.query(`DELETE FROM identity.users WHERE id = $1`, [OWNER]);
  await app.close();
  await admin.end();
});

/** A timestamp inside the freshness window. */
function nowSeconds(): string {
  return String(Math.floor(Date.now() / 1000));
}

function slackBody(teamId: string, eventType = 'message'): string {
  return JSON.stringify({
    token: 'xoxb-legacy-verification-token',
    team_id: teamId,
    type: 'event_callback',
    event: { type: eventType, channel: 'C123', text: 'hello' },
  });
}

function githubBody(fullName = 'acme/todo', extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ...extra,
    repository: { full_name: fullName },
  });
}

describe('the Slack route — verify first, resolve second', () => {
  it('emits a synthetic trigger for a connected workspace', async () => {
    const orgId = await scaffold('slack-ok');
    await insertConnector({
      orgId,
      provider: 'slack',
      providerScope: 'T0001',
      status: 'connected',
    });

    const body = slackBody('T0001', 'message');
    const response = await app.inject({
      method: 'POST',
      url: '/integrations/slack',
      headers: {
        'content-type': 'application/json',
        'x-slack-signature': signSlackRequest({
          timestamp: nowSeconds(),
          body,
          signingSecret: SLACK_SIGNING_SECRET,
        }),
        'x-slack-request-timestamp': nowSeconds(),
      },
      payload: body,
    });

    expect(response.statusCode).toBe(204);

    const events = await triggerEvents(orgId);
    expect(events.map((event) => event.name)).toEqual(['integration.slack_event']);
    expect(events[0]?.payload).toMatchObject({
      providerScope: 'T0001',
      providerEvent: 'message',
    });
    const nested = events[0]?.payload['payload'] as Record<string, unknown>;
    expect(nested['event']).toMatchObject({ type: 'message', text: 'hello' });
  });

  it('answers the url_verification challenge without emitting anything', async () => {
    const orgId = await scaffold('slack-challenge');

    const body = JSON.stringify({
      type: 'url_verification',
      challenge: 'challenge-123',
      token: 'x',
    });
    const response = await app.inject({
      method: 'POST',
      url: '/integrations/slack',
      headers: {
        'content-type': 'application/json',
        'x-slack-signature': signSlackRequest({
          timestamp: nowSeconds(),
          body,
          signingSecret: SLACK_SIGNING_SECRET,
        }),
        'x-slack-request-timestamp': nowSeconds(),
      },
      payload: body,
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('challenge-123');
    expect(await triggerEvents(orgId)).toHaveLength(0);
  });

  it('refuses a tampered body — the signature does not match the bytes sent', async () => {
    const orgId = await scaffold('slack-tampered');
    await insertConnector({
      orgId,
      provider: 'slack',
      providerScope: 'T0002',
      status: 'connected',
    });

    const original = slackBody('T0002');
    const tampered = original.replace('hello', 'goodbye');
    const response = await app.inject({
      method: 'POST',
      url: '/integrations/slack',
      headers: {
        'content-type': 'application/json',
        'x-slack-signature': signSlackRequest({
          timestamp: nowSeconds(),
          body: original,
          signingSecret: SLACK_SIGNING_SECRET,
        }),
        'x-slack-request-timestamp': nowSeconds(),
      },
      payload: tampered,
    });

    expect(response.statusCode).toBe(403);
    expect(await triggerEvents(orgId)).toHaveLength(0);
  });

  it('refuses a stale timestamp — the freshness window is the replay control', async () => {
    const orgId = await scaffold('slack-stale');
    await insertConnector({
      orgId,
      provider: 'slack',
      providerScope: 'T0003',
      status: 'connected',
    });

    const body = slackBody('T0003');
    const stale = String(Math.floor(Date.now() / 1000) - 600);
    const response = await app.inject({
      method: 'POST',
      url: '/integrations/slack',
      headers: {
        'content-type': 'application/json',
        'x-slack-signature': signSlackRequest({
          timestamp: stale,
          body,
          signingSecret: SLACK_SIGNING_SECRET,
        }),
        'x-slack-request-timestamp': stale,
      },
      payload: body,
    });

    expect(response.statusCode).toBe(403);
    expect(await triggerEvents(orgId)).toHaveLength(0);
  });

  it('refuses an unknown team — 404, indistinguishable from a revoked one', async () => {
    const orgId = await scaffold('slack-unknown');

    const body = slackBody('T9999');
    const response = await app.inject({
      method: 'POST',
      url: '/integrations/slack',
      headers: {
        'content-type': 'application/json',
        'x-slack-signature': signSlackRequest({
          timestamp: nowSeconds(),
          body,
          signingSecret: SLACK_SIGNING_SECRET,
        }),
        'x-slack-request-timestamp': nowSeconds(),
      },
      payload: body,
    });

    expect(response.statusCode).toBe(404);
    expect(await triggerEvents(orgId)).toHaveLength(0);
  });

  it('refuses a disconnected workspace — disconnect stops inbound Slack traffic', async () => {
    const orgId = await scaffold('slack-disconnected');
    await insertConnector({
      orgId,
      provider: 'slack',
      providerScope: 'T0004',
      status: 'disconnected',
    });

    const body = slackBody('T0004');
    const response = await app.inject({
      method: 'POST',
      url: '/integrations/slack',
      headers: {
        'content-type': 'application/json',
        'x-slack-signature': signSlackRequest({
          timestamp: nowSeconds(),
          body,
          signingSecret: SLACK_SIGNING_SECRET,
        }),
        'x-slack-request-timestamp': nowSeconds(),
      },
      payload: body,
    });

    expect(response.statusCode).toBe(404);
    expect(await triggerEvents(orgId)).toHaveLength(0);
  });

  it('refuses an unsigned request before parsing anything', async () => {
    const orgId = await scaffold('slack-unsigned');

    const response = await app.inject({
      method: 'POST',
      url: '/integrations/slack',
      headers: { 'content-type': 'application/json' },
      payload: slackBody('T0005'),
    });

    expect(response.statusCode).toBe(403);
    expect(await triggerEvents(orgId)).toHaveLength(0);
  });

  it('answers 503 when the deployment has no signing secret — fail-closed', async () => {
    const bare = Fastify();
    registerIntegrationWebhooks(bare, { keys, slackSigningSecret: undefined });
    await bare.ready();

    const body = slackBody('T0006');
    const response = await bare.inject({
      method: 'POST',
      url: '/integrations/slack',
      headers: {
        'content-type': 'application/json',
        'x-slack-signature': signSlackRequest({
          timestamp: nowSeconds(),
          body,
          signingSecret: SLACK_SIGNING_SECRET,
        }),
        'x-slack-request-timestamp': nowSeconds(),
      },
      payload: body,
    });

    expect(response.statusCode).toBe(503);
    await bare.close();
  });

  it('drops the deprecated legacy token field from the stored payload', async () => {
    const orgId = await scaffold('slack-token');
    await insertConnector({
      orgId,
      provider: 'slack',
      providerScope: 'T0007',
      status: 'connected',
    });

    const body = slackBody('T0007');
    const response = await app.inject({
      method: 'POST',
      url: '/integrations/slack',
      headers: {
        'content-type': 'application/json',
        'x-slack-signature': signSlackRequest({
          timestamp: nowSeconds(),
          body,
          signingSecret: SLACK_SIGNING_SECRET,
        }),
        'x-slack-request-timestamp': nowSeconds(),
      },
      payload: body,
    });

    expect(response.statusCode).toBe(204);
    const events = await triggerEvents(orgId);
    const stored = events[0]?.payload['payload'] as Record<string, unknown>;
    expect(stored['token']).toBeUndefined();
    expect(stored['team_id']).toBe('T0007');
  });
});

describe('the GitHub route — resolve first, verify second, dedupe on success', () => {
  it('emits a synthetic trigger for a connected repo, verified with the org secret', async () => {
    const orgId = await scaffold('github-ok');
    await insertConnector({
      orgId,
      provider: 'github',
      providerScope: 'acme/todo-ok',
      status: 'connected',
      verifySecret: GITHUB_VERIFY_SECRET,
    });

    const body = githubBody('acme/todo-ok');
    const response = await app.inject({
      method: 'POST',
      url: '/integrations/github',
      headers: {
        'content-type': 'application/json',
        'x-github-delivery': 'uuid-delivery-1',
        'x-github-event': 'push',
        'x-hub-signature-256': signGitHubRequest({ secret: GITHUB_VERIFY_SECRET, body }),
      },
      payload: body,
    });

    expect(response.statusCode).toBe(204);

    const events = await triggerEvents(orgId);
    expect(events.map((event) => event.name)).toEqual(['integration.github_event']);
    expect(events[0]?.payload).toMatchObject({
      providerScope: 'acme/todo-ok',
      providerEvent: 'push',
    });
    expect(await deliveryRows(orgId)).toBe(1);
  });

  it('refuses a wrong secret — and writes nothing, not even the dedupe row', async () => {
    const orgId = await scaffold('github-wrong-secret');
    await insertConnector({
      orgId,
      provider: 'github',
      providerScope: 'acme/todo-wrong',
      status: 'connected',
      verifySecret: GITHUB_VERIFY_SECRET,
    });

    const body = githubBody('acme/todo-wrong');
    const response = await app.inject({
      method: 'POST',
      url: '/integrations/github',
      headers: {
        'content-type': 'application/json',
        'x-github-delivery': 'uuid-delivery-2',
        'x-github-event': 'push',
        'x-hub-signature-256': signGitHubRequest({ secret: 'wrong-secret', body }),
      },
      payload: body,
    });

    expect(response.statusCode).toBe(403);
    expect(await triggerEvents(orgId)).toHaveLength(0);
    expect(await deliveryRows(orgId)).toBe(0);
  });

  it('refuses an unknown repo — the same 403 a wrong secret gets, so the lookup is no oracle', async () => {
    const orgId = await scaffold('github-unknown');

    const body = githubBody('acme/nowhere');
    const response = await app.inject({
      method: 'POST',
      url: '/integrations/github',
      headers: {
        'content-type': 'application/json',
        'x-github-delivery': 'uuid-delivery-3',
        'x-github-event': 'push',
        'x-hub-signature-256': signGitHubRequest({ secret: GITHUB_VERIFY_SECRET, body }),
      },
      payload: body,
    });

    /* The lookup runs before verification (it selects WHICH secret to check),
       so an unauthenticated attacker could probe which repos are connected if
       the refusals differed — they do not. */
    expect(response.statusCode).toBe(403);
    expect(await triggerEvents(orgId)).toHaveLength(0);
  });

  it('refuses a payload with no recognizable repository — never silently dropped', async () => {
    const orgId = await scaffold('github-norepo');

    const body = JSON.stringify({ zen: 'Practicality beats purity.' });
    const response = await app.inject({
      method: 'POST',
      url: '/integrations/github',
      headers: {
        'content-type': 'application/json',
        'x-github-delivery': 'uuid-delivery-4',
        'x-github-event': 'push',
        'x-hub-signature-256': signGitHubRequest({ secret: GITHUB_VERIFY_SECRET, body }),
      },
      payload: body,
    });

    /* 400, not 403: a body with no repo at all cannot probe which repos are
       connected, so it answers as the malformed request it is. */
    expect(response.statusCode).toBe(400);
    expect(await triggerEvents(orgId)).toHaveLength(0);
  });

  it('refuses a replayed delivery — one event, one dedupe row, second 403', async () => {
    const orgId = await scaffold('github-replay');
    await insertConnector({
      orgId,
      provider: 'github',
      providerScope: 'acme/todo-replay',
      status: 'connected',
      verifySecret: GITHUB_VERIFY_SECRET,
    });

    const body = githubBody('acme/todo-replay');
    const headers = {
      'content-type': 'application/json',
      'x-github-delivery': 'uuid-delivery-5',
      'x-github-event': 'push',
      'x-hub-signature-256': signGitHubRequest({ secret: GITHUB_VERIFY_SECRET, body }),
    };
    const inject = () =>
      app.inject({ method: 'POST', url: '/integrations/github', headers, payload: body });

    const first = await inject();
    const second = await inject();

    expect(first.statusCode).toBe(204);
    expect(second.statusCode).toBe(403);
    expect(await triggerEvents(orgId)).toHaveLength(1);
    expect(await deliveryRows(orgId)).toBe(1);
  });

  it('refuses a revoked row — the wiped verify secret leaves nothing to check', async () => {
    const orgId = await scaffold('github-revoked');
    await insertConnector({
      orgId,
      provider: 'github',
      providerScope: 'acme/todo-revoked',
      status: 'disconnected',
    });

    const body = githubBody('acme/todo-revoked');
    const response = await app.inject({
      method: 'POST',
      url: '/integrations/github',
      headers: {
        'content-type': 'application/json',
        'x-github-delivery': 'uuid-delivery-6',
        'x-github-event': 'push',
        'x-hub-signature-256': signGitHubRequest({ secret: GITHUB_VERIFY_SECRET, body }),
      },
      payload: body,
    });

    /* Same 403 as an unknown repo — revoked is indistinguishable from never
       connected. */
    expect(response.statusCode).toBe(403);
    expect(await triggerEvents(orgId)).toHaveLength(0);
    expect(await deliveryRows(orgId)).toBe(0);
  });

  it('refuses a request with no delivery id — no replay control, no processing', async () => {
    const orgId = await scaffold('github-nodelivery');
    await insertConnector({
      orgId,
      provider: 'github',
      providerScope: 'acme/todo-nodelivery',
      status: 'connected',
      verifySecret: GITHUB_VERIFY_SECRET,
    });

    const body = githubBody('acme/todo-nodelivery');
    const response = await app.inject({
      method: 'POST',
      url: '/integrations/github',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'push',
        'x-hub-signature-256': signGitHubRequest({ secret: GITHUB_VERIFY_SECRET, body }),
      },
      payload: body,
    });

    expect(response.statusCode).toBe(400);
    expect(await triggerEvents(orgId)).toHaveLength(0);
  });

  it("a secret from one org cannot verify another org's row", async () => {
    const a = await scaffold('github-cross-a');
    const b = await scaffold('github-cross-b');
    await insertConnector({
      orgId: a,
      provider: 'github',
      providerScope: 'acme/public',
      status: 'connected',
      verifySecret: GITHUB_VERIFY_SECRET,
    });
    await insertConnector({
      orgId: b,
      provider: 'github',
      providerScope: 'acme/private',
      status: 'connected',
      verifySecret: 'ghs_test_verify_secret_9999999999999999',
    });

    /* A body naming org B's repo, signed with org A's secret: the lookup
       resolves to org B (deterministic — distinct repo names), and the
       signature check against B's stored secret fails. */
    const body = githubBody('acme/private');
    const response = await app.inject({
      method: 'POST',
      url: '/integrations/github',
      headers: {
        'content-type': 'application/json',
        'x-github-delivery': 'uuid-delivery-7',
        'x-github-event': 'push',
        'x-hub-signature-256': signGitHubRequest({ secret: GITHUB_VERIFY_SECRET, body }),
      },
      payload: body,
    });

    expect(response.statusCode).toBe(403);
    expect(await triggerEvents(a)).toHaveLength(0);
    expect(await triggerEvents(b)).toHaveLength(0);
    expect(await deliveryRows(b)).toBe(0);
  });
});

/**
 * The `pull_request` derivatives (§7.2's last documented automation gap) —
 * end-to-end WIRING tests. `card-pull-request.service.test.ts` already
 * covers `notifyPullRequestMerged`/`autoLinkPullRequestFromBranchName`'s own
 * edge cases directly; what only a real POST through this route proves is
 * that a `pull_request` webhook delivery actually reaches them, in the SAME
 * transaction as the delivery-dedupe row and `integration.github_event`.
 */
describe('the GitHub route — pull_request derivatives', () => {
  it('a merged PR fans out card.pull_request_merged to its linked card', async () => {
    const orgId = await scaffold('github-pr-merged');
    await insertConnector({
      orgId,
      provider: 'github',
      providerScope: 'acme/merged-repo',
      status: 'connected',
      verifySecret: GITHUB_VERIFY_SECRET,
    });
    const fixture = await cardFixture(orgId);
    await linkCardPullRequest(fixture.owner, {
      cardId: fixture.cardId,
      providerScope: 'acme/merged-repo',
      prNumber: 42,
    });

    const body = githubBody('acme/merged-repo', {
      action: 'closed',
      pull_request: { number: 42, merged: true },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/integrations/github',
      headers: {
        'content-type': 'application/json',
        'x-github-delivery': 'uuid-delivery-pr-merged-1',
        'x-github-event': 'pull_request',
        'x-hub-signature-256': signGitHubRequest({ secret: GITHUB_VERIFY_SECRET, body }),
      },
      payload: body,
    });

    expect(response.statusCode).toBe(204);
    const events = await allEvents(orgId);
    const merged = events.filter((event) => event.name === 'card.pull_request_merged');
    expect(merged).toHaveLength(1);
    expect(merged[0]?.payload).toMatchObject({
      cardId: fixture.cardId,
      providerScope: 'acme/merged-repo',
      prNumber: 42,
    });
  });

  it('a PR closed WITHOUT merging emits nothing beyond the generic github_event', async () => {
    const orgId = await scaffold('github-pr-closed-unmerged');
    await insertConnector({
      orgId,
      provider: 'github',
      providerScope: 'acme/closed-repo',
      status: 'connected',
      verifySecret: GITHUB_VERIFY_SECRET,
    });
    const fixture = await cardFixture(orgId);
    await linkCardPullRequest(fixture.owner, {
      cardId: fixture.cardId,
      providerScope: 'acme/closed-repo',
      prNumber: 43,
    });

    const body = githubBody('acme/closed-repo', {
      action: 'closed',
      pull_request: { number: 43, merged: false },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/integrations/github',
      headers: {
        'content-type': 'application/json',
        'x-github-delivery': 'uuid-delivery-pr-closed-1',
        'x-github-event': 'pull_request',
        'x-hub-signature-256': signGitHubRequest({ secret: GITHUB_VERIFY_SECRET, body }),
      },
      payload: body,
    });

    expect(response.statusCode).toBe(204);
    const events = await allEvents(orgId);
    expect(events.filter((event) => event.name === 'card.pull_request_merged')).toHaveLength(0);
    /* `triggerEvents`, not `allEvents` — the fixture setup above (`cardFixture`,
       `linkCardPullRequest`) emits its own real events (`project.created`,
       `card.pull_request_linked`, ...) that `allEvents`' unfiltered query would
       include here, and this assertion only cares about the connector-trigger
       namespace the webhook itself writes to. */
    const triggered = await triggerEvents(orgId);
    expect(triggered.map((event) => event.name)).toEqual(['integration.github_event']);
  });

  it('an opened PR auto-links the card its branch name references', async () => {
    const orgId = await scaffold('github-pr-opened');
    await insertConnector({
      orgId,
      provider: 'github',
      providerScope: 'acme/opened-repo',
      status: 'connected',
      verifySecret: GITHUB_VERIFY_SECRET,
    });
    const fixture = await cardFixture(orgId);
    const branchName = `${fixture.reference.toLowerCase()}-fix-login-redirect`;

    const body = githubBody('acme/opened-repo', {
      action: 'opened',
      pull_request: { number: 77, merged: false, head: { ref: branchName } },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/integrations/github',
      headers: {
        'content-type': 'application/json',
        'x-github-delivery': 'uuid-delivery-pr-opened-1',
        'x-github-event': 'pull_request',
        'x-hub-signature-256': signGitHubRequest({ secret: GITHUB_VERIFY_SECRET, body }),
      },
      payload: body,
    });

    expect(response.statusCode).toBe(204);
    const events = await allEvents(orgId);
    const linked = events.filter((event) => event.name === 'card.pull_request_linked');
    expect(linked).toHaveLength(1);
    expect(linked[0]?.payload).toMatchObject({
      cardId: fixture.cardId,
      providerScope: 'acme/opened-repo',
      prNumber: 77,
    });
  });

  it('an opened PR from a branch with no recognizable reference links nothing', async () => {
    const orgId = await scaffold('github-pr-opened-no-ref');
    await insertConnector({
      orgId,
      provider: 'github',
      providerScope: 'acme/opened-no-ref-repo',
      status: 'connected',
      verifySecret: GITHUB_VERIFY_SECRET,
    });

    const body = githubBody('acme/opened-no-ref-repo', {
      action: 'opened',
      pull_request: { number: 78, merged: false, head: { ref: 'fix-something-unrelated' } },
    });
    const response = await app.inject({
      method: 'POST',
      url: '/integrations/github',
      headers: {
        'content-type': 'application/json',
        'x-github-delivery': 'uuid-delivery-pr-opened-2',
        'x-github-event': 'pull_request',
        'x-hub-signature-256': signGitHubRequest({ secret: GITHUB_VERIFY_SECRET, body }),
      },
      payload: body,
    });

    expect(response.statusCode).toBe(204);
    const events = await allEvents(orgId);
    expect(events.filter((event) => event.name === 'card.pull_request_linked')).toHaveLength(0);
  });
});
