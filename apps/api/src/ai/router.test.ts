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
import { resetEntitlementCache } from '../billing/entitlement-resolver.js';
import { createProviderConfig } from './provider-config.service.js';
import type { PlatformOperator } from '../platform-admin/org-directory.service.js';

/**
 * `ai.chat.send`, through the real tRPC router (Phase 15 §4.3 Wave 1).
 *
 * The lower-level pieces (the tool-calling loop, the budget gate, provider
 * resolution, the key envelope) are each proven in their own suite against
 * real Postgres — `assistant.test.ts`, `spend-gate.test.ts`,
 * `complete.test.ts`, `provider-config.service.test.ts`. This file's job is
 * narrower: prove the ROUTE wires them correctly — the `ai:use` permission
 * gate and the `aiAssistant` feature-flag gate both actually run, in the
 * order `route()` itself documents, on this specific route.
 */

const OWNER = unsafeAsId<'UserId'>('0195f400-0000-7000-8000-000000000001');
const MEMBER = unsafeAsId<'UserId'>('0195f400-0000-7000-8000-000000000002');
const OPERATOR = unsafeAsId<'UserId'>('0195f400-0000-7000-8000-000000000003');
const requestId = unsafeAsId<'RequestId'>('0195f400-0000-7000-8000-0000000000ff');

const USERS: readonly [UserId, string][] = [
  [OWNER, 'owner@ai-router.test'],
  [MEMBER, 'member@ai-router.test'],
  [OPERATOR, 'operator@ai-router.test'],
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

/** A fabricated principal for a real org — `route()`'s permission and
    feature checks both read `ctx.principal.org`, never the database, so a
    `testPrincipal` override is sufficient; only the HANDLER's own
    `loadMembershipId` and entitlement reads touch real rows, which is why
    `newOrg` above (via `orgs.createOrg`) must have created a genuine
    membership for OWNER first. */
function principalFor(role: 'owner' | 'member', userId: UserId, orgId: OrgId) {
  return testPrincipal(role, {
    userId,
    org: { orgId, role, tuples: [], memberGrants: [] },
  });
}

/** Grants the org's plan the `aiAssistant` flag via an operator override — the
    same `billing.org_entitlements.features_add` mechanism
    `entitlement-resolver.test.ts` exercises directly. */
async function grantAiAssistant(orgId: OrgId): Promise<void> {
  await admin.setOrg(orgId);
  await admin.query(
    `INSERT INTO billing.org_entitlements (org_id, features_add, reason)
     VALUES ($1, ARRAY['aiAssistant'], 'ai router test')
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

  initializeDatabase({ url: TEST_ENV.DATABASE_URL, applicationName: 'ai-router-test' });
  initializeSearchDatabase({ url: TEST_ENV.DATABASE_URL, applicationName: 'ai-router-search-test' });
  initializePlatformAdminDatabase({
    url:
      process.env['TEST_DATABASE_PLATFORM_ADMIN_URL'] ??
      'postgresql://taskflow_platform_admin:platform-admin-dev-secret@localhost:5433/taskflow_test',
    applicationName: 'ai-router-platform-admin-test',
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

describe('ai.chat.send', () => {
  it('refuses a member with no ai:use permission before ever resolving a provider', async () => {
    const orgId = await newOrg('ai-router-forbidden');
    await grantAiAssistant(orgId);

    const context = testContext({ principal: principalFor('member', MEMBER, orgId) });
    const caller = callerFactory(context);

    const error = await caller.ai.chat
      .send({ messages: [{ role: 'user', content: 'Hi' }] })
      .catch((caught: unknown) => caught);

    expect((error as { code?: string }).code).toBe('FORBIDDEN');
  });

  it('refuses when the org plan does not include aiAssistant, even for the owner', async () => {
    const orgId = await newOrg('ai-router-plan-required');
    // Deliberately no grantAiAssistant call — the fresh trial plan does not
    // list this flag.

    const context = testContext({ principal: principalFor('owner', OWNER, orgId) });
    const caller = callerFactory(context);

    const error = await caller.ai.chat
      .send({ messages: [{ role: 'user', content: 'Hi' }] })
      .catch((caught: unknown) => caught);

    expect((error as { code?: string }).code).toBe('FORBIDDEN');
    expect((error as { cause?: { code?: string } }).cause?.code).toBe('PLAN_REQUIRED');
  });

  it('answers end to end for an owner once both gates are open', async () => {
    const orgId = await newOrg('ai-router-happy');
    await grantAiAssistant(orgId);

    await createProviderConfig({ events: new RecordingEventBus() }, keys, operatorOf(OPERATOR), {
      provider: 'anthropic',
      model: 'claude-sonnet-4',
      apiKey: 'sk-ant-router-test',
      label: 'Router test default',
      isDefault: true,
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              content: [{ type: 'text', text: 'Hello from the assistant.' }],
              stop_reason: 'end_turn',
              usage: { input_tokens: 12, output_tokens: 6 },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        ),
      ),
    );

    const context = testContext({ principal: principalFor('owner', OWNER, orgId) });
    const caller = callerFactory(context);

    const result = await caller.ai.chat.send({ messages: [{ role: 'user', content: 'Hi' }] });

    expect(result.content).toBe('Hello from the assistant.');
    expect(result.toolRounds).toBe(0);

    await admin.setOrg(orgId);
    const ledgerRows = await admin.query(`SELECT id FROM ai.usage_ledger WHERE org_id = $1`, [orgId]);
    await admin.setOrg(null);
    expect(ledgerRows.rowCount).toBe(1);
  });
});
