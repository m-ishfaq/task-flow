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
  selectRepo,
  type IntegrationDeps,
} from './integration.service.js';
import {
  approvePr,
  closePr,
  mergePr,
  postPrComment,
  postPrFileComment,
  requestPrChanges,
} from './pr-write.service.js';

/**
 * `pr-write.service.ts` (ai/phase-15-ai-copilot-and-permissions.md §7 Wave 2).
 *
 * What is under test: `pr:review`/`pr:merge` are checked BEFORE any network
 * call, each function emits its own real domain event ONLY after GitHub's
 * effect actually succeeds (never before — a false entry in a hash-chained
 * log is worse than a missing one), and no event carries comment/review
 * text (`integration-events.ts`'s own rule for every outbound effect).
 */

const OWNER = unsafeAsId<'UserId'>('0195ee50-0000-7000-8000-000000000001');
const MEMBER = unsafeAsId<'UserId'>('0195ee50-0000-7000-8000-000000000002');

const USERS: readonly [UserId, string][] = [
  [OWNER, 'owner@pr-write-service.test'],
  [MEMBER, 'member@pr-write-service.test'],
];

const requestId = unsafeAsId<'RequestId'>('0195ee50-0000-7000-8000-0000000000ff');

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
  const uniqueSlug = `prw-${fixtureCounter.toString(36)}-${slug.slice(0, 8)}-${crypto.randomUUID().slice(0, 8)}`;
  const result = await orgs.createOrg(
    { name: `PR write ${slug}`, slug: uniqueSlug },
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

/** The org's own outbox events, in order, filtered to `integration.pr_*` —
    the scaffold's own `member.added` events are foreign fixtures here. Same
    raw-SQL shape `integration.service.test.ts`'s own `integrationEvents`
    helper uses. */
async function prEvents(
  orgId: OrgId,
): Promise<{ name: string; payload: Record<string, unknown> }[]> {
  await admin.setOrg(orgId);
  const result = await admin.query(
    `SELECT name, payload FROM platform.outbox
     WHERE org_id = $1 AND name LIKE 'integration.pr_%' ORDER BY occurred_at`,
    [orgId],
  );
  await admin.setOrg(null);
  return result.rows as { name: string; payload: Record<string, unknown> }[];
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

  initializeDatabase({ url: TEST_ENV.DATABASE_URL, applicationName: 'taskflow-pr-write-svc' });
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

function depsFor(fetchImpl: typeof fetch): IntegrationDeps {
  return {
    providers: { github: { clientId: 'github-client', clientSecret: 'github-secret' } },
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

interface FakeWriteOptions {
  readonly commentStatus?: number;
  readonly reviewStatus?: number;
  readonly mergeStatus?: number;
  readonly closeStatus?: number;
  /** The bare `GET .../pulls/{n}` `postPrFileComment` fetches first, for the
      PR's own head sha. */
  readonly prStatus?: number;
  readonly fileCommentStatus?: number;
}

/** Every real GitHub write in this file sends a JSON body — except the OAuth
    code exchange `connectedGithub` runs first to set up each test, which
    sends `application/x-www-form-urlencoded` (`exchangeGithubCode`'s own
    `URLSearchParams`, per GitHub's own token-endpoint contract). A bare
    `JSON.parse` on every string body crashes on that one call with
    `Unexpected token 'c', "code=c&cli"...` — this tolerates a body that
    isn't JSON by recording `undefined` for it, the same as a bodyless GET. */
function parseJsonBody(body: unknown): unknown {
  if (typeof body !== 'string') return undefined;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

/** `bodies` is parallel to `calls` (same index for the same request) — a
    `GET` carries no body, so that slot is `undefined` — added specifically
    for `postPrFileComment`'s own tests, which need to prove `subject_type`/
    `line`/`side` were actually sent, not just that a 2xx came back. */
function fakeGithub(options: FakeWriteOptions = {}): {
  fetch: typeof fetch;
  calls: string[];
  bodies: unknown[];
} {
  const calls: string[] = [];
  const bodies: unknown[] = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  const fn = ((input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    bodies.push(parseJsonBody(init?.body));

    if (url === 'https://github.com/login/oauth/access_token') {
      return Promise.resolve(json({ access_token: 'gho_test_token' }));
    }
    if (url === 'https://api.github.com/user') return Promise.resolve(json({ login: 'octocat' }));
    if (url.startsWith('https://api.github.com/user/repos')) {
      return Promise.resolve(json([{ name: 'todo', full_name: 'acme/todo' }]));
    }
    if (init?.method === 'POST' && url.includes('/issues/') && url.endsWith('/comments')) {
      const status = options.commentStatus ?? 201;
      return Promise.resolve(json(status < 400 ? { id: 501 } : { message: 'nope' }, status));
    }
    if (init?.method === 'POST' && url.endsWith('/reviews')) {
      const status = options.reviewStatus ?? 200;
      return Promise.resolve(json(status < 400 ? { id: 502 } : { message: 'nope' }, status));
    }
    if (init?.method === 'PUT' && url.endsWith('/merge')) {
      const status = options.mergeStatus ?? 200;
      return Promise.resolve(
        json(status < 400 ? { merged: true, sha: 'abc123' } : { message: 'not mergeable' }, status),
      );
    }
    if (init?.method === 'PATCH' && /\/pulls\/\d+$/.test(url)) {
      const status = options.closeStatus ?? 200;
      return Promise.resolve(
        json(status < 400 ? { state: 'closed' } : { message: 'nope' }, status),
      );
    }
    if ((init?.method ?? 'GET') === 'GET' && /\/pulls\/\d+$/.test(url)) {
      const status = options.prStatus ?? 200;
      return Promise.resolve(
        json(status < 400 ? { head: { sha: 'deadbeef' } } : { message: 'nope' }, status),
      );
    }
    if (init?.method === 'POST' && /\/pulls\/\d+\/comments$/.test(url)) {
      const status = options.fileCommentStatus ?? 201;
      return Promise.resolve(json(status < 400 ? { id: 601 } : { message: 'nope' }, status));
    }
    throw new Error(`unexpected call: ${url} (${init?.method ?? 'GET'})`);
  }) as typeof fetch;

  return { fetch: fn, calls, bodies };
}

async function connectedGithub(actor: AutomationActor, deps: IntegrationDeps): Promise<void> {
  const { state } = await beginState(actor, deps);
  const pending = await completeIntegration(
    deps,
    { provider: 'github', code: 'c', state },
    requestId,
  );
  if (pending.status !== 'pending_repo')
    throw new Error('github connect did not reach repo choice');
  await selectRepo(actor, deps, { integrationId: pending.integrationId, fullName: 'acme/todo' });
}

describe('postPrComment', () => {
  it('posts, returns the repo scope, and records the effect after it succeeds', async () => {
    const { owner } = await scaffold('comment-ok');
    const fake = fakeGithub();
    const deps = depsFor(fake.fetch);
    await connectedGithub(owner, deps);

    const result = await postPrComment(owner, deps, { prNumber: 7, body: 'looks good' });

    expect(result).toEqual({ commentId: 501, providerScope: 'acme/todo' });
    const events = await prEvents(owner.subject.orgId);
    expect(events.map((e) => e.name)).toEqual(['integration.pr_comment_posted']);
    expect(events[0]?.payload).toMatchObject({ prNumber: 7, providerCommentId: 501 });
    // No comment text in the event, per this file's own rule.
    expect(JSON.stringify(events[0]?.payload)).not.toContain('looks good');
  });

  it('refuses a member with no pr:review grant, before any network call', async () => {
    const { owner, member } = await scaffold('comment-refused');
    const fake = fakeGithub();
    const deps = depsFor(fake.fetch);
    await connectedGithub(owner, deps);
    fake.calls.length = 0;

    await expect(postPrComment(member, deps, { prNumber: 7, body: 'x' })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(fake.calls).toHaveLength(0);
  });

  it('a 404 from GitHub is refused and writes no event', async () => {
    const { owner } = await scaffold('comment-404');
    const fake = fakeGithub({ commentStatus: 404 });
    const deps = depsFor(fake.fetch);
    await connectedGithub(owner, deps);

    await expect(postPrComment(owner, deps, { prNumber: 999, body: 'x' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(await prEvents(owner.subject.orgId)).toEqual([]);
  });
});

describe('postPrFileComment', () => {
  it('defaults to a file-level comment (subject_type: file, no line) when line is omitted', async () => {
    const { owner } = await scaffold('file-comment-default');
    const fake = fakeGithub();
    const deps = depsFor(fake.fetch);
    await connectedGithub(owner, deps);

    const result = await postPrFileComment(owner, deps, {
      prNumber: 12,
      path: 'apps/api/src/ai/complete.ts',
      body: 'this could use a comment',
    });

    expect(result).toEqual({
      commentId: 601,
      path: 'apps/api/src/ai/complete.ts',
      providerScope: 'acme/todo',
    });
    const postIndex = fake.calls.findIndex((url) => url.endsWith('/pulls/12/comments'));
    expect(postIndex).toBeGreaterThanOrEqual(0);
    expect(fake.bodies[postIndex]).toMatchObject({
      commit_id: 'deadbeef',
      path: 'apps/api/src/ai/complete.ts',
      subject_type: 'file',
    });
    expect(fake.bodies[postIndex]).not.toHaveProperty('line');
    expect(fake.bodies[postIndex]).not.toHaveProperty('side');

    const events = await prEvents(owner.subject.orgId);
    expect(events.map((e) => e.name)).toEqual(['integration.pr_file_comment_posted']);
    expect(events[0]?.payload).toMatchObject({
      prNumber: 12,
      path: 'apps/api/src/ai/complete.ts',
      providerCommentId: 601,
    });
    // No comment text, and no line number — see the event's own doc comment.
    expect(JSON.stringify(events[0]?.payload)).not.toContain('this could use a comment');
    expect(events[0]?.payload).not.toHaveProperty('line');
  });

  it('pins to the new side of a given line', async () => {
    const { owner } = await scaffold('file-comment-line');
    const fake = fakeGithub();
    const deps = depsFor(fake.fetch);
    await connectedGithub(owner, deps);

    await postPrFileComment(owner, deps, {
      prNumber: 12,
      path: 'apps/api/src/ai/complete.ts',
      body: 'fix this line',
      line: 42,
    });

    const postIndex = fake.calls.findIndex((url) => url.endsWith('/pulls/12/comments'));
    expect(fake.bodies[postIndex]).toMatchObject({ line: 42, side: 'RIGHT' });
    expect(fake.bodies[postIndex]).not.toHaveProperty('subject_type');
  });

  it('refuses a member with no pr:review grant, before any network call', async () => {
    const { owner, member } = await scaffold('file-comment-refused');
    const fake = fakeGithub();
    const deps = depsFor(fake.fetch);
    await connectedGithub(owner, deps);
    fake.calls.length = 0;

    await expect(
      postPrFileComment(member, deps, { prNumber: 12, path: 'x.ts', body: 'x' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(fake.calls).toHaveLength(0);
  });

  it(
    'a 422 (line not part of the diff) is refused naming get_pr_files/get_pr_file_diff as the ' +
      'recovery path, not the generic 422 hint',
    async () => {
      const { owner } = await scaffold('file-comment-422');
      const fake = fakeGithub({ fileCommentStatus: 422 });
      const deps = depsFor(fake.fetch);
      await connectedGithub(owner, deps);

      let caught: unknown;
      try {
        await postPrFileComment(owner, deps, {
          prNumber: 12,
          path: 'apps/api/src/ai/complete.ts',
          body: 'x',
          line: 9999,
        });
      } catch (error) {
        caught = error;
      }

      expect(caught).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain('get_pr_files');
      expect((caught as Error).message).toContain('get_pr_file_diff');
      expect(await prEvents(owner.subject.orgId)).toEqual([]);
    },
  );

  it('a failure to resolve the head sha is refused before any comment is posted', async () => {
    const { owner } = await scaffold('file-comment-nopr');
    const fake = fakeGithub({ prStatus: 404 });
    const deps = depsFor(fake.fetch);
    await connectedGithub(owner, deps);

    await expect(
      postPrFileComment(owner, deps, { prNumber: 999, path: 'x.ts', body: 'x' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(fake.calls.some((url) => url.endsWith('/pulls/999/comments'))).toBe(false);
    expect(await prEvents(owner.subject.orgId)).toEqual([]);
  });
});

describe('requestPrChanges', () => {
  it('submits a REQUEST_CHANGES review', async () => {
    const { owner } = await scaffold('review-ok');
    const fake = fakeGithub();
    const deps = depsFor(fake.fetch);
    await connectedGithub(owner, deps);

    const result = await requestPrChanges(owner, deps, { prNumber: 3, body: 'please fix x' });

    expect(result).toEqual({ reviewId: 502, providerScope: 'acme/todo' });
    const events = await prEvents(owner.subject.orgId);
    expect(events[0]).toMatchObject({
      name: 'integration.pr_review_submitted',
      payload: { prNumber: 3, event: 'REQUEST_CHANGES', providerReviewId: 502 },
    });
  });

  it(
    "a 422 (GitHub refusing a review on the connector's own pull request) is refused with an " +
      'actionable message naming `pr_post_comment` as the working alternative, not the generic ' +
      '422 hint — found from a real transcript where the generic hint left the model with an ' +
      'accurate but dead-end answer',
    async () => {
      const { owner } = await scaffold('review-own-pr');
      const fake = fakeGithub({ reviewStatus: 422 });
      const deps = depsFor(fake.fetch);
      await connectedGithub(owner, deps);

      let caught: unknown;
      try {
        await requestPrChanges(owner, deps, { prNumber: 3, body: 'please fix x' });
      } catch (error) {
        caught = error;
      }

      expect(caught).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain('pr_post_comment');
      expect(await prEvents(owner.subject.orgId)).toEqual([]);
    },
  );
});

describe('approvePr', () => {
  it('submits an APPROVE review', async () => {
    const { owner } = await scaffold('approve-ok');
    const fake = fakeGithub();
    const deps = depsFor(fake.fetch);
    await connectedGithub(owner, deps);

    const result = await approvePr(owner, deps, { prNumber: 3 });

    expect(result).toEqual({ reviewId: 502, providerScope: 'acme/todo' });
    const events = await prEvents(owner.subject.orgId);
    expect(events[0]).toMatchObject({
      name: 'integration.pr_review_submitted',
      payload: { prNumber: 3, event: 'APPROVE', providerReviewId: 502 },
    });
  });

  it('an optional body is passed through and never appears in the event', async () => {
    const { owner } = await scaffold('approve-body');
    const fake = fakeGithub();
    const deps = depsFor(fake.fetch);
    await connectedGithub(owner, deps);

    await approvePr(owner, deps, { prNumber: 3, body: 'ship it' });
    const events = await prEvents(owner.subject.orgId);
    expect(JSON.stringify(events[0]?.payload)).not.toContain('ship it');
  });

  it("a 422 (GitHub refusing a review on the connector's own PR) names pr_post_comment as the alternative", async () => {
    const { owner } = await scaffold('approve-own-pr');
    const fake = fakeGithub({ reviewStatus: 422 });
    const deps = depsFor(fake.fetch);
    await connectedGithub(owner, deps);

    let caught: unknown;
    try {
      await approvePr(owner, deps, { prNumber: 3 });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    expect((caught as Error).message).toContain('pr_post_comment');
    expect(await prEvents(owner.subject.orgId)).toEqual([]);
  });

  it('refuses a member with no pr:review grant, before any network call', async () => {
    const { owner, member } = await scaffold('approve-refused');
    const fake = fakeGithub();
    const deps = depsFor(fake.fetch);
    await connectedGithub(owner, deps);
    fake.calls.length = 0;

    await expect(approvePr(member, deps, { prNumber: 3 })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(fake.calls).toHaveLength(0);
  });
});

describe('mergePr', () => {
  it('merges and records the sha', async () => {
    const { owner } = await scaffold('merge-ok');
    const fake = fakeGithub();
    const deps = depsFor(fake.fetch);
    await connectedGithub(owner, deps);

    const result = await mergePr(owner, deps, { prNumber: 5 });

    expect(result).toEqual({ merged: true, sha: 'abc123', providerScope: 'acme/todo' });
    const events = await prEvents(owner.subject.orgId);
    expect(events[0]).toMatchObject({
      name: 'integration.pr_merged',
      payload: { prNumber: 5, sha: 'abc123' },
    });
  });

  it('a not-mergeable PR (405) is refused and writes no event', async () => {
    const { owner } = await scaffold('merge-405');
    const fake = fakeGithub({ mergeStatus: 405 });
    const deps = depsFor(fake.fetch);
    await connectedGithub(owner, deps);

    await expect(mergePr(owner, deps, { prNumber: 5 })).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
    expect(await prEvents(owner.subject.orgId)).toEqual([]);
  });

  it('refuses a member with no pr:merge grant, before any network call', async () => {
    const { owner, member } = await scaffold('merge-refused');
    const fake = fakeGithub();
    const deps = depsFor(fake.fetch);
    await connectedGithub(owner, deps);
    fake.calls.length = 0;

    await expect(mergePr(member, deps, { prNumber: 5 })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(fake.calls).toHaveLength(0);
  });
});

describe('closePr', () => {
  it('closes without merging', async () => {
    const { owner } = await scaffold('close-ok');
    const fake = fakeGithub();
    const deps = depsFor(fake.fetch);
    await connectedGithub(owner, deps);

    const result = await closePr(owner, deps, { prNumber: 9 });

    expect(result).toEqual({ closed: true, providerScope: 'acme/todo' });
    const events = await prEvents(owner.subject.orgId);
    expect(events[0]).toMatchObject({ name: 'integration.pr_closed', payload: { prNumber: 9 } });
  });
});
