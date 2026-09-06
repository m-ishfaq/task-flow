import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { unsafeAsId, type OrgId, type UserId } from '@taskflow/contracts';
import {
  closeDatabase,
  initializeDatabase,
  initializePlatformAdminDatabase,
  initializeSearchDatabase,
} from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import { SoftwareKeyProvider } from '@taskflow/security';
import { RecordingEventBus } from '@taskflow/events';
import { createCallerFactory } from '../trpc/builder.js';
import { TEST_ENV, testAppRouter, testContext, testPrincipal } from '../testing/fixtures.js';
import * as orgs from '../tenancy/org.service.js';
import * as projects from '../work/project.service.js';
import type { WorkActor } from '../work/shared.js';
import { resetEntitlementCache } from '../billing/entitlement-resolver.js';
import { createProviderConfig } from '../ai/provider-config.service.js';
import type { PlatformOperator } from '../platform-admin/org-directory.service.js';

/**
 * `standup.query` and `standup.narrate`, through the real tRPC router
 * (ai/phase-15-ai-copilot-and-permissions.md §5).
 *
 * The query logic itself is proven against real Postgres in
 * `standup.service.test.ts`; this file's job is the ROUTE's own gates —
 * `project:read` for `query`, and `ai:use` + `aiAssistant` for `narrate`,
 * in addition to (never instead of) `queryStandup`'s own internal check —
 * plus one real end-to-end narration with a stubbed provider response,
 * mirroring `ai/router.test.ts`'s own pattern for the identical reason: the
 * real `AnthropicProvider` speaks raw `fetch`, so stubbing global `fetch` is
 * what lets this run the full path without a real API key.
 */

const OWNER = unsafeAsId<'UserId'>('0195f500-0000-7000-8000-000000000001');
const MEMBER = unsafeAsId<'UserId'>('0195f500-0000-7000-8000-000000000002');
const OPERATOR = unsafeAsId<'UserId'>('0195f500-0000-7000-8000-000000000003');
const requestId = unsafeAsId<'RequestId'>('0195f500-0000-7000-8000-0000000000ff');

const USERS: readonly [UserId, string][] = [
  [OWNER, 'owner@standup-router.test'],
  [MEMBER, 'member@standup-router.test'],
  [OPERATOR, 'operator@standup-router.test'],
];

const MASTER_KEY_ID = TEST_ENV.MASTER_KEY_ID;
const keys = new SoftwareKeyProvider({
  currentMasterKeyId: MASTER_KEY_ID,
  masterKeys: [{ id: MASTER_KEY_ID, key: Buffer.from(TEST_ENV.MASTER_KEY_BASE64, 'base64') }],
});

function operatorOf(userId: UserId): PlatformOperator {
  return { userId, requestId };
}

let admin: AdminConnection;
const created: OrgId[] = [];

async function newOrg(slug: string): Promise<OrgId> {
  const result = await orgs.createOrg({ name: `Org ${slug}`, slug }, { userId: OWNER, requestId });
  created.push(result.orgId);
  return result.orgId;
}

/** A fabricated principal for a real org — see `ai/router.test.ts`'s identical helper. */
function principalFor(role: 'owner' | 'member', userId: UserId, orgId: OrgId) {
  return testPrincipal(role, {
    userId,
    org: { orgId, role, tuples: [], memberGrants: [] },
  });
}

async function grantAiAssistant(orgId: OrgId): Promise<void> {
  await admin.setOrg(orgId);
  await admin.query(
    `INSERT INTO billing.org_entitlements (org_id, features_add, reason)
     VALUES ($1, ARRAY['aiAssistant'], 'standup router test')
     ON CONFLICT (org_id) DO UPDATE SET features_add = ARRAY['aiAssistant']`,
    [orgId],
  );
  await admin.setOrg(null);
  resetEntitlementCache();
}

async function removeOrg(orgId: string): Promise<void> {
  await admin.setOrg(orgId);
  await admin.query(`DELETE FROM platform.outbox WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM ai.usage_ledger WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM platform.ai_org_overrides WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM billing.org_entitlements WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM work.cards WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM work.projects WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM authz.relationship_tuples WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM identity.memberships WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM identity.orgs WHERE id = $1`, [orgId]);
  await admin.setOrg(null);
}

const { router: appRouter } = testAppRouter();
const callerFactory = createCallerFactory(appRouter);

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

  initializeDatabase({ url: TEST_ENV.DATABASE_URL, applicationName: 'standup-router-test' });
  initializeSearchDatabase({
    url: TEST_ENV.DATABASE_URL,
    applicationName: 'standup-router-search-test',
  });
  initializePlatformAdminDatabase({
    url:
      process.env['TEST_DATABASE_PLATFORM_ADMIN_URL'] ??
      'postgresql://taskflow_platform_admin:platform-admin-dev-secret@localhost:5433/taskflow_test',
    applicationName: 'standup-router-platform-admin-test',
  });
});

beforeEach(async () => {
  for (const orgId of created) await removeOrg(orgId);
  created.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  for (const orgId of created) await removeOrg(orgId);
  await admin.query(`DELETE FROM platform.ai_provider_config`);
  await admin.query(`DELETE FROM platform.operator_audit_log WHERE operator_id = $1`, [OPERATOR]);
  await admin.setOrg(null);
  await admin.query(`DELETE FROM identity.users WHERE id = ANY($1::uuid[])`, [
    USERS.map(([id]) => id),
  ]);
  await admin.end();
  await closeDatabase();
});

/**
 * Only used to create the fixture project via the real service — a bare
 * role-only actor (no tuples loaded) is enough since the owner holds every
 * permission by role alone.
 */
function ownerActor(orgId: OrgId): WorkActor {
  return { subject: { orgId, userId: OWNER, role: 'owner', tuples: [] }, requestId };
}

describe('standup.query', () => {
  it('refuses a guest at the ROUTE floor — FORBIDDEN, before queryStandup ever runs', async () => {
    /* FORBIDDEN here, not the NOT_FOUND `standup.service.test.ts` asserts
       for the identical guest: `route({ permission: 'project:read' })` is a
       plain role-only floor and answers before the handler — and therefore
       before `queryStandup`'s own `requireProject` — ever runs, so the
       smarter "reveal less" NOT_FOUND that `enforceOn`'s resource-aware
       check gives never comes into play at this layer. `member` role alone
       genuinely holds `project:read` (it is not individually granted), so
       this needs a role the matrix gives nothing to at all — `guest`, with
       no tuples — for the refusal to be real rather than a fixture mistake. */
    const orgId = await newOrg('standup-router-query-forbidden');
    const owner = ownerActor(orgId);
    const project = await projects.createProject(owner, {
      name: 'Website',
      key: 'WEB',
      description: null,
    });

    const context = testContext({
      principal: testPrincipal('guest', {
        userId: MEMBER,
        org: { orgId, role: 'guest', tuples: [], memberGrants: [] },
      }),
    });
    const caller = callerFactory(context);

    const error = await caller.standup
      .query({ projectId: project.projectId })
      .catch((caught: unknown) => caught);

    expect((error as { code?: string }).code).toBe('FORBIDDEN');
  });

  it('answers for an owner', async () => {
    const orgId = await newOrg('standup-router-query-ok');
    const owner = ownerActor(orgId);
    const project = await projects.createProject(owner, {
      name: 'Website',
      key: 'WEB',
      description: null,
    });

    const context = testContext({ principal: principalFor('owner', OWNER, orgId) });
    const caller = callerFactory(context);

    const result = await caller.standup.query({ projectId: project.projectId });
    expect(result.sprint).toBeNull();
    expect(result.members).toEqual([]);
  });
});

describe('standup.narrate', () => {
  it('refuses a member with no ai:use permission before ever resolving a provider', async () => {
    const orgId = await newOrg('standup-router-narrate-forbidden');
    await grantAiAssistant(orgId);
    const owner = ownerActor(orgId);
    const project = await projects.createProject(owner, {
      name: 'Website',
      key: 'WEB',
      description: null,
    });

    const context = testContext({ principal: principalFor('member', MEMBER, orgId) });
    const caller = callerFactory(context);

    const error = await caller.standup
      .narrate({ projectId: project.projectId })
      .catch((caught: unknown) => caught);

    expect((error as { code?: string }).code).toBe('FORBIDDEN');
  });

  it('refuses when the org plan does not include aiAssistant, even for the owner', async () => {
    const orgId = await newOrg('standup-router-narrate-plan');
    const owner = ownerActor(orgId);
    const project = await projects.createProject(owner, {
      name: 'Website',
      key: 'WEB',
      description: null,
    });

    const context = testContext({ principal: principalFor('owner', OWNER, orgId) });
    const caller = callerFactory(context);

    const error = await caller.standup
      .narrate({ projectId: project.projectId })
      .catch((caught: unknown) => caught);

    expect((error as { code?: string }).code).toBe('FORBIDDEN');
    expect((error as { cause?: { code?: string } }).cause?.code).toBe('PLAN_REQUIRED');
  });

  it('narrates end to end for an owner once both gates are open', async () => {
    const orgId = await newOrg('standup-router-narrate-happy');
    await grantAiAssistant(orgId);
    const owner = ownerActor(orgId);
    const project = await projects.createProject(owner, {
      name: 'Website',
      key: 'WEB',
      description: null,
    });

    await createProviderConfig({ events: new RecordingEventBus() }, keys, operatorOf(OPERATOR), {
      provider: 'anthropic',
      model: 'claude-sonnet-4',
      apiKey: 'sk-ant-standup-router-test',
      label: 'Standup router test default',
      isDefault: true,
    });

    /* No cards exist for this fresh project, so `standup.members` is empty
       and `narrate.ts` asks the model to call the tool with a matching
       empty `lines` array — the stub mirrors Anthropic's real `tool_use`
       content-block shape (`packages/ai/src/anthropic.ts`'s own
       `AnthropicContentBlock`), not a plain-text response, since the route
       now REQUIRES the model to answer through the tool. */
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              content: [
                {
                  type: 'tool_use',
                  id: 'toolu_standup_router_test',
                  name: 'emit_standup_lines',
                  input: { lines: [] },
                },
              ],
              stop_reason: 'tool_use',
              usage: { input_tokens: 40, output_tokens: 8 },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        ),
      ),
    );

    const context = testContext({ principal: principalFor('owner', OWNER, orgId) });
    const caller = callerFactory(context);

    const result = await caller.standup.narrate({ projectId: project.projectId });
    expect(result.lines).toEqual([]);

    await admin.setOrg(orgId);
    const ledgerRows = await admin.query(`SELECT feature FROM ai.usage_ledger WHERE org_id = $1`, [
      orgId,
    ]);
    await admin.setOrg(null);
    expect(ledgerRows.rows).toEqual([{ feature: 'standup' }]);
  });
});
