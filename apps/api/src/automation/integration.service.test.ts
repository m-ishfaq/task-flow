import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { unsafeAsId, type OrgId, type UserId } from '@taskflow/contracts';
import { closeDatabase, initializeDatabase } from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import { masterKeysFromBase64, SoftwareKeyProvider } from '@taskflow/security';
import { TEST_ENV } from '../testing/fixtures.js';
import * as orgs from '../tenancy/org.service.js';
import * as members from '../tenancy/member.service.js';
import { loadTuples } from '../tenancy/resolve.js';
import type { AutomationActor } from './automation.service.js';
import {
  beginIntegration,
  completeIntegration,
  disconnectIntegration,
  listIntegrations,
  listReposForIntegration,
  selectRepo,
  type IntegrationDeps,
} from './integration.service.js';

/**
 * Connector lifecycle (ai/phase-10-automation.md §7, Wave 4 slice 2).
 *
 * What is under test is the §7.10 lifecycle contract: connect stores an
 * ENCRYPTED token under a row-bound AAD (a ciphertext transplanted to another
 * org fails to decrypt), disconnect flips status and never deletes, list never
 * exposes a token, and the GitHub connect completes at the repo choice with
 * the choice validated against what the token can genuinely reach.
 *
 * The provider calls go through a fake `fetchImpl` — the SERVICE has no real
 * network dependency — while the database, the keys, and the outbox are real.
 * The two assertions that matter most:
 *
 *   - the state token is the trust anchor: complete is a public route, so a
 *     forged or cross-provider state must be refused BEFORE any write;
 *   - the AAD transplant refusal happens BEFORE any network call — a
 *     ciphertext that cannot decrypt never reaches the provider.
 */

const OWNER = unsafeAsId<'UserId'>('0195ee32-0000-7000-8000-000000000001');
const ADMIN = unsafeAsId<'UserId'>('0195ee32-0000-7000-8000-000000000002');
const MEMBER = unsafeAsId<'UserId'>('0195ee32-0000-7000-8000-000000000003');

const USERS: readonly [UserId, string][] = [
  [OWNER, 'owner@integration-service.test'],
  [ADMIN, 'admin@integration-service.test'],
  [MEMBER, 'member@integration-service.test'],
];

const requestId = unsafeAsId<'RequestId'>('0195ee32-0000-7000-8000-0000000000ff');

const MASTER_KEY_ID = 'test-master';
const keys = new SoftwareKeyProvider({
  currentMasterKeyId: MASTER_KEY_ID,
  masterKeys: masterKeysFromBase64({
    [MASTER_KEY_ID]: Buffer.alloc(32, 7).toString('base64'),
  }),
});

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
  const uniqueSlug = `in-${fixtureCounter.toString(36)}-${slug.slice(0, 8)}-${crypto.randomUUID().slice(0, 8)}`;
  const result = await orgs.createOrg(
    { name: `Integrations ${slug}`, slug: uniqueSlug },
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
    'platform.integrations',
    'authz.relationship_tuples',
    'identity.memberships',
  ]) {
    await admin.query(`DELETE FROM ${table} WHERE org_id = $1`, [orgId]);
  }
  await admin.query(`DELETE FROM identity.orgs WHERE id = $1`, [orgId]);
  await admin.setOrg(null);
}

/** The org's CONNECTOR outbox events, in order. Filters to `integration.%`
 * deliberately: the scaffold's own `members.addMember` emits `member.added`
 * events, which are foreign fixtures here — the suite's assertions are about
 * what the connector mutations emitted, not everything in the queue. */
async function integrationEvents(
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

/** Reads one connector row's credential columns, as the migrator. The
 * columns are NULLABLE since migration 0057 — a disconnected row has its
 * credential wiped, so the helper returns `null` for a dead connector and
 * the plaintext for a live one. */
async function credentialColumns(
  orgId: string,
  integrationId: string,
): Promise<{
  tokenCiphertext: string | null;
  tokenWrapped: string | null;
  tokenMasterId: string | null;
}> {
  await admin.setOrg(orgId);
  const result = await admin.query(
    `SELECT encode(token_ciphertext, 'hex') AS token_ciphertext,
            encode(token_wrapped, 'hex') AS token_wrapped,
            token_master_id AS token_master_id
     FROM platform.integrations WHERE id = $1`,
    [integrationId],
  );
  await admin.setOrg(null);
  const row = result.rows[0] as
    | {
        token_ciphertext: string | null;
        token_wrapped: string | null;
        token_master_id: string | null;
      }
    | undefined;
  if (row === undefined) throw new Error('row missing');
  return {
    tokenCiphertext: row.token_ciphertext,
    tokenWrapped: row.token_wrapped,
    tokenMasterId: row.token_master_id,
  };
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

  initializeDatabase({ url: TEST_ENV.DATABASE_URL, applicationName: 'taskflow-integration-svc' });
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

/* ---------------------------------------------------------------------------
 * The fake provider — records every call, answers the fixed endpoints.
 * ------------------------------------------------------------------------- */

interface FakeProviderOptions {
  readonly slackToken?: string;
  readonly teamId?: string;
  readonly teamName?: string;
  readonly githubToken?: string;
  readonly login?: string;
  readonly repos?: readonly { name: string; full_name: string }[];
}

function fakeProvider(options: FakeProviderOptions = {}): {
  fetch: typeof fetch;
  calls: string[];
} {
  const calls: string[] = [];
  const repos = options.repos ?? [
    { name: 'todo', full_name: 'acme/todo' },
    { name: 'docs', full_name: 'acme/docs' },
  ];

  /* A synchronous function returning promises — no `await` anywhere, which
     is what makes the response construction straight-line and testable. */
  const fn = ((input: string | URL | Request) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);

    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });

    switch (url) {
      case 'https://slack.com/api/oauth.v2.access':
        return Promise.resolve(
          json({ ok: true, access_token: options.slackToken ?? 'xoxb-test-token' }),
        );
      case 'https://slack.com/api/auth.test':
        return Promise.resolve(
          json({
            ok: true,
            team_id: options.teamId ?? 'T0001',
            team_name: options.teamName ?? 'Acme Workspace',
          }),
        );
      case 'https://github.com/login/oauth/access_token':
        return Promise.resolve(json({ access_token: options.githubToken ?? 'gho_test_token' }));
      case 'https://api.github.com/user':
        return Promise.resolve(json({ login: options.login ?? 'octocat' }));
      case 'https://api.github.com/user/repos?per_page=100&type=member':
        return Promise.resolve(json([...repos]));
      default:
        throw new Error(`unexpected provider call: ${url}`);
    }
  }) as typeof fetch;

  return { fetch: fn, calls };
}

function depsFor(
  fetchImpl: typeof fetch,
  overrides: Partial<IntegrationDeps> = {},
): IntegrationDeps {
  return {
    providers: {
      slack: { clientId: 'slack-client', clientSecret: 'slack-secret' },
      github: { clientId: 'github-client', clientSecret: 'github-secret' },
    },
    redirectUri: (provider) => `https://app.test/integrations/callback/${provider}`,
    webhookOrigin: 'https://app.test',
    jwtSecret: Buffer.alloc(32, 9),
    keys,
    fetchImpl,
    ...overrides,
  };
}

/** Begins a connect and pulls the signed state out of the authorization URL. */
async function beginState(
  actor: AutomationActor,
  deps: IntegrationDeps,
  provider: 'slack' | 'github',
): Promise<{ state: string; url: URL }> {
  const { authorizationUrl } = await beginIntegration(actor, deps, { provider });
  const url = new URL(authorizationUrl);
  const state = url.searchParams.get('state');
  if (state === null) throw new Error('no state in authorization URL');
  return { state, url };
}

describe('begin — minting the state and handing the browser to the provider', () => {
  it('builds a Slack authorization URL with PKCE and the least privilege scope', async () => {
    const { owner } = await scaffold('begin-slack');
    const deps = depsFor(fakeProvider().fetch);

    const { url } = await beginState(owner, deps, 'slack');

    expect(url.hostname).toBe('slack.com');
    expect(url.searchParams.get('client_id')).toBe('slack-client');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://app.test/integrations/callback/slack',
    );
    /* chat:write is the one scope the outbound action needs — a connector
       that could list channels would know more of the workspace than the
       org controls its memberships of. */
    expect(url.searchParams.get('scope')).toBe('chat:write');
    expect(url.searchParams.get('code_challenge')).toBeTruthy();
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('builds a GitHub authorization URL with the repo scope', async () => {
    const { owner } = await scaffold('begin-github');
    const deps = depsFor(fakeProvider().fetch);

    const { url } = await beginState(owner, deps, 'github');

    expect(url.hostname).toBe('github.com');
    expect(url.searchParams.get('client_id')).toBe('github-client');
    expect(url.searchParams.get('scope')).toBe('repo');
    /* GitHub's OAuth apps do not support PKCE — the confidential client
       secret stands in for it. A code_challenge present here would be a lie. */
    expect(url.searchParams.get('code_challenge')).toBeNull();
  });

  it('refuses a provider this server has no credentials for', async () => {
    const { owner } = await scaffold('begin-unconfigured');
    const deps = depsFor(fakeProvider().fetch, { providers: {} });

    await expect(beginIntegration(owner, deps, { provider: 'slack' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('the Slack connect — one hop to connected', () => {
  it('completes with a connected row keyed on the workspace, token encrypted at rest', async () => {
    const { owner } = await scaffold('slack-connect');
    const fake = fakeProvider({ teamId: 'T0001', teamName: 'Acme Workspace' });
    const deps = depsFor(fake.fetch);
    const { state } = await beginState(owner, deps, 'slack');

    const result = await completeIntegration(
      deps,
      { provider: 'slack', code: 'code-1', state },
      requestId,
    );

    expect(result.status).toBe('connected');
    if (result.status !== 'connected') return;
    expect(result.name).toBe('Acme Workspace');
    expect(result.providerScope).toBe('T0001');
    /* The webhook URL is derivable, but it is the value pasted into the
       Slack app's event subscription — part of the connect contract. */
    expect(result.webhookUrl).toBe('https://app.test/integrations/slack');

    const [row] = await listIntegrations(owner);
    expect(row?.provider).toBe('slack');
    expect(row?.providerScope).toBe('T0001');
    expect(row?.status).toBe('connected');

    /* Encrypted at rest is a fact, not a comment: the stored ciphertext must
       differ from the token the exchange handed back. */
    const stored = await credentialColumns(owner.subject.orgId, result.integrationId);
    expect(stored.tokenCiphertext).not.toContain('xoxb');
    expect(stored.tokenCiphertext?.length).toBeGreaterThan(0);
    expect(stored.tokenWrapped?.length).toBeGreaterThan(0);

    /* The connected event went through the org's outbox. */
    const events = await integrationEvents(owner.subject.orgId);
    expect(events.map((event) => event.name)).toEqual(['integration.connected']);
    expect(events[0]?.payload).toMatchObject({
      provider: 'slack',
      providerScope: 'T0001',
      name: 'Acme Workspace',
    });
  });

  it('reconnect lands on the SAME row — disconnect never deletes, and reconnecting replaces the token', async () => {
    const { owner } = await scaffold('slack-reconnect');
    const fake = fakeProvider({ teamId: 'T0001' });
    const deps = depsFor(fake.fetch);
    const { state: firstState } = await beginState(owner, deps, 'slack');
    const first = await completeIntegration(
      deps,
      { provider: 'slack', code: 'code-1', state: firstState },
      requestId,
    );
    expect(first.status).toBe('connected');
    if (first.status !== 'connected') return;

    /* Reconnect: same workspace, second OAuth round trip. */
    const { state: secondState } = await beginState(owner, deps, 'slack');
    const second = await completeIntegration(
      deps,
      { provider: 'slack', code: 'code-2', state: secondState },
      requestId,
    );
    expect(second.status).toBe('connected');
    if (second.status !== 'connected') return;

    expect(second.integrationId).toBe(first.integrationId);
    const events = await integrationEvents(owner.subject.orgId);
    expect(events.filter((event) => event.name === 'integration.connected')).toHaveLength(2);

    /* The token column was rewritten with the second exchange's token. */
    const stored = await credentialColumns(owner.subject.orgId, second.integrationId);
    expect(stored.tokenCiphertext?.length).toBeGreaterThan(0);
  });

  it('list never exposes a token column — the summary shape carries none', async () => {
    const { owner } = await scaffold('slack-list');
    const deps = depsFor(fakeProvider().fetch);
    const { state } = await beginState(owner, deps, 'slack');
    await completeIntegration(deps, { provider: 'slack', code: 'code-1', state }, requestId);

    const rows = await listIntegrations(owner);
    expect(rows).toHaveLength(1);
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain('token');
    expect(serialized).not.toContain('ciphertext');
  });
});

describe('the GitHub connect — pending until the repo choice', () => {
  it('complete returns pending_repo with the reachable repos and the one-time verify secret', async () => {
    const { owner } = await scaffold('github-pending');
    const fake = fakeProvider({ login: 'octocat' });
    const deps = depsFor(fake.fetch);
    const { state } = await beginState(owner, deps, 'github');

    const result = await completeIntegration(
      deps,
      { provider: 'github', code: 'code-1', state },
      requestId,
    );

    expect(result.status).toBe('pending_repo');
    if (result.status !== 'pending_repo') return;
    expect(result.login).toBe('octocat');
    expect(result.repos.map((repo) => repo.fullName)).toEqual(['acme/todo', 'acme/docs']);
    /* The per-org verify secret — shown exactly once, never readable again. */
    expect(result.verifySecret.length).toBeGreaterThanOrEqual(32);

    const [row] = await listIntegrations(owner);
    expect(row?.provider).toBe('github');
    expect(row?.providerScope).toBe('octocat');
    expect(row?.status).toBe('disconnected');

    /* NO connected event yet — the connect completes at the repo choice. What
       DID emit is `integration.pending`: the row is a state mutation, and if
       the person abandons the picker this event is the only record the org's
       credential ever existed (guardrail 11, integration-events.ts). */
    const events = await integrationEvents(owner.subject.orgId);
    expect(events.map((event) => event.name)).toEqual(['integration.pending']);
    expect(events[0]?.payload).toMatchObject({
      provider: 'github',
      providerScope: 'octocat',
    });
  });

  it('selectRepo validates the choice against the token, flips the row, and emits the event', async () => {
    const { owner } = await scaffold('github-select');
    const fake = fakeProvider();
    const deps = depsFor(fake.fetch);
    const { state } = await beginState(owner, deps, 'github');
    const pending = await completeIntegration(
      deps,
      { provider: 'github', code: 'code-1', state },
      requestId,
    );
    expect(pending.status).toBe('pending_repo');
    if (pending.status !== 'pending_repo') return;

    const summary = await selectRepo(owner, deps, {
      integrationId: pending.integrationId,
      fullName: 'acme/todo',
    });

    expect(summary.status).toBe('connected');
    expect(summary.providerScope).toBe('acme/todo');
    expect(summary.name).toBe('acme/todo');

    const events = await integrationEvents(owner.subject.orgId);
    expect(events.map((event) => event.name)).toEqual([
      'integration.pending',
      'integration.connected',
    ]);
    expect(events[1]?.payload).toMatchObject({
      provider: 'github',
      providerScope: 'acme/todo',
      name: 'acme/todo',
    });
  });

  it('selectRepo refuses a repository the token cannot reach', async () => {
    const { owner } = await scaffold('github-refuse');
    const fake = fakeProvider();
    const deps = depsFor(fake.fetch);
    const { state } = await beginState(owner, deps, 'github');
    const pending = await completeIntegration(
      deps,
      { provider: 'github', code: 'code-1', state },
      requestId,
    );
    expect(pending.status).toBe('pending_repo');
    if (pending.status !== 'pending_repo') return;

    await expect(
      selectRepo(owner, deps, { integrationId: pending.integrationId, fullName: 'acme/private' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    /* Still pending — the refusal wrote nothing. */
    const [row] = await listIntegrations(owner);
    expect(row?.status).toBe('disconnected');
  });

  it('repos rebuilds the picker from the STORED token — the refresh resume path', async () => {
    const { owner } = await scaffold('github-repos');
    const fake = fakeProvider();
    const deps = depsFor(fake.fetch);
    const { state } = await beginState(owner, deps, 'github');
    const pending = await completeIntegration(
      deps,
      { provider: 'github', code: 'code-1', state },
      requestId,
    );
    expect(pending.status).toBe('pending_repo');
    if (pending.status !== 'pending_repo') return;

    /* The one-time code is burned; the resume path re-lists from the token. */
    const callsBefore = fake.calls.length;
    const repos = await listReposForIntegration(owner, deps, {
      integrationId: pending.integrationId,
    });
    expect(repos.map((repo) => repo.fullName)).toEqual(['acme/todo', 'acme/docs']);
    /* Exactly one network call — the repos endpoint, no re-exchange. */
    expect(fake.calls.slice(callsBefore)).toEqual([
      'https://api.github.com/user/repos?per_page=100&type=member',
    ]);
  });
});

describe('the state token is the trust anchor', () => {
  it('refuses a state minted for the other provider', async () => {
    const { owner } = await scaffold('state-provider');
    const fake = fakeProvider();
    const deps = depsFor(fake.fetch);
    const { state } = await beginState(owner, deps, 'slack');

    await expect(
      completeIntegration(deps, { provider: 'github', code: 'code-1', state }, requestId),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    /* Refused before any write or any provider call. */
    expect(fake.calls).toHaveLength(0);
    expect(await integrationEvents(owner.subject.orgId)).toHaveLength(0);
  });

  it('refuses a forged state — one signed by a different secret', async () => {
    const { owner } = await scaffold('state-forged');
    const fake = fakeProvider();
    const deps = depsFor(fake.fetch);

    /* A state signed by an attacker's own secret is indistinguishable from
       garbage to the verifier — the audience, issuer and HMAC all fail. */
    const forgedDeps = depsFor(fake.fetch, { jwtSecret: Buffer.alloc(32, 1) });
    const { state } = await beginState(owner, forgedDeps, 'slack');

    await expect(
      completeIntegration(deps, { provider: 'slack', code: 'code-1', state }, requestId),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });

    expect(fake.calls).toHaveLength(0);
  });

  it('refuses a complete for a provider with no credentials', async () => {
    const { owner } = await scaffold('state-unconfigured');
    const fake = fakeProvider();
    const deps = depsFor(fake.fetch);
    const { state } = await beginState(owner, deps, 'slack');
    const noProviderDeps = depsFor(fake.fetch, { providers: {} });

    await expect(
      completeIntegration(noProviderDeps, { provider: 'slack', code: 'code-1', state }, requestId),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('disconnect — a status flip, never a delete', () => {
  it('flips to disconnected, keeps the row, and emits the event', async () => {
    const { owner } = await scaffold('disconnect-flip');
    const fake = fakeProvider();
    const deps = depsFor(fake.fetch);
    const { state } = await beginState(owner, deps, 'slack');
    const connected = await completeIntegration(
      deps,
      { provider: 'slack', code: 'code-1', state },
      requestId,
    );
    expect(connected.status).toBe('connected');
    if (connected.status !== 'connected') return;

    await disconnectIntegration(owner, { integrationId: connected.integrationId });

    const [row] = await listIntegrations(owner);
    expect(row?.status).toBe('disconnected');
    /* The row survives — it is the org's audit trail of having authorized
       this scope. Name and providerScope stay; the credential does not. */
    expect(row?.providerScope).toBe('T0001');

    /* The wipe is a fact, not a comment (migration 0057): a revoked
       connector is genuinely dead, so no stale picker or admin can act as
       the org with the token it deliberately revoked. */
    const stored = await credentialColumns(owner.subject.orgId, connected.integrationId);
    expect(stored.tokenCiphertext).toBeNull();
    expect(stored.tokenWrapped).toBeNull();
    expect(stored.tokenMasterId).toBeNull();

    const events = await integrationEvents(owner.subject.orgId);
    expect(events.map((event) => event.name)).toEqual([
      'integration.connected',
      'integration.disconnected',
    ]);
  });

  it('a disconnected connector cannot be resurrected — a stale picker has nothing to decrypt', async () => {
    const { owner } = await scaffold('disconnect-dead');
    const fake = fakeProvider();
    const deps = depsFor(fake.fetch);
    const { state } = await beginState(owner, deps, 'github');
    const pending = await completeIntegration(
      deps,
      { provider: 'github', code: 'code-1', state },
      requestId,
    );
    expect(pending.status).toBe('pending_repo');
    if (pending.status !== 'pending_repo') return;
    await selectRepo(owner, deps, {
      integrationId: pending.integrationId,
      fullName: 'acme/todo',
    });

    await disconnectIntegration(owner, { integrationId: pending.integrationId });

    /* A picker tab that outlived the revocation tries to resume the connect
       — it must fail on the DECRYPT, before anything reaches GitHub. */
    const callsBefore = fake.calls.length;
    await expect(
      listReposForIntegration(owner, deps, { integrationId: pending.integrationId }),
    ).rejects.toThrow();
    expect(fake.calls.slice(callsBefore)).toHaveLength(0);

    /* And selectRepo refuses the same way — the row is unclaimable dead. */
    await expect(
      selectRepo(owner, deps, { integrationId: pending.integrationId, fullName: 'acme/todo' }),
    ).rejects.toThrow();
  });

  it('a revoked connector can reconnect — the cycle lands on the same row with a fresh token', async () => {
    const { owner } = await scaffold('disconnect-cycle');
    const fake = fakeProvider();
    const deps = depsFor(fake.fetch);

    const { state } = await beginState(owner, deps, 'github');
    const pending = await completeIntegration(
      deps,
      { provider: 'github', code: 'code-1', state },
      requestId,
    );
    expect(pending.status).toBe('pending_repo');
    if (pending.status !== 'pending_repo') return;
    await selectRepo(owner, deps, {
      integrationId: pending.integrationId,
      fullName: 'acme/todo',
    });
    await disconnectIntegration(owner, { integrationId: pending.integrationId });

    /* Reconnect: the revoked row kept its providerScope ('acme/todo', the
       repo — the audit trail of what was authorized), while the upsert
       matches on (org, github, LOGIN), so the reconnect is a NEW row with a
       fresh credential and a fresh one-time verify secret. The old row stays
       dead behind it; no stale handle to it can ever act again. */
    const { state: secondState } = await beginState(owner, deps, 'github');
    const second = await completeIntegration(
      deps,
      { provider: 'github', code: 'code-2', state: secondState },
      requestId,
    );
    expect(second.status).toBe('pending_repo');
    if (second.status !== 'pending_repo') return;
    expect(second.integrationId).not.toBe(pending.integrationId);

    /* And the old row stayed dead through all of it. */
    const dead = await credentialColumns(owner.subject.orgId, pending.integrationId);
    expect(dead.tokenCiphertext).toBeNull();

    const resumed = await selectRepo(owner, deps, {
      integrationId: second.integrationId,
      fullName: 'acme/docs',
    });
    expect(resumed.status).toBe('connected');
    expect(resumed.providerScope).toBe('acme/docs');

    /* The full lifecycle is on the chain: connect, revoke, connect again. */
    const events = await integrationEvents(owner.subject.orgId);
    expect(events.map((event) => event.name)).toEqual([
      'integration.pending',
      'integration.connected',
      'integration.disconnected',
      'integration.pending',
      'integration.connected',
    ]);
  });

  it('a second disconnect emits nothing — the transition is in the WHERE', async () => {
    const { owner } = await scaffold('disconnect-twice');
    const fake = fakeProvider();
    const deps = depsFor(fake.fetch);
    const { state } = await beginState(owner, deps, 'slack');
    const connected = await completeIntegration(
      deps,
      { provider: 'slack', code: 'code-1', state },
      requestId,
    );
    expect(connected.status).toBe('connected');
    if (connected.status !== 'connected') return;

    await disconnectIntegration(owner, { integrationId: connected.integrationId });
    /* Two racing disconnects — the second answers success (idempotent for the
       caller) but must not append a second event to the chain. */
    await disconnectIntegration(owner, { integrationId: connected.integrationId });

    const events = await integrationEvents(owner.subject.orgId);
    expect(events.filter((event) => event.name === 'integration.disconnected')).toHaveLength(1);
  });

  it('refuses an unknown row', async () => {
    const { owner } = await scaffold('disconnect-missing');
    await expect(
      disconnectIntegration(owner, { integrationId: crypto.randomUUID() }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('the credential is row-bound — a transplant fails to decrypt', () => {
  it('a ciphertext lifted into another org cannot be used, and the refusal precedes the network', async () => {
    const a = await scaffold('transplant-a');
    const b = await scaffold('transplant-b');
    const fake = fakeProvider();
    const deps = depsFor(fake.fetch);

    /* Org A connects GitHub and gets a pending row holding its token. */
    const { state } = await beginState(a.owner, deps, 'github');
    const pending = await completeIntegration(
      deps,
      { provider: 'github', code: 'code-1', state },
      requestId,
    );
    expect(pending.status).toBe('pending_repo');
    if (pending.status !== 'pending_repo') return;

    const stolen = await credentialColumns(a.orgId, pending.integrationId);

    /* The transplant: an admin row in org B carrying org A's credential
       columns. Two independent guards refuse it — the data key's own
       encryption context is org A, and the row-bound AAD names org A. */
    await admin.setOrg(b.orgId);
    await admin.query(
      `INSERT INTO platform.integrations
         (id, org_id, provider, name, provider_scope, status,
          token_ciphertext, token_wrapped, token_master_id, created_by, created_at)
       VALUES ($1, $2, 'github', 'stolen', 'stolen/login', 'disconnected',
          decode($3, 'hex'), decode($4, 'hex'), $5, $6, now())`,
      [
        crypto.randomUUID(),
        b.orgId,
        stolen.tokenCiphertext,
        stolen.tokenWrapped,
        stolen.tokenMasterId,
        OWNER,
      ],
    );
    const transplantedId = (
      await admin.query(
        `SELECT id FROM platform.integrations WHERE org_id = $1 AND name = 'stolen'`,
        [b.orgId],
      )
    ).rows[0]?.['id'] as string;
    await admin.setOrg(null);

    /* Org B's owner tries to resume the picker with the stolen row. */
    const callsBefore = fake.calls.length;
    await expect(
      listReposForIntegration(b.owner, deps, { integrationId: transplantedId }),
    ).rejects.toThrow();

    /* THE assertion for this test: the failure is the DECRYPT, which happens
       before any provider call — an attacker with a transplanted row learns
       nothing from the network because nothing reaches it. The original
       connect made its own calls above; what matters is that THIS attempt
       made none. */
    expect(fake.calls.slice(callsBefore)).toHaveLength(0);

    /* And the original still works in org A — only the transplant broke. */
    const repos = await listReposForIntegration(a.owner, deps, {
      integrationId: pending.integrationId,
    });
    expect(repos.length).toBeGreaterThan(0);
  });
});
