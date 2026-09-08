import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { unsafeAsId, type OrgId, type RequestId } from '@taskflow/contracts';
import { closeDatabase, initializeDatabase } from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import { masterKeysFromBase64, SoftwareKeyProvider } from '@taskflow/security';
import type { Subject } from '@taskflow/policy';
import { TEST_ENV } from '../../testing/fixtures.js';
import * as orgs from '../../tenancy/org.service.js';
import { loadTuples } from '../../tenancy/resolve.js';
import {
  beginIntegration,
  completeIntegration,
  selectRepo,
  type IntegrationDeps,
} from '../../automation/integration.service.js';
import type { AutomationActor } from '../../automation/automation.service.js';
import * as projects from '../../work/project.service.js';
import * as boards from '../../work/board.service.js';
import * as lists from '../../work/list.service.js';
import * as cards from '../../work/card.service.js';
import {
  createCardLinkPrTool,
  createCreateBranchFromCardTool,
  createGetPrCommentsTool,
  createGetPrDiffTool,
  createGetPrFileContentTool,
  createGetPrFileDiffTool,
  createGetPrFilesTool,
  createListCardPrsTool,
  createListPrsTool,
  createListReposTool,
  createPrApproveTool,
  createPrCloseTool,
  createPrCommentOnFileTool,
  createPrMergeTool,
  createPrPostCommentTool,
  createPrRequestChangesTool,
} from './pr.js';
import type { ToolContext } from './registry.js';

/**
 * The `pr.ts` TOOL WRAPPERS (ai/phase-15-ai-copilot-and-permissions.md §7,
 * Wave 1) — proving the `defineTool` contract (Zod validation, error
 * surfacing, `requiresConfirmation`) rather than re-proving GitHub API
 * handling, which `apps/api/src/automation/pr-read.service.test.ts` already
 * covers thoroughly.
 */

const OWNER = unsafeAsId<'UserId'>('0195f900-0000-7000-8000-000000000001');
const requestId: RequestId = unsafeAsId<'RequestId'>('0195f900-0000-7000-8000-0000000000ff');

const MASTER_KEY_ID = 'test-master';
const keys = new SoftwareKeyProvider({
  currentMasterKeyId: MASTER_KEY_ID,
  masterKeys: masterKeysFromBase64({ [MASTER_KEY_ID]: Buffer.alloc(32, 7).toString('base64') }),
});

let admin: AdminConnection;
const created: OrgId[] = [];

async function newOrg(slug: string): Promise<OrgId> {
  const result = await orgs.createOrg({ name: `Org ${slug}`, slug }, { userId: OWNER, requestId });
  created.push(result.orgId);
  return result.orgId;
}

async function removeOrg(orgId: string): Promise<void> {
  await admin.setOrg(orgId);
  /* Children before parents: a link before its card, a card before its
     list/board/project, per this codebase's own standing teardown rule
     (`tenancy-seed.ts`'s `clearTenant`, `sprint.service.test.ts`'s own
     `removeOrg`). */
  for (const table of [
    'platform.outbox',
    'platform.integrations',
    'work.card_pull_requests',
    'work.cards',
    'work.lists',
    'work.views',
    'work.boards',
    'work.projects',
    'authz.relationship_tuples',
    'identity.memberships',
  ]) {
    await admin.query(`DELETE FROM ${table} WHERE org_id = $1`, [orgId]);
  }
  await admin.query(`DELETE FROM identity.orgs WHERE id = $1`, [orgId]);
  await admin.setOrg(null);
}

async function ownerSubject(orgId: OrgId): Promise<Subject> {
  const tuples = await loadTuples(orgId, OWNER);
  return { orgId, userId: OWNER, role: 'owner', tuples };
}

async function ownerCtx(orgId: OrgId): Promise<ToolContext> {
  return { subject: await ownerSubject(orgId), requestId };
}

function guestCtx(orgId: OrgId): ToolContext {
  return { subject: { orgId, userId: OWNER, role: 'guest', tuples: [] }, requestId };
}

beforeAll(async () => {
  await applyMigrations();
  admin = await connectAsMigrator();
  await admin.setOrg(null);
  await admin.query(`DELETE FROM identity.users WHERE id = $1`, [OWNER]);
  await admin.query(
    `INSERT INTO identity.users (id, email, email_normalized, email_verified_at)
     VALUES ($1, $2, $2, now())`,
    [OWNER, 'owner@ai-pr-tools.test'],
  );
  initializeDatabase({ url: TEST_ENV.DATABASE_URL, applicationName: 'taskflow-ai-pr-tools' });
});

afterAll(async () => {
  await closeDatabase();
  for (const orgId of created) await removeOrg(orgId);
  await admin.setOrg(null);
  await admin.query(`DELETE FROM identity.users WHERE id = $1`, [OWNER]);
  await admin.end();
});

function integrationDeps(fetchImpl: typeof fetch): IntegrationDeps {
  return {
    providers: { github: { clientId: 'c', clientSecret: 's' } },
    redirectUri: () => 'https://app.test/integrations/callback/github',
    webhookOrigin: 'https://app.test',
    jwtStateSecret: Buffer.alloc(32, 9),
    keys,
    fetchImpl,
  };
}

/** A fake covering the GitHub connect flow plus one PR (#1) on `acme/todo` —
    reads AND writes. Matches on METHOD as well as URL, since a write's PATCH
    to `/pulls/1` shares a URL shape with the read side's GET diff request. */
function fakeGithub(): { fetch: typeof fetch } {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  const fn = ((input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? 'GET';

    if (url === 'https://github.com/login/oauth/access_token') {
      return Promise.resolve(json({ access_token: 'gho_test' }));
    }
    if (url === 'https://api.github.com/user') return Promise.resolve(json({ login: 'octocat' }));
    if (url.startsWith('https://api.github.com/user/repos')) {
      return Promise.resolve(json([{ name: 'todo', full_name: 'acme/todo' }]));
    }
    if (method === 'GET' && url.endsWith('/pulls/1')) {
      return Promise.resolve(
        new Response('diff --git a/x b/x\n', {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        }),
      );
    }
    if (method === 'GET' && url.includes('/pulls?')) {
      return Promise.resolve(
        json([
          {
            number: 1,
            title: 'Fix login bug',
            state: 'open',
            draft: false,
            user: { login: 'alice' },
            html_url: 'https://github.com/acme/todo/pull/1',
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
            base: { ref: 'main' },
            head: { ref: 'fix' },
          },
        ]),
      );
    }
    if (method === 'GET' && url.includes('/issues/1/comments')) {
      return Promise.resolve(
        json([
          {
            id: 1,
            body: 'looks good',
            created_at: '2026-01-01T00:00:00Z',
            html_url: 'https://github.com/acme/todo/pull/1#issuecomment-1',
            user: { login: 'bob' },
          },
        ]),
      );
    }
    if (method === 'GET' && url.includes('/pulls/1/comments')) return Promise.resolve(json([]));
    if (method === 'GET' && url.includes('/pulls/1/files')) {
      return Promise.resolve(
        json([
          {
            filename: 'src/index.ts',
            status: 'modified',
            additions: 3,
            deletions: 1,
            patch: '@@ -1,2 +1,3 @@\n context\n-old\n+new\n',
          },
        ]),
      );
    }
    if (method === 'POST' && url.includes('/issues/1/comments')) {
      return Promise.resolve(json({ id: 501 }, 201));
    }
    // PR #2 exists solely for `pr_comment_on_file`'s own tests: GET
    // `/pulls/1` above already answers with a plain-text diff body (for
    // `get_pr_diff`), which is not valid JSON — `postPrFileComment`'s own
    // `GET .../pulls/{n}` needs a real `{head: {sha}}` JSON response, so it
    // needs a PR number the diff handler above doesn't already own.
    if (method === 'GET' && url.endsWith('/pulls/2')) {
      return Promise.resolve(json({ head: { sha: 'deadbeef' } }));
    }
    if (method === 'POST' && url.endsWith('/pulls/2/comments')) {
      return Promise.resolve(json({ id: 601 }, 201));
    }
    if (method === 'POST' && url.endsWith('/pulls/1/reviews')) {
      return Promise.resolve(json({ id: 502 }, 200));
    }
    if (method === 'PUT' && url.endsWith('/pulls/1/merge')) {
      return Promise.resolve(json({ merged: true, sha: 'abc123' }, 200));
    }
    if (method === 'PATCH' && url.endsWith('/pulls/1')) {
      return Promise.resolve(json({ state: 'closed' }, 200));
    }
    // Branch-from-card endpoints — the requested ref never exists yet, the
    // repo's default branch is `main`, and creating the new ref succeeds.
    if (method === 'GET' && url.includes('/git/ref/heads/') && !url.endsWith('/heads/main')) {
      return Promise.resolve(json({ message: 'not found' }, 404));
    }
    if (method === 'GET' && url.endsWith('/git/ref/heads/main')) {
      return Promise.resolve(json({ object: { sha: 'base-sha-123' } }));
    }
    if (method === 'GET' && url === 'https://api.github.com/repos/acme/todo') {
      return Promise.resolve(json({ default_branch: 'main' }));
    }
    if (method === 'POST' && url.endsWith('/git/refs')) {
      return Promise.resolve(json({ ref: 'refs/heads/x' }, 201));
    }
    throw new Error(`unexpected call: ${method} ${url}`);
  }) as typeof fetch;

  return { fetch: fn };
}

async function connectRepo(ctx: ToolContext, deps: IntegrationDeps): Promise<void> {
  const actor: AutomationActor = { subject: ctx.subject, requestId };
  const { authorizationUrl } = await beginIntegration(actor, deps, { provider: 'github' });
  const state = new URL(authorizationUrl).searchParams.get('state');
  if (state === null) throw new Error('no state');
  const pending = await completeIntegration(
    deps,
    { provider: 'github', code: 'c', state },
    requestId,
  );
  if (pending.status !== 'pending_repo') throw new Error('did not reach repo choice');
  await selectRepo(actor, deps, { integrationId: pending.integrationId, fullName: 'acme/todo' });
}

async function makeCard(ctx: ToolContext): Promise<string> {
  const workActor = { subject: ctx.subject, requestId };
  const project = await projects.createProject(workActor, {
    name: 'Website',
    key: 'WEB',
    description: null,
  });
  const board = await boards.createBoard(workActor, {
    projectId: project.projectId,
    name: 'Delivery',
  });
  const list = await lists.createList(workActor, {
    boardId: board.boardId,
    name: 'Todo',
    wipLimit: null,
  });
  const card = await cards.createCard(workActor, {
    listId: list.listId,
    title: 'Fix login bug',
    description: null,
  });
  return card.cardId;
}

describe('requiresConfirmation', () => {
  it('is false for all seven PR read tools', () => {
    const deps = integrationDeps(fakeGithub().fetch);
    expect(createListReposTool().requiresConfirmation).toBe(false);
    expect(createListPrsTool(deps).requiresConfirmation).toBe(false);
    expect(createGetPrDiffTool(deps).requiresConfirmation).toBe(false);
    expect(createGetPrFilesTool(deps).requiresConfirmation).toBe(false);
    expect(createGetPrFileContentTool(deps).requiresConfirmation).toBe(false);
    expect(createGetPrFileDiffTool(deps).requiresConfirmation).toBe(false);
    expect(createGetPrCommentsTool(deps).requiresConfirmation).toBe(false);
  });

  it('is true for all six PR write tools, with no exceptions', () => {
    const deps = integrationDeps(fakeGithub().fetch);
    expect(createPrPostCommentTool(deps).requiresConfirmation).toBe(true);
    expect(createPrCommentOnFileTool(deps).requiresConfirmation).toBe(true);
    expect(createPrRequestChangesTool(deps).requiresConfirmation).toBe(true);
    expect(createPrApproveTool(deps).requiresConfirmation).toBe(true);
    expect(createPrMergeTool(deps).requiresConfirmation).toBe(true);
    expect(createPrCloseTool(deps).requiresConfirmation).toBe(true);
  });

  it('is false for list_card_prs and true for card_link_pr / create_branch_from_card', () => {
    const deps = integrationDeps(fakeGithub().fetch);
    expect(createListCardPrsTool().requiresConfirmation).toBe(false);
    expect(createCardLinkPrTool(deps).requiresConfirmation).toBe(true);
    expect(createCreateBranchFromCardTool(deps).requiresConfirmation).toBe(true);
  });
});

describe('malformed input', () => {
  it('returns an isError result naming the tool, never a throw', async () => {
    const orgId = await newOrg('pr-malformed');
    const ctx = await ownerCtx(orgId);
    const deps = integrationDeps(fakeGithub().fetch);

    const result = await createGetPrDiffTool(deps).execute(ctx, { prNumber: 'not-a-number' });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('get_pr_diff');
  });
});

describe('a guest with no pr:view/pr:review/pr:merge/repo:connect grant', () => {
  it('gets an isError result, not a thrown error, for every PR tool', async () => {
    const orgId = await newOrg('pr-guest');
    const ownerContext = await ownerCtx(orgId);
    const deps = integrationDeps(fakeGithub().fetch);
    await connectRepo(ownerContext, deps);
    const cardId = await makeCard(ownerContext);
    const ctx = guestCtx(orgId);

    for (const result of [
      await createListReposTool().execute(ctx, {}),
      await createListPrsTool(deps).execute(ctx, {}),
      await createGetPrFilesTool(deps).execute(ctx, { prNumber: 1 }),
      await createGetPrFileDiffTool(deps).execute(ctx, { prNumber: 1, path: 'src/index.ts' }),
      await createPrPostCommentTool(deps).execute(ctx, { prNumber: 1, body: 'x' }),
      await createPrCommentOnFileTool(deps).execute(ctx, {
        prNumber: 2,
        path: 'src/index.ts',
        body: 'x',
      }),
      await createPrRequestChangesTool(deps).execute(ctx, { prNumber: 1, body: 'x' }),
      await createPrApproveTool(deps).execute(ctx, { prNumber: 1 }),
      await createPrMergeTool(deps).execute(ctx, { prNumber: 1 }),
      await createPrCloseTool(deps).execute(ctx, { prNumber: 1 }),
      await createCreateBranchFromCardTool(deps).execute(ctx, { cardId }),
    ]) {
      expect(result.isError).toBe(true);
      expect(result.content).toContain('permission');
    }
  });
});

describe('success paths', () => {
  it('list_repos returns the connected repo', async () => {
    const orgId = await newOrg('pr-repos-ok');
    const ctx = await ownerCtx(orgId);
    const deps = integrationDeps(fakeGithub().fetch);
    await connectRepo(ctx, deps);

    const result = await createListReposTool().execute(ctx, {});
    const parsed = JSON.parse(result.content) as { providerScope: string }[];

    expect(parsed).toEqual([{ providerScope: 'acme/todo' }]);
  });

  it('get_pr_files returns the shape the frontend renderer expects', async () => {
    const orgId = await newOrg('pr-files-ok');
    const ctx = await ownerCtx(orgId);
    const deps = integrationDeps(fakeGithub().fetch);
    await connectRepo(ctx, deps);

    const result = await createGetPrFilesTool(deps).execute(ctx, { prNumber: 1 });
    const parsed = JSON.parse(result.content) as { path: string; status: string }[];

    expect(parsed).toEqual([expect.objectContaining({ path: 'src/index.ts', status: 'modified' })]);
  });

  it("get_pr_file_diff returns just the one file's own patch", async () => {
    const orgId = await newOrg('pr-file-diff-ok');
    const ctx = await ownerCtx(orgId);
    const deps = integrationDeps(fakeGithub().fetch);
    await connectRepo(ctx, deps);

    const result = await createGetPrFileDiffTool(deps).execute(ctx, {
      prNumber: 1,
      path: 'src/index.ts',
    });
    const parsed = JSON.parse(result.content) as {
      path: string;
      truncated: boolean;
      patch: string;
    };

    expect(parsed).toEqual({
      prNumber: 1,
      path: 'src/index.ts',
      truncated: false,
      patch: '@@ -1,2 +1,3 @@\n context\n-old\n+new\n',
    });
  });

  it('pr_approve returns the shape the frontend renderer expects', async () => {
    const orgId = await newOrg('pr-approve-ok');
    const ctx = await ownerCtx(orgId);
    const deps = integrationDeps(fakeGithub().fetch);
    await connectRepo(ctx, deps);

    const result = await createPrApproveTool(deps).execute(ctx, { prNumber: 1 });
    const parsed = JSON.parse(result.content) as { reviewId: number; providerScope: string };

    expect(parsed).toEqual({ reviewId: 502, providerScope: 'acme/todo' });
  });

  it('list_prs returns the shape the frontend renderer expects', async () => {
    const orgId = await newOrg('pr-list-ok');
    const ctx = await ownerCtx(orgId);
    const deps = integrationDeps(fakeGithub().fetch);
    await connectRepo(ctx, deps);

    const result = await createListPrsTool(deps).execute(ctx, {});
    const parsed = JSON.parse(result.content) as { number: number; title: string }[];

    expect(parsed).toEqual([expect.objectContaining({ number: 1, title: 'Fix login bug' })]);
  });

  it('get_pr_diff returns truncated/diff', async () => {
    const orgId = await newOrg('pr-diff-ok');
    const ctx = await ownerCtx(orgId);
    const deps = integrationDeps(fakeGithub().fetch);
    await connectRepo(ctx, deps);

    const result = await createGetPrDiffTool(deps).execute(ctx, { prNumber: 1 });
    const parsed = JSON.parse(result.content) as { truncated: boolean; diff: string };

    expect(parsed).toEqual({ prNumber: 1, truncated: false, diff: 'diff --git a/x b/x\n' });
  });

  it('get_pr_comments returns kind-tagged comments', async () => {
    const orgId = await newOrg('pr-comments-ok');
    const ctx = await ownerCtx(orgId);
    const deps = integrationDeps(fakeGithub().fetch);
    await connectRepo(ctx, deps);

    const result = await createGetPrCommentsTool(deps).execute(ctx, { prNumber: 1 });
    const parsed = JSON.parse(result.content) as { kind: string }[];

    expect(parsed).toEqual([expect.objectContaining({ kind: 'general', author: 'bob' })]);
  });

  it('pr_post_comment returns the shape the frontend renderer expects', async () => {
    const orgId = await newOrg('pr-post-comment-ok');
    const ctx = await ownerCtx(orgId);
    const deps = integrationDeps(fakeGithub().fetch);
    await connectRepo(ctx, deps);

    const result = await createPrPostCommentTool(deps).execute(ctx, { prNumber: 1, body: 'lgtm' });
    const parsed = JSON.parse(result.content) as { commentId: number; providerScope: string };

    expect(parsed).toEqual({ commentId: 501, providerScope: 'acme/todo' });
  });

  it('pr_comment_on_file returns the shape the frontend renderer expects', async () => {
    const orgId = await newOrg('pr-comment-on-file-ok');
    const ctx = await ownerCtx(orgId);
    const deps = integrationDeps(fakeGithub().fetch);
    await connectRepo(ctx, deps);

    const result = await createPrCommentOnFileTool(deps).execute(ctx, {
      prNumber: 2,
      path: 'src/index.ts',
      body: 'this could use a comment',
    });
    const parsed = JSON.parse(result.content) as {
      commentId: number;
      path: string;
      providerScope: string;
    };

    expect(parsed).toEqual({ commentId: 601, path: 'src/index.ts', providerScope: 'acme/todo' });
  });

  it('pr_request_changes returns the shape the frontend renderer expects', async () => {
    const orgId = await newOrg('pr-request-changes-ok');
    const ctx = await ownerCtx(orgId);
    const deps = integrationDeps(fakeGithub().fetch);
    await connectRepo(ctx, deps);

    const result = await createPrRequestChangesTool(deps).execute(ctx, {
      prNumber: 1,
      body: 'please fix x',
    });
    const parsed = JSON.parse(result.content) as { reviewId: number; providerScope: string };

    expect(parsed).toEqual({ reviewId: 502, providerScope: 'acme/todo' });
  });

  it('pr_merge returns the shape the frontend renderer expects', async () => {
    const orgId = await newOrg('pr-merge-ok');
    const ctx = await ownerCtx(orgId);
    const deps = integrationDeps(fakeGithub().fetch);
    await connectRepo(ctx, deps);

    const result = await createPrMergeTool(deps).execute(ctx, { prNumber: 1 });
    const parsed = JSON.parse(result.content) as {
      merged: boolean;
      sha: string;
      providerScope: string;
    };

    expect(parsed).toEqual({ merged: true, sha: 'abc123', providerScope: 'acme/todo' });
  });

  it('pr_close returns the shape the frontend renderer expects', async () => {
    const orgId = await newOrg('pr-close-ok');
    const ctx = await ownerCtx(orgId);
    const deps = integrationDeps(fakeGithub().fetch);
    await connectRepo(ctx, deps);

    const result = await createPrCloseTool(deps).execute(ctx, { prNumber: 1 });
    const parsed = JSON.parse(result.content) as { closed: boolean; providerScope: string };

    expect(parsed).toEqual({ closed: true, providerScope: 'acme/todo' });
  });
});

describe('card_link_pr / list_card_prs', () => {
  it('links a PR to a card, resolving providerScope from the connector, and lists it back', async () => {
    const orgId = await newOrg('card-link-pr-ok');
    const ctx = await ownerCtx(orgId);
    const deps = integrationDeps(fakeGithub().fetch);
    await connectRepo(ctx, deps);
    const cardId = await makeCard(ctx);

    const linked = await createCardLinkPrTool(deps).execute(ctx, { cardId, prNumber: 1 });
    expect(linked.isError).toBeUndefined();
    expect(JSON.parse(linked.content)).toEqual({ linked: true });

    const listed = await createListCardPrsTool().execute(ctx, { cardId });
    const parsed = JSON.parse(listed.content) as {
      providerScope: string;
      prNumber: number;
      linkedBy: string;
      linkedAt: string;
    }[];
    expect(parsed).toEqual([
      expect.objectContaining({ providerScope: 'acme/todo', prNumber: 1, linkedBy: OWNER }),
    ]);
    expect(typeof parsed[0]?.linkedAt).toBe('string');
  });

  it('card_link_pr never reaches the network — only the connector row is read', async () => {
    const orgId = await newOrg('card-link-pr-no-fetch');
    const ctx = await ownerCtx(orgId);
    const deps = integrationDeps(fakeGithub().fetch);
    await connectRepo(ctx, deps);
    const cardId = await makeCard(ctx);

    let fetchCount = 0;
    const inner = fakeGithub().fetch;
    const countingFetch = ((input: string | URL | Request, init?: RequestInit) => {
      fetchCount += 1;
      return inner(input, init);
    }) as typeof fetch;

    await createCardLinkPrTool({ keys, fetchImpl: countingFetch }).execute(ctx, {
      cardId,
      prNumber: 1,
    });

    expect(fetchCount).toBe(0);
  });

  it('refuses a guest with no card:update', async () => {
    const orgId = await newOrg('card-link-pr-guest');
    const ownerContext = await ownerCtx(orgId);
    const deps = integrationDeps(fakeGithub().fetch);
    await connectRepo(ownerContext, deps);
    const cardId = await makeCard(ownerContext);

    const result = await createCardLinkPrTool(deps).execute(guestCtx(orgId), {
      cardId,
      prNumber: 1,
    });
    expect(result.isError).toBe(true);
  });
});

describe('create_branch_from_card', () => {
  it('creates a branch named deterministically from the card reference and title', async () => {
    const orgId = await newOrg('branch-create-ok');
    const ctx = await ownerCtx(orgId);
    const deps = integrationDeps(fakeGithub().fetch);
    await connectRepo(ctx, deps);
    const cardId = await makeCard(ctx);

    const result = await createCreateBranchFromCardTool(deps).execute(ctx, { cardId });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content) as {
      branchName: string;
      alreadyExisted: boolean;
      providerScope: string;
    };

    expect(parsed).toEqual(
      expect.objectContaining({
        branchName: 'web-1-fix-login-bug',
        alreadyExisted: false,
        providerScope: 'acme/todo',
      }),
    );
  });
});
