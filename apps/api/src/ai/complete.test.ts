import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { unsafeAsId, type MembershipId, type OrgId } from '@taskflow/contracts';
import { closeDatabase, initializeDatabase, schema, withOrgScope } from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import { FakeAiProvider } from '@taskflow/ai';
import { TEST_ENV } from '../testing/fixtures.js';
import * as orgs from '../tenancy/org.service.js';
import { resetEntitlementCache } from '../billing/entitlement-resolver.js';
import { completeGated, type AiCompletionActor } from './complete.js';

/**
 * `completeGated` — THE call site that ties the budget gate to
 * `AiProvider.complete` (ai/phase-15-ai-copilot-and-permissions.md §3.2).
 *
 * The property that matters most, restated from `spend-gate.ts`'s own
 * header: when the gate refuses, `provider.calls` must stay EMPTY.
 * `spend-gate.test.ts` already proves the decision logic in isolation; this
 * file proves the orchestration around it does not call the provider on the
 * refused path, and does record a real ledger row (priced from
 * `rates.ts`) on the allowed one.
 */

const OWNER = unsafeAsId<'UserId'>('0195f100-0000-7000-8000-000000000001');
const requestId = unsafeAsId<'RequestId'>('0195f100-0000-7000-8000-0000000000ff');

let admin: AdminConnection;
let created: OrgId[] = [];

async function newOrg(slug: string): Promise<{ orgId: OrgId; membershipId: MembershipId }> {
  const result = await orgs.createOrg({ name: `Org ${slug}`, slug }, { userId: OWNER, requestId });
  created.push(result.orgId);

  await admin.setOrg(result.orgId);
  const rows = await admin.query(
    `SELECT id FROM identity.memberships WHERE org_id = $1 AND user_id = $2`,
    [result.orgId, OWNER],
  );
  await admin.setOrg(null);

  const membershipId = rows.rows[0]?.['id'];
  if (typeof membershipId !== 'string') throw new Error('Expected an owner membership to exist.');

  return { orgId: result.orgId, membershipId: unsafeAsId<'MembershipId'>(membershipId) };
}

async function removeOrg(orgId: string): Promise<void> {
  await admin.setOrg(orgId);
  await admin.query(`DELETE FROM platform.outbox WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM ai.usage_ledger WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM billing.org_entitlements WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM authz.relationship_tuples WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM identity.memberships WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM identity.orgs WHERE id = $1`, [orgId]);
  await admin.setOrg(null);
}

async function setBudget(orgId: OrgId, cents: number | null): Promise<void> {
  await admin.setOrg(orgId);
  await admin.query(
    `INSERT INTO billing.org_entitlements (org_id, reason, ai_token_budget_monthly_cents)
     VALUES ($1, 'ai complete test', $2)
     ON CONFLICT (org_id) DO UPDATE SET ai_token_budget_monthly_cents = $2`,
    [orgId, cents],
  );
  await admin.setOrg(null);
  resetEntitlementCache();
}

async function spend(orgId: OrgId, costCents: number): Promise<void> {
  await withOrgScope(orgId, async (tx) => {
    await tx.insert(schema.aiUsageLedger).values({
      id: unsafeAsId<'AiUsageLedgerId'>('0195f100-1111-7000-8000-000000000abc'),
      orgId,
      feature: 'test',
      provider: 'fake',
      model: 'test-model',
      inputTokens: 1,
      outputTokens: 1,
      costCents,
    });
  });
}

function actorOf(orgId: OrgId, membershipId: MembershipId): AiCompletionActor {
  return { orgId, userId: OWNER, membershipId, requestId };
}

beforeAll(async () => {
  await applyMigrations();
  admin = await connectAsMigrator();

  await admin.setOrg(null);
  await admin.query(`DELETE FROM identity.users WHERE id = $1`, [OWNER]);
  await admin.query(
    `INSERT INTO identity.users (id, email, email_normalized, email_verified_at)
     VALUES ($1, 'owner@ai-complete.test', 'owner@ai-complete.test', now())`,
    [OWNER],
  );

  initializeDatabase({ url: TEST_ENV.DATABASE_URL, applicationName: 'taskflow-ai-complete-test' });
});

beforeEach(async () => {
  for (const orgId of created) await removeOrg(orgId);
  created = [];
});

afterAll(async () => {
  for (const orgId of created) await removeOrg(orgId);
  await admin.setOrg(null);
  await admin.query(`DELETE FROM identity.users WHERE id = $1`, [OWNER]);
  await admin.end();
  await closeDatabase();
});

describe('completeGated — the refused path', () => {
  it('never calls the provider once the org has reached its budget', async () => {
    const { orgId, membershipId } = await newOrg('ai-complete-refused');
    await setBudget(orgId, 100);
    await spend(orgId, 100);

    const provider = new FakeAiProvider();

    await expect(
      completeGated(provider, actorOf(orgId, membershipId), {
        feature: 'test',
        providerName: 'fake',
        model: 'claude-sonnet-4',
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED' });

    expect(provider.calls).toHaveLength(0);
  });

  it('writes no ledger row for a refused request', async () => {
    const { orgId, membershipId } = await newOrg('ai-complete-refused-no-row');
    await setBudget(orgId, 0);

    const provider = new FakeAiProvider();

    await expect(
      completeGated(provider, actorOf(orgId, membershipId), {
        feature: 'test',
        providerName: 'fake',
        model: 'claude-sonnet-4',
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    ).rejects.toBeDefined();

    await admin.setOrg(orgId);
    const rows = await admin.query(`SELECT id FROM ai.usage_ledger WHERE org_id = $1`, [orgId]);
    await admin.setOrg(null);
    expect(rows.rowCount).toBe(0);
  });
});

describe('completeGated — the allowed path', () => {
  it('calls the provider once and records a ledger row priced from rates.ts', async () => {
    const { orgId, membershipId } = await newOrg('ai-complete-allowed');
    const provider = new FakeAiProvider();
    provider.enqueue({
      content: 'Hi there.',
      toolCalls: [],
      usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      stopReason: 'end_turn',
    });

    const result = await completeGated(provider, actorOf(orgId, membershipId), {
      feature: 'standup',
      providerName: 'anthropic',
      model: 'claude-sonnet-4',
      messages: [{ role: 'user', content: 'Hello' }],
    });

    expect(result.content).toBe('Hi there.');
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]?.orgId).toBe(orgId);

    await admin.setOrg(orgId);
    const rows = await admin.query(
      `SELECT cost_cents, feature, provider FROM ai.usage_ledger WHERE org_id = $1`,
      [orgId],
    );
    await admin.setOrg(null);

    expect(rows.rowCount).toBe(1);
    // claude-sonnet-4: 300 input + 1500 output cents per million tokens.
    expect(rows.rows[0]?.['cost_cents']).toBe('1800');
    expect(rows.rows[0]?.['feature']).toBe('standup');
    expect(rows.rows[0]?.['provider']).toBe('anthropic');
  });
});
