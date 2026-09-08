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
  selectRepo,
  type IntegrationDeps,
} from './integration.service.js';
import {
  getPullRequestComments,
  getPullRequestDiff,
  getPullRequestFileContent,
  getPullRequestFileDiff,
  getPullRequestFiles,
  getPullRequestStatus,
  listConnectedRepos,
  listPullRequests,
} from './pr-read.service.js';

/**
 * `pr-read.service.ts` (ai/phase-15-ai-copilot-and-permissions.md §7 Wave 1).
 *
 * What is under test: `pr:view` is checked BEFORE any network call (the
 * "refused before the network call" property every spend/access gate in
 * this codebase proves the same way); the repository is always read off the
 * connected connector row, never a caller input; a long diff is truncated
 * at the documented cap; PR comments merge GitHub's two distinct comment
 * endpoints; and a missing/disconnected connector reads identically to one
 * that was never connected, mirroring `integration.service.test.ts`'s own
 * `connectorFor` coverage.
 */

const OWNER = unsafeAsId<'UserId'>('0195ee40-0000-7000-8000-000000000001');
const MEMBER = unsafeAsId<'UserId'>('0195ee40-0000-7000-8000-000000000002');

const USERS: readonly [UserId, string][] = [
  [OWNER, 'owner@pr-read-service.test'],
  [MEMBER, 'member@pr-read-service.test'],
];

const requestId = unsafeAsId<'RequestId'>('0195ee40-0000-7000-8000-0000000000ff');

const MASTER_KEY_ID = 'test-master';
const keys = new SoftwareKeyProvider({
  currentMasterKeyId: MASTER_KEY_ID,
  masterKeys: masterKeysFromBase64({ [MASTER_KEY_ID]: Buffer.alloc(32, 7).toString('base64') }),
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
  const uniqueSlug = `pr-${fixtureCounter.toString(36)}-${slug.slice(0, 8)}-${crypto.randomUUID().slice(0, 8)}`;
  const result = await orgs.createOrg(
    { name: `PR read ${slug}`, slug: uniqueSlug },
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

  initializeDatabase({ url: TEST_ENV.DATABASE_URL, applicationName: 'taskflow-pr-read-svc' });
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

const GITHUB_PROVIDERS = { github: { clientId: 'github-client', clientSecret: 'github-secret' } };

function depsFor(fetchImpl: typeof fetch): IntegrationDeps {
  return {
    providers: GITHUB_PROVIDERS,
    redirectUri: (provider) => `https://app.test/integrations/callback/${provider}`,
    webhookOrigin: 'https://app.test',
    jwtStateSecret: Buffer.alloc(32, 9),
    keys,
    fetchImpl,
  };
}

async function beginState(
  actor: AutomationActor,
  deps: IntegrationDeps,
): Promise<{ state: string }> {
  const { authorizationUrl } = await beginIntegration(actor, deps, { provider: 'github' });
  const state = new URL(authorizationUrl).searchParams.get('state');
  if (state === null) throw new Error('no state in authorization URL');
  return { state };
}

interface FakePrOptions {
  readonly fullName?: string;
  readonly pulls?: readonly Record<string, unknown>[];
  readonly diff?: string;
  readonly diffStatus?: number;
  readonly issueComments?: readonly Record<string, unknown>[];
  readonly reviewComments?: readonly Record<string, unknown>[];
  readonly status?: number;
}

/** Connect-flow endpoints (token exchange, `/user`, repo listing) plus the
    three PR-reading endpoints this file exercises. */
function fakeGithub(options: FakePrOptions = {}): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fullName = options.fullName ?? 'acme/todo';

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  const fn = ((input: string | URL | Request) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);

    if (url === 'https://github.com/login/oauth/access_token') {
      return Promise.resolve(json({ access_token: 'gho_test_token' }));
    }
    if (url === 'https://api.github.com/user') {
      return Promise.resolve(json({ login: 'octocat' }));
    }
    if (url.startsWith('https://api.github.com/user/repos')) {
      return Promise.resolve(json([{ name: 'todo', full_name: fullName }]));
    }
    if (options.status !== undefined && options.status !== 200) {
      return Promise.resolve(json({ message: 'nope' }, options.status));
    }
    if (/\/pulls\/\d+$/.test(url)) {
      return Promise.resolve(
        new Response(options.diff ?? 'diff --git a/x b/x\n', {
          status: options.diffStatus ?? 200,
          headers: { 'content-type': 'text/plain' },
        }),
      );
    }
    if (url.includes('/pulls?')) {
      return Promise.resolve(json(options.pulls ?? []));
    }
    if (/\/issues\/\d+\/comments/.test(url)) {
      return Promise.resolve(json(options.issueComments ?? []));
    }
    if (/\/pulls\/\d+\/comments/.test(url)) {
      return Promise.resolve(json(options.reviewComments ?? []));
    }
    throw new Error(`unexpected call: ${url}`);
  }) as typeof fetch;

  return { fetch: fn, calls };
}

/** Connects GitHub end to end and hands back the row id. */
async function connectedGithub(
  actor: AutomationActor,
  deps: IntegrationDeps,
  fullName = 'acme/todo',
): Promise<string> {
  const { state } = await beginState(actor, deps);
  const pending = await completeIntegration(
    deps,
    { provider: 'github', code: 'c', state },
    requestId,
  );
  if (pending.status !== 'pending_repo')
    throw new Error('github connect did not reach repo choice');
  const connected = await selectRepo(actor, deps, {
    integrationId: pending.integrationId,
    fullName,
  });
  return connected.integrationId;
}

describe('listPullRequests', () => {
  it('returns real GitHub rows, mapped', async () => {
    const { owner } = await scaffold('list-ok');
    const pulls = [
      {
        number: 7,
        title: 'Fix login bug',
        state: 'open',
        draft: false,
        user: { login: 'alice' },
        html_url: 'https://github.com/acme/todo/pull/7',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-02T00:00:00Z',
        base: { ref: 'main' },
        head: { ref: 'alice/fix-login' },
      },
    ];
    const fake = fakeGithub({ pulls });
    const deps = depsFor(fake.fetch);
    await connectedGithub(owner, deps);

    const result = await listPullRequests(owner, deps, {});

    expect(result).toEqual([
      {
        number: 7,
        title: 'Fix login bug',
        state: 'open',
        isDraft: false,
        author: 'alice',
        url: 'https://github.com/acme/todo/pull/7',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-02T00:00:00Z',
        baseBranch: 'main',
        headBranch: 'alice/fix-login',
      },
    ]);
  });

  it('refuses a member with no pr:view grant, before any network call', async () => {
    const { owner, member } = await scaffold('list-refused');
    const fake = fakeGithub({ pulls: [] });
    const deps = depsFor(fake.fetch);
    await connectedGithub(owner, deps);
    fake.calls.length = 0;

    await expect(listPullRequests(member, deps, {})).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(fake.calls).toHaveLength(0);
  });

  it('answers NOT_FOUND, distinctly, when no repo is connected', async () => {
    const { owner } = await scaffold('list-no-connector');
    const fake = fakeGithub({});
    const deps = depsFor(fake.fetch);

    await expect(listPullRequests(owner, deps, {})).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(listPullRequests(owner, deps, {})).rejects.toThrow(
      /No GitHub repository is connected/,
    );
  });

  it('a disconnected connector reads identically to a missing one', async () => {
    const { owner } = await scaffold('list-disconnected');
    const fake = fakeGithub({});
    const deps = depsFor(fake.fetch);
    const integrationId = await connectedGithub(owner, deps);
    await disconnectIntegration(owner, { integrationId });

    await expect(listPullRequests(owner, deps, {})).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('refuses ambiguously, with zero network calls, when more than one repo is connected and no repoScope is given', async () => {
    const { owner } = await scaffold('list-ambiguous');
    const fake = fakeGithub({ fullName: 'acme/first' });
    const deps = depsFor(fake.fetch);
    await connectedGithub(owner, deps, 'acme/first');

    const secondFake = fakeGithub({ fullName: 'acme/second', pulls: [] });
    const secondDeps = depsFor(secondFake.fetch);
    await connectedGithub(owner, secondDeps, 'acme/second');

    const calls: string[] = [];
    const combined = ((input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      calls.push(url);
      if (url.includes('acme/second')) return secondFake.fetch(input, init);
      return fake.fetch(input, init);
    }) as typeof fetch;
    calls.length = 0;

    await expect(
      listPullRequests(owner, { keys, providers: GITHUB_PROVIDERS, fetchImpl: combined }, {}),
    ).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(
      listPullRequests(owner, { keys, providers: GITHUB_PROVIDERS, fetchImpl: combined }, {}),
    ).rejects.toThrow(/More than one GitHub repository is connected/);
    // Never reaches GitHub — resolving which repo happens before any request.
    expect(calls).toHaveLength(0);
  });

  it('resolves the exact repo an explicit repoScope names, when more than one is connected', async () => {
    const { owner } = await scaffold('list-scoped');
    const fake = fakeGithub({ fullName: 'acme/first' });
    const deps = depsFor(fake.fetch);
    await connectedGithub(owner, deps, 'acme/first');

    const secondFake = fakeGithub({ fullName: 'acme/second', pulls: [] });
    const secondDeps = depsFor(secondFake.fetch);
    await connectedGithub(owner, secondDeps, 'acme/second');

    const combined = ((input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('acme/second')) return secondFake.fetch(input, init);
      return fake.fetch(input, init);
    }) as typeof fetch;

    const result = await listPullRequests(
      owner,
      { keys, providers: GITHUB_PROVIDERS, fetchImpl: combined },
      { repoScope: 'acme/second' },
    );
    expect(result).toEqual([]);
  });

  it('a repoScope naming a repo the org never connected answers NOT_FOUND', async () => {
    const { owner } = await scaffold('list-unknown-scope');
    const fake = fakeGithub({});
    const deps = depsFor(fake.fetch);
    await connectedGithub(owner, deps);

    await expect(
      listPullRequests(owner, deps, { repoScope: 'someone-else/other-repo' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('listConnectedRepos (via getPullRequestFiles/list_repos data source)', () => {
  it('returns every connected repo, and refuses a member with no pr:view grant', async () => {
    const { owner, member } = await scaffold('repos-list');
    const fake = fakeGithub({ fullName: 'acme/first' });
    const deps = depsFor(fake.fetch);
    await connectedGithub(owner, deps, 'acme/first');

    const secondFake = fakeGithub({ fullName: 'acme/second' });
    const secondDeps = depsFor(secondFake.fetch);
    await connectedGithub(owner, secondDeps, 'acme/second');

    const result = await listConnectedRepos(owner);
    expect(result.map((r) => r.providerScope).sort()).toEqual(['acme/first', 'acme/second']);

    await expect(listConnectedRepos(member)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('getPullRequestFiles', () => {
  it('returns real GitHub file rows, mapped', async () => {
    const { owner } = await scaffold('files-ok');
    const fake = fakeGithub({});
    // fakeGithub's own handler has no /files route; build a thin wrapper.
    const filesFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (/\/pulls\/\d+\/files/.test(url)) {
        return new Response(
          JSON.stringify([
            {
              filename: 'src/index.ts',
              status: 'modified',
              additions: 3,
              deletions: 1,
              previous_filename: null,
            },
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return fake.fetch(input, init);
    }) as typeof fetch;
    const deps = depsFor(filesFetch);
    await connectedGithub(owner, deps);

    const result = await getPullRequestFiles(owner, deps, { prNumber: 4 });

    expect(result).toEqual([
      { path: 'src/index.ts', status: 'modified', additions: 3, deletions: 1, previousPath: null },
    ]);
  });

  it('refuses a member with no pr:view grant, before any network call', async () => {
    const { owner, member } = await scaffold('files-refused');
    const fake = fakeGithub({});
    const deps = depsFor(fake.fetch);
    await connectedGithub(owner, deps);
    fake.calls.length = 0;

    await expect(getPullRequestFiles(member, deps, { prNumber: 4 })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(fake.calls).toHaveLength(0);
  });
});

describe('getPullRequestDiff', () => {
  it('returns the raw diff text', async () => {
    const { owner } = await scaffold('diff-ok');
    const fake = fakeGithub({ diff: 'diff --git a/x b/x\n+hello\n' });
    const deps = depsFor(fake.fetch);
    await connectedGithub(owner, deps);

    const result = await getPullRequestDiff(owner, deps, { prNumber: 42 });

    expect(result).toEqual({
      prNumber: 42,
      truncated: false,
      diff: 'diff --git a/x b/x\n+hello\n',
    });
  });

  it('truncates a diff past the cap and marks it, keeping the serialized result under the budget', async () => {
    const { owner } = await scaffold('diff-truncated');
    const longDiff = 'x'.repeat(25_000);
    const fake = fakeGithub({ diff: longDiff });
    const deps = depsFor(fake.fetch);
    await connectedGithub(owner, deps);

    const result = await getPullRequestDiff(owner, deps, { prNumber: 1 });

    expect(result.truncated).toBe(true);
    expect(result.diff.startsWith('x')).toBe(true);
    expect(result.diff).toContain('diff truncated at');
    // The real contract: `execute()`'s `JSON.stringify(result)` — what
    // actually crosses the wire as `ToolResult.content` — must fit under
    // router.ts's own `ChatMessage` tool_result `content: z.string().max(20_000)`.
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(20_000);
  });

  it('truncates a newline-heavy diff whose RAW length is under the old flat cap but whose JSON-encoded size is not — the exact shape that made ai.chat.send 500 on a real PR', async () => {
    // Found from a real report ("tell me the diff for pr 135" — "The
    // assistant could not reply"): a diff made mostly of short lines is
    // mostly newlines, and `JSON.stringify` turns each real newline into
    // the two characters `\n`, so a diff well under the OLD raw 20,000-char
    // cap could still serialize past router.ts's own ceiling on `content`.
    // 1,900 lines of 9 characters + a newline = 19,000 raw characters —
    // under the old cap, over the new budget once escaped.
    const { owner } = await scaffold('diff-newline-heavy');
    const longDiff = `${'x'.repeat(9)}\n`.repeat(1_900);
    expect(longDiff.length).toBe(19_000);
    const fake = fakeGithub({ diff: longDiff });
    const deps = depsFor(fake.fetch);
    await connectedGithub(owner, deps);

    const result = await getPullRequestDiff(owner, deps, { prNumber: 135 });

    expect(result.truncated).toBe(true);
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(20_000);
  });

  it('a nonexistent PR answers NOT_FOUND with a message naming the PR, not the connector', async () => {
    const { owner } = await scaffold('diff-404');
    const fake = fakeGithub({ diffStatus: 404 });
    const deps = depsFor(fake.fetch);
    await connectedGithub(owner, deps);

    await expect(getPullRequestDiff(owner, deps, { prNumber: 999 })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(getPullRequestDiff(owner, deps, { prNumber: 999 })).rejects.toThrow(
      /pull request does not exist/,
    );
  });
});

describe('getPullRequestComments', () => {
  it('merges and sorts both comment endpoints', async () => {
    const { owner } = await scaffold('comments-ok');
    const fake = fakeGithub({
      issueComments: [
        {
          id: 1,
          body: 'LGTM overall',
          created_at: '2026-01-02T00:00:00Z',
          html_url: 'https://github.com/acme/todo/pull/1#issuecomment-1',
          user: { login: 'bob' },
        },
      ],
      reviewComments: [
        {
          id: 2,
          body: 'nit: rename this',
          created_at: '2026-01-01T00:00:00Z',
          html_url: 'https://github.com/acme/todo/pull/1#discussion_r2',
          user: { login: 'carol' },
          path: 'src/index.ts',
        },
      ],
    });
    const deps = depsFor(fake.fetch);
    await connectedGithub(owner, deps);

    const result = await getPullRequestComments(owner, deps, { prNumber: 1 });

    expect(result.map((c) => c.id)).toEqual([2, 1]);
    expect(result[0]).toMatchObject({ kind: 'review', path: 'src/index.ts', author: 'carol' });
    expect(result[1]).toMatchObject({ kind: 'general', path: null, author: 'bob' });
  });
});

/** Both `getPullRequestStatus` calls (`/pulls/{n}` and `/commits/{sha}/check-runs`) hit URLs
    `fakeGithub`'s own diff-text handler was never built for, so this wraps `fake.fetch`
    exactly the way `getPullRequestFiles`'s own `files-ok` test does. */
function fakeGithubWithStatus(options: {
  readonly pr?: Record<string, unknown>;
  readonly prStatus?: number;
  readonly checkRuns?: readonly Record<string, unknown>[];
  readonly checkRunsStatus?: number;
}): { fetch: typeof fetch; calls: string[] } {
  const fake = fakeGithub({});
  const pr = options.pr ?? {
    state: 'open',
    draft: false,
    merged_at: null,
    head: { sha: 'abc123' },
  };

  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('/check-runs')) {
      return new Response(JSON.stringify({ check_runs: options.checkRuns ?? [] }), {
        status: options.checkRunsStatus ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (/\/pulls\/\d+$/.test(url)) {
      return new Response(JSON.stringify(pr), {
        status: options.prStatus ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return fake.fetch(input, init);
  }) as typeof fetch;

  return { fetch: fn, calls: fake.calls };
}

describe('getPullRequestStatus', () => {
  it('reports open, not merged, not draft, with a successful checks rollup', async () => {
    const { owner } = await scaffold('status-open');
    const fake = fakeGithubWithStatus({
      pr: { state: 'open', draft: false, merged_at: null, head: { sha: 'sha1' } },
      checkRuns: [{ status: 'completed', conclusion: 'success' }],
    });
    const deps = depsFor(fake.fetch);
    await connectedGithub(owner, deps);

    const result = await getPullRequestStatus(owner, deps, { prNumber: 7 });

    expect(result).toEqual({
      number: 7,
      state: 'open',
      merged: false,
      isDraft: false,
      checksStatus: 'success',
    });
  });

  it('reports merged as a fact distinct from closed', async () => {
    const { owner } = await scaffold('status-merged');
    const fake = fakeGithubWithStatus({
      pr: {
        state: 'closed',
        draft: false,
        merged_at: '2026-01-01T00:00:00Z',
        head: { sha: 'sha2' },
      },
      checkRuns: [],
    });
    const deps = depsFor(fake.fetch);
    await connectedGithub(owner, deps);

    const result = await getPullRequestStatus(owner, deps, { prNumber: 8 });

    expect(result.state).toBe('closed');
    expect(result.merged).toBe(true);
    expect(result.checksStatus).toBe('none');
  });

  it('rolls up a still-running check as pending, and a failed one as failure', async () => {
    const { owner } = await scaffold('status-checks');
    const pending = fakeGithubWithStatus({
      checkRuns: [
        { status: 'completed', conclusion: 'success' },
        { status: 'in_progress', conclusion: null },
      ],
    });
    const depsPending = depsFor(pending.fetch);
    await connectedGithub(owner, depsPending);
    expect((await getPullRequestStatus(owner, depsPending, { prNumber: 9 })).checksStatus).toBe(
      'pending',
    );

    const { owner: owner2 } = await scaffold('status-checks-failed');
    const failed = fakeGithubWithStatus({
      checkRuns: [
        { status: 'completed', conclusion: 'success' },
        { status: 'completed', conclusion: 'failure' },
      ],
    });
    const depsFailed = depsFor(failed.fetch);
    await connectedGithub(owner2, depsFailed);
    expect((await getPullRequestStatus(owner2, depsFailed, { prNumber: 9 })).checksStatus).toBe(
      'failure',
    );
  });

  it('degrades to checksStatus "none" when the checks endpoint fails, without failing the call', async () => {
    const { owner } = await scaffold('status-checks-degraded');
    const fake = fakeGithubWithStatus({ checkRunsStatus: 500 });
    const deps = depsFor(fake.fetch);
    await connectedGithub(owner, deps);

    const result = await getPullRequestStatus(owner, deps, { prNumber: 10 });

    expect(result.checksStatus).toBe('none');
  });

  it('refuses a member with no pr:view grant, before any network call', async () => {
    const { owner, member } = await scaffold('status-refused');
    const fake = fakeGithubWithStatus({});
    const deps = depsFor(fake.fetch);
    await connectedGithub(owner, deps);
    fake.calls.length = 0;

    await expect(getPullRequestStatus(member, deps, { prNumber: 1 })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(fake.calls).toHaveLength(0);
  });
});

/** `getPullRequestFileContent` needs the same `/pulls/{n}` JSON body
    `fakeGithubWithStatus` already builds (for the head sha) plus a
    `/contents/{path}` handler `fakeGithub`'s own diff-text route was never
    built for — a third small composition over the shared base, matching
    that file's own precedent rather than teaching one fake every shape. */
function fakeGithubWithFileContent(options: {
  readonly pr?: Record<string, unknown>;
  readonly prStatus?: number;
  readonly content?: string;
  readonly contentStatus?: number;
}): { fetch: typeof fetch; calls: string[] } {
  const fake = fakeGithub({});
  const pr = options.pr ?? {
    state: 'open',
    draft: false,
    merged_at: null,
    head: { sha: 'abc123' },
  };

  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes('/contents/')) {
      /* Pushed here, unlike `/pulls/\d+$/` and `/check-runs` below (matching
         `fakeGithubWithStatus`'s own precedent of not recording those) —
         this is the one call a real test below needs to inspect directly
         (the percent-encoded path), and it never falls through to
         `fake.fetch`, so there is no risk of the double-count that pushing
         BEFORE the fallthrough would create for every other URL. */
      fake.calls.push(url);
      return new Response(options.content ?? 'export const x = 1;\n', {
        status: options.contentStatus ?? 200,
        headers: { 'content-type': 'text/plain' },
      });
    }
    if (/\/pulls\/\d+$/.test(url)) {
      return new Response(JSON.stringify(pr), {
        status: options.prStatus ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return fake.fetch(input, init);
  }) as typeof fetch;

  return { fetch: fn, calls: fake.calls };
}

describe('getPullRequestFileContent', () => {
  it('returns the real file content, at the PR head', async () => {
    const { owner } = await scaffold('file-content-ok');
    const fake = fakeGithubWithFileContent({ content: 'export const x = 1;\n' });
    const deps = depsFor(fake.fetch);
    await connectedGithub(owner, deps);

    const result = await getPullRequestFileContent(owner, deps, {
      prNumber: 1,
      path: 'src/index.ts',
    });

    expect(result).toEqual({
      prNumber: 1,
      path: 'src/index.ts',
      truncated: false,
      content: 'export const x = 1;\n',
    });
  });

  it('percent-encodes each path segment, preserving slashes, without touching the PR head sha', async () => {
    const { owner } = await scaffold('file-content-encode');
    const fake = fakeGithubWithFileContent({
      pr: { state: 'open', draft: false, merged_at: null, head: { sha: 'deadbeef' } },
    });
    const deps = depsFor(fake.fetch);
    await connectedGithub(owner, deps);

    await getPullRequestFileContent(owner, deps, {
      prNumber: 1,
      path: 'src/a b/@weird#file.ts',
    });

    const contentsCall = fake.calls.find((call) => call.includes('/contents/'));
    expect(contentsCall).toBe(
      'https://api.github.com/repos/acme/todo/contents/src/a%20b/%40weird%23file.ts?ref=deadbeef',
    );
  });

  it('keeps the serialized result under the tool-result content budget for a large file', async () => {
    const { owner } = await scaffold('file-content-truncated');
    const fake = fakeGithubWithFileContent({ content: 'x'.repeat(25_000) });
    const deps = depsFor(fake.fetch);
    await connectedGithub(owner, deps);

    const result = await getPullRequestFileContent(owner, deps, {
      prNumber: 1,
      path: 'big.txt',
    });

    expect(result.truncated).toBe(true);
    expect(result.content).toContain('file truncated at');
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(20_000);
  });

  it("surfaces GitHub's 406 (a binary file, or one too large to render this way) with a real hint", async () => {
    const { owner } = await scaffold('file-content-406');
    const fake = fakeGithubWithFileContent({ contentStatus: 406 });
    const deps = depsFor(fake.fetch);
    await connectedGithub(owner, deps);

    await expect(
      getPullRequestFileContent(owner, deps, { prNumber: 1, path: 'logo.png' }),
    ).rejects.toThrow(/could not render this in the requested format/);
  });

  it('refuses a member with no pr:view grant, before any network call', async () => {
    const { owner, member } = await scaffold('file-content-refused');
    const fake = fakeGithubWithFileContent({});
    const deps = depsFor(fake.fetch);
    await connectedGithub(owner, deps);
    fake.calls.length = 0;

    await expect(
      getPullRequestFileContent(member, deps, { prNumber: 1, path: 'src/index.ts' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(fake.calls).toHaveLength(0);
  });
});

/** `getPullRequestFileDiff` pages through `/pulls/{n}/files` — the same
    endpoint `getPullRequestFiles` calls — looking for one filename, so the
    fake needs to answer per PAGE rather than a flat list the way
    `getPullRequestFiles`'s own inline wrapper does. `pages[i]` is what page
    `i + 1` (GitHub's own 1-based `page` param) returns. */
function fakeGithubWithFiles(pages: readonly (readonly Record<string, unknown>[])[]): {
  fetch: typeof fetch;
  calls: string[];
} {
  const fake = fakeGithub({});
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (/\/pulls\/\d+\/files/.test(url)) {
      fake.calls.push(url);
      const pageParam = new URL(url).searchParams.get('page');
      const page = pageParam === null ? 1 : Number(pageParam);
      const body = pages[page - 1] ?? [];
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return fake.fetch(input, init);
  }) as typeof fetch;
  return { fetch: fn, calls: fake.calls };
}

describe('getPullRequestFileDiff', () => {
  it("returns the matching file's own patch, not the whole PR's", async () => {
    const { owner } = await scaffold('file-diff-ok');
    const fake = fakeGithubWithFiles([
      [
        { filename: 'src/a.ts', patch: '@@ -1,2 +1,3 @@\n context\n-old\n+new\n' },
        { filename: 'src/b.ts', patch: '@@ -1 +1 @@\n-x\n+y\n' },
      ],
    ]);
    const deps = depsFor(fake.fetch);
    await connectedGithub(owner, deps);

    const result = await getPullRequestFileDiff(owner, deps, { prNumber: 4, path: 'src/b.ts' });

    expect(result).toEqual({
      prNumber: 4,
      path: 'src/b.ts',
      truncated: false,
      patch: '@@ -1 +1 @@\n-x\n+y\n',
    });
  });

  it('pages through the listing to find a file beyond the first 100', async () => {
    const { owner } = await scaffold('file-diff-paged');
    const filler = Array.from({ length: 100 }, (_, i) => ({
      filename: `src/filler-${String(i)}.ts`,
      patch: '@@ -1 +1 @@\n-a\n+b\n',
    }));
    const target = { filename: 'src/second-page.ts', patch: '@@ -1 +1 @@\n-p\n+q\n' };
    const fake = fakeGithubWithFiles([filler, [target]]);
    const deps = depsFor(fake.fetch);
    await connectedGithub(owner, deps);

    const result = await getPullRequestFileDiff(owner, deps, {
      prNumber: 4,
      path: 'src/second-page.ts',
    });

    expect(result.patch).toBe('@@ -1 +1 @@\n-p\n+q\n');
    expect(fake.calls.filter((call) => call.includes('/files')).length).toBe(2);
  });

  it('stops after MAX_FILE_DIFF_LOOKUP_PAGES pages rather than paging forever', async () => {
    const { owner } = await scaffold('file-diff-cap');
    const fullPage = Array.from({ length: 100 }, (_, i) => ({
      filename: `src/filler-${String(i)}.ts`,
      patch: '@@ -1 +1 @@\n-a\n+b\n',
    }));
    // A 6th page exists but must never be fetched.
    const fake = fakeGithubWithFiles([fullPage, fullPage, fullPage, fullPage, fullPage, fullPage]);
    const deps = depsFor(fake.fetch);
    await connectedGithub(owner, deps);

    await expect(
      getPullRequestFileDiff(owner, deps, { prNumber: 4, path: 'src/never-there.ts' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(fake.calls.filter((call) => call.includes('/files')).length).toBe(5);
  });

  it('refuses by name, naming get_pr_files, when the path matches no changed file', async () => {
    const { owner } = await scaffold('file-diff-nomatch');
    const fake = fakeGithubWithFiles([[{ filename: 'src/a.ts', patch: '@@ -1 +1 @@\n-x\n+y\n' }]]);
    const deps = depsFor(fake.fetch);
    await connectedGithub(owner, deps);

    await expect(
      getPullRequestFileDiff(owner, deps, { prNumber: 4, path: 'src/nope.ts' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      getPullRequestFileDiff(owner, deps, { prNumber: 4, path: 'src/nope.ts' }),
    ).rejects.toThrow(/is not one of the files this pull request changed/);
  });

  it('explains rather than fails when GitHub gives no patch (binary/too large/pure rename)', async () => {
    const { owner } = await scaffold('file-diff-nopatch');
    const fake = fakeGithubWithFiles([[{ filename: 'assets/logo.png', status: 'modified' }]]);
    const deps = depsFor(fake.fetch);
    await connectedGithub(owner, deps);

    const result = await getPullRequestFileDiff(owner, deps, {
      prNumber: 4,
      path: 'assets/logo.png',
    });

    expect(result.truncated).toBe(false);
    expect(result.patch).toContain('did not provide a line-by-line diff');
  });

  it('keeps the serialized result under the tool-result content budget for a huge patch', async () => {
    const { owner } = await scaffold('file-diff-truncated');
    const hugePatch = '@@ -1,1 +1,4000 @@\n' + '+line\n'.repeat(4000);
    const fake = fakeGithubWithFiles([[{ filename: 'src/big.ts', patch: hugePatch }]]);
    const deps = depsFor(fake.fetch);
    await connectedGithub(owner, deps);

    const result = await getPullRequestFileDiff(owner, deps, { prNumber: 4, path: 'src/big.ts' });

    expect(result.truncated).toBe(true);
    expect(result.patch).toContain('diff truncated at');
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(20_000);
  });

  it('refuses a member with no pr:view grant, before any network call', async () => {
    const { owner, member } = await scaffold('file-diff-refused');
    const fake = fakeGithubWithFiles([[{ filename: 'src/a.ts', patch: '@@ -1 +1 @@\n-x\n+y\n' }]]);
    const deps = depsFor(fake.fetch);
    await connectedGithub(owner, deps);
    fake.calls.length = 0;

    await expect(
      getPullRequestFileDiff(member, deps, { prNumber: 4, path: 'src/a.ts' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(fake.calls).toHaveLength(0);
  });
});
