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
import {
  createGetPrCommentsTool,
  createGetPrDiffTool,
  createListPrsTool,
  createPrCloseTool,
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
  for (const table of [
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
    if (method === 'POST' && url.includes('/issues/1/comments')) {
      return Promise.resolve(json({ id: 501 }, 201));
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

describe('requiresConfirmation', () => {
  it('is false for all three PR read tools', () => {
    const deps = integrationDeps(fakeGithub().fetch);
    expect(createListPrsTool(deps).requiresConfirmation).toBe(false);
    expect(createGetPrDiffTool(deps).requiresConfirmation).toBe(false);
    expect(createGetPrCommentsTool(deps).requiresConfirmation).toBe(false);
  });

  it('is true for all four PR write tools, with no exceptions', () => {
    const deps = integrationDeps(fakeGithub().fetch);
    expect(createPrPostCommentTool(deps).requiresConfirmation).toBe(true);
    expect(createPrRequestChangesTool(deps).requiresConfirmation).toBe(true);
    expect(createPrMergeTool(deps).requiresConfirmation).toBe(true);
    expect(createPrCloseTool(deps).requiresConfirmation).toBe(true);
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

describe('a guest with no pr:view/pr:review/pr:merge grant', () => {
  it('gets an isError result, not a thrown error, for every PR tool', async () => {
    const orgId = await newOrg('pr-guest');
    const deps = integrationDeps(fakeGithub().fetch);
    const ctx = guestCtx(orgId);

    for (const result of [
      await createListPrsTool(deps).execute(ctx, {}),
      await createPrPostCommentTool(deps).execute(ctx, { prNumber: 1, body: 'x' }),
      await createPrRequestChangesTool(deps).execute(ctx, { prNumber: 1, body: 'x' }),
      await createPrMergeTool(deps).execute(ctx, { prNumber: 1 }),
      await createPrCloseTool(deps).execute(ctx, { prNumber: 1 }),
    ]) {
      expect(result.isError).toBe(true);
      expect(result.content).toContain('permission');
    }
  });
});

describe('success paths', () => {
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
