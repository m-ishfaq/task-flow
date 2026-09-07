import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  unsafeAsId,
  type CardId,
  type OrgId,
  type RequestId,
  type UserId,
} from '@taskflow/contracts';
import { closeDatabase, initializeDatabase } from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import { masterKeysFromBase64, SoftwareKeyProvider } from '@taskflow/security';
import { TEST_ENV } from '../testing/fixtures.js';
import * as orgs from '../tenancy/org.service.js';
import * as members from '../tenancy/member.service.js';
import { loadTuples } from '../tenancy/resolve.js';
import * as projects from '../work/project.service.js';
import * as boards from '../work/board.service.js';
import * as lists from '../work/list.service.js';
import * as cardsSvc from '../work/card.service.js';
import type { WorkActor } from '../work/shared.js';
import {
  beginIntegration,
  completeIntegration,
  selectRepo,
  type IntegrationDeps,
} from './integration.service.js';
import { createBranchFromCard } from './branch.service.js';

/**
 * `branch.service.ts` (ai/phase-15-ai-copilot-and-permissions.md §7.2's last
 * unbuilt action, Wave 3).
 *
 * What is under test: `repo:connect` is checked before any GitHub call; the
 * branch name is deterministic — `<reference>-<slug>`, built server-side,
 * never asked of the model; an already-existing branch is reported back
 * with `alreadyExisted: true` rather than treated as a failure; and the
 * `integration.branch_created` event is written only after GitHub's own ref
 * creation actually succeeds.
 */

const OWNER = unsafeAsId<'UserId'>('0195ee60-0000-7000-8000-000000000001');
const MEMBER = unsafeAsId<'UserId'>('0195ee60-0000-7000-8000-000000000002');

const USERS: readonly [UserId, string][] = [
  [OWNER, 'owner@branch-service.test'],
  [MEMBER, 'member@branch-service.test'],
];

const requestId: RequestId = unsafeAsId<'RequestId'>('0195ee60-0000-7000-8000-0000000000ff');

const MASTER_KEY_ID = 'test-master';
const keys = new SoftwareKeyProvider({
  currentMasterKeyId: MASTER_KEY_ID,
  masterKeys: masterKeysFromBase64({ [MASTER_KEY_ID]: Buffer.alloc(32, 7).toString('base64') }),
});

let admin: AdminConnection;
let created: OrgId[] = [];
let fixtureCounter = 0;

async function actorFor(
  orgId: OrgId,
  userId: UserId,
  role: WorkActor['subject']['role'],
): Promise<WorkActor> {
  const tuples = await loadTuples(orgId, userId);
  return { subject: { orgId, userId, role, tuples }, requestId };
}

async function scaffold(slug: string): Promise<{
  orgId: OrgId;
  owner: WorkActor;
  member: WorkActor;
}> {
  fixtureCounter += 1;
  const uniqueSlug = `br-${fixtureCounter.toString(36)}-${slug.slice(0, 8)}-${crypto.randomUUID().slice(0, 8)}`;
  const result = await orgs.createOrg(
    { name: `Branch ${slug}`, slug: uniqueSlug },
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

async function seedCard(
  actor: WorkActor,
): Promise<{ readonly cardId: CardId; readonly reference: string }> {
  const project = await projects.createProject(actor, {
    name: 'Website',
    key: 'WEB',
    description: null,
  });
  const board = await boards.createBoard(actor, { projectId: project.projectId, name: 'Delivery' });
  const list = await lists.createList(actor, {
    boardId: board.boardId,
    name: 'Todo',
    wipLimit: null,
  });
  const card = await cardsSvc.createCard(actor, {
    listId: list.listId,
    title: 'Fix login redirect!!',
    description: null,
  });
  return card;
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
    'work.cards',
    'work.sprints',
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

  initializeDatabase({ url: TEST_ENV.DATABASE_URL, applicationName: 'taskflow-branch-svc' });
});

beforeEach(async () => {
  for (const orgId of created) await removeOrg(orgId);
  created = [];
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

async function beginState(actor: WorkActor, deps: IntegrationDeps): Promise<{ state: string }> {
  const { authorizationUrl } = await beginIntegration(actor, deps, { provider: 'github' });
  const state = new URL(authorizationUrl).searchParams.get('state');
  if (state === null) throw new Error('no state in authorization URL');
  return { state };
}

async function connectedGithub(actor: WorkActor, deps: IntegrationDeps): Promise<void> {
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

interface FakeBranchOptions {
  readonly refExists?: boolean;
  readonly defaultBranch?: string;
  readonly createStatus?: number;
}

function fakeGithub(options: FakeBranchOptions = {}): { fetch: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const defaultBranch = options.defaultBranch ?? 'main';

  const fn = ((input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);

    if (url === 'https://github.com/login/oauth/access_token') {
      return Promise.resolve(json({ access_token: 'gho_test_token' }));
    }
    if (url === 'https://api.github.com/user') return Promise.resolve(json({ login: 'octocat' }));
    if (url.startsWith('https://api.github.com/user/repos')) {
      return Promise.resolve(json([{ name: 'todo', full_name: 'acme/todo' }]));
    }
    if (url.includes('/git/ref/heads/') && !url.includes(defaultBranch)) {
      return Promise.resolve(
        options.refExists === true
          ? json({ ref: `refs/heads/x` })
          : json({ message: 'not found' }, 404),
      );
    }
    if (url === `https://api.github.com/repos/acme/todo`) {
      return Promise.resolve(json({ default_branch: defaultBranch }));
    }
    if (url.includes(`/git/ref/heads/${defaultBranch}`)) {
      return Promise.resolve(json({ object: { sha: 'base-sha-123' } }));
    }
    if (init?.method === 'POST' && url.endsWith('/git/refs')) {
      const status = options.createStatus ?? 201;
      return Promise.resolve(
        json(status < 400 ? { ref: 'refs/heads/x' } : { message: 'nope' }, status),
      );
    }
    throw new Error(`unexpected call: ${url} (${init?.method ?? 'GET'})`);
  }) as typeof fetch;

  return { fetch: fn, calls };
}

async function prEvents(
  orgId: OrgId,
): Promise<{ name: string; payload: Record<string, unknown> }[]> {
  await admin.setOrg(orgId);
  const result = await admin.query(
    `SELECT name, payload FROM platform.outbox
     WHERE org_id = $1 AND name = 'integration.branch_created' ORDER BY occurred_at`,
    [orgId],
  );
  await admin.setOrg(null);
  return result.rows as { name: string; payload: Record<string, unknown> }[];
}

describe('createBranchFromCard', () => {
  it('creates a real branch, named deterministically from the card reference and title', async () => {
    const { owner } = await scaffold('create-ok');
    const { cardId, reference } = await seedCard(owner);
    const fake = fakeGithub();
    const deps = depsFor(fake.fetch);
    await connectedGithub(owner, deps);

    const result = await createBranchFromCard(owner, deps, { cardId });

    expect(result.alreadyExisted).toBe(false);
    expect(result.branchName).toBe(`${reference.toLowerCase()}-fix-login-redirect`);
    expect(result.url).toBe(`https://github.com/acme/todo/tree/${result.branchName}`);
    expect(result.providerScope).toBe('acme/todo');

    const events = await prEvents(owner.subject.orgId);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({ cardId, branchName: result.branchName });
  });

  it('reports an existing branch back rather than treating it as a failure, and writes no event', async () => {
    const { owner } = await scaffold('create-exists');
    const { cardId } = await seedCard(owner);
    const fake = fakeGithub({ refExists: true });
    const deps = depsFor(fake.fetch);
    await connectedGithub(owner, deps);

    const result = await createBranchFromCard(owner, deps, { cardId });

    expect(result.alreadyExisted).toBe(true);
    expect(await prEvents(owner.subject.orgId)).toEqual([]);
  });

  it('refuses a member with no repo:connect grant, before any network call', async () => {
    const { owner, member } = await scaffold('create-refused');
    const { cardId } = await seedCard(owner);
    const fake = fakeGithub();
    const deps = depsFor(fake.fetch);
    await connectedGithub(owner, deps);
    fake.calls.length = 0;

    await expect(createBranchFromCard(member, deps, { cardId })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(fake.calls).toHaveLength(0);
  });

  it('a failed ref-creation call is refused and writes no event', async () => {
    const { owner } = await scaffold('create-fails');
    const { cardId } = await seedCard(owner);
    const fake = fakeGithub({ createStatus: 422 });
    const deps = depsFor(fake.fetch);
    await connectedGithub(owner, deps);

    await expect(createBranchFromCard(owner, deps, { cardId })).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
    });
    expect(await prEvents(owner.subject.orgId)).toEqual([]);
  });
});
