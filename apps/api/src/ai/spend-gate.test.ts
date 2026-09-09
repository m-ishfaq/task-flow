import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { unsafeAsId, type OrgId } from '@taskflow/contracts';
import { closeDatabase, initializeDatabase, schema, withOrgScope } from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import { newId } from '@taskflow/security';
import { TEST_ENV } from '../testing/fixtures.js';
import * as orgs from '../tenancy/org.service.js';
import { resetEntitlementCache } from '../billing/entitlement-resolver.js';
import { checkAiCompletionAllowed, readAiSpendState, recordAiUsage } from './spend-gate.js';

/**
 * The AI budget gate, against real Postgres (ai/phase-15-ai-copilot-and-
 * permissions.md §3.2).
 *
 * Same acceptance bar as `telephony/spend-gate.test.ts`: the assertion that
 * matters is not that a refusal came back, it is that the DECISION alone —
 * never a call to a real provider — is what this file can prove, because
 * this module never touches `AiProvider` at all. `complete.test.ts` is
 * where "the provider was never reached" gets asserted against a fake.
 *
 * Real Postgres for the identical reason telephony's own header gives: the
 * rolling-window sum and the entitlement resolution are both database
 * behaviour, and a mocked version would only prove the mock agrees with
 * itself.
 */

const OWNER = unsafeAsId<'UserId'>('0195f000-0000-7000-8000-000000000001');
const requestId = unsafeAsId<'RequestId'>('0195f000-0000-7000-8000-0000000000ff');

let admin: AdminConnection;
let created: OrgId[] = [];

async function newOrg(slug: string): Promise<OrgId> {
  const result = await orgs.createOrg({ name: `Org ${slug}`, slug }, { userId: OWNER, requestId });
  created.push(result.orgId);
  return result.orgId;
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

/** `billing.org_entitlements` is FORCE RLS'd on app.org_id and the migrator is NOBYPASSRLS. */
async function setBudget(orgId: OrgId, cents: number | null): Promise<void> {
  await admin.setOrg(orgId);
  await admin.query(
    `INSERT INTO billing.org_entitlements (org_id, reason, ai_token_budget_monthly_cents)
     VALUES ($1, 'ai spend-gate test', $2)
     ON CONFLICT (org_id) DO UPDATE SET ai_token_budget_monthly_cents = $2`,
    [orgId, cents],
  );
  await admin.setOrg(null);
  resetEntitlementCache();
}

async function suspendOrg(orgId: OrgId): Promise<void> {
  await admin.setOrg(orgId);
  await admin.query(`UPDATE identity.orgs SET status = 'suspended' WHERE id = $1`, [orgId]);
  await admin.setOrg(null);
}

async function spend(orgId: OrgId, costCents: number, occurredAt?: Date): Promise<void> {
  await withOrgScope(orgId, async (tx) => {
    await tx.insert(schema.aiUsageLedger).values({
      id: newId<'AiUsageLedgerId'>(),
      orgId,
      feature: 'test',
      provider: 'fake',
      model: 'test-model',
      inputTokens: 1,
      outputTokens: 1,
      costCents,
      ...(occurredAt === undefined ? {} : { occurredAt }),
    });
  });
}

beforeAll(async () => {
  await applyMigrations();
  admin = await connectAsMigrator();

  await admin.setOrg(null);
  await admin.query(`DELETE FROM identity.users WHERE id = $1`, [OWNER]);
  await admin.query(
    `INSERT INTO identity.users (id, email, email_normalized, email_verified_at)
     VALUES ($1, 'owner@ai-gate.test', 'owner@ai-gate.test', now())`,
    [OWNER],
  );

  initializeDatabase({ url: TEST_ENV.DATABASE_URL, applicationName: 'taskflow-ai-gate-test' });
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

describe('readAiSpendState', () => {
  it('reports an unlimited, unspent org with no entitlement row at all', async () => {
    const orgId = await newOrg('ai-empty');

    const state = await readAiSpendState(orgId);

    expect(state.orgStatus).toBe('active');
    expect(state.budgetCents).toBeNull();
    expect(state.spentCents).toBe(0);
  });

  it('sums usage within the current calendar month, never across it', async () => {
    const orgId = await newOrg('ai-window');
    await spend(orgId, 500);
    /* Well outside the current month, however this suite happens to run. */
    await spend(orgId, 999_999, new Date('2000-01-01T00:00:00Z'));

    const state = await readAiSpendState(orgId);

    expect(state.spentCents).toBe(500);
  });

  it('resolves the budget from the operator-override entitlement chain', async () => {
    const orgId = await newOrg('ai-budget-resolve');
    await setBudget(orgId, 1_000);

    const state = await readAiSpendState(orgId);

    expect(state.budgetCents).toBe(1_000);
  });
});

describe('checkAiCompletionAllowed', () => {
  it('allows a request for an active org under an unlimited budget', async () => {
    const orgId = await newOrg('ai-happy');

    const decision = await checkAiCompletionAllowed(orgId);

    expect(decision.allowed).toBe(true);
    if (decision.allowed) {
      expect(decision.budgetCents).toBeNull();
      expect(decision.spentCents).toBe(0);
    }
  });

  describe('the org-freeze primitive', () => {
    it('refuses a suspended org even when its budget is untouched', async () => {
      const orgId = await newOrg('ai-suspended');
      await setBudget(orgId, 1_000);
      await suspendOrg(orgId);

      const decision = await checkAiCompletionAllowed(orgId);

      expect(decision.allowed).toBe(false);
      if (!decision.allowed) expect(decision.reason).toBe('org_suspended');
    });
  });

  describe('the budget ceiling', () => {
    it('allows a request that keeps the org under budget', async () => {
      const orgId = await newOrg('ai-under');
      await setBudget(orgId, 1_000);
      await spend(orgId, 500);

      const decision = await checkAiCompletionAllowed(orgId);

      expect(decision.allowed).toBe(true);
    });

    it('refuses once spend has reached the budget', async () => {
      const orgId = await newOrg('ai-at-budget');
      await setBudget(orgId, 1_000);
      await spend(orgId, 1_000);

      const decision = await checkAiCompletionAllowed(orgId);

      expect(decision.allowed).toBe(false);
      if (!decision.allowed) {
        expect(decision.reason).toBe('budget_exceeded');
        expect(decision.spentCents).toBe(1_000);
        expect(decision.budgetCents).toBe(1_000);
      }
    });

    it('refuses once spend has exceeded the budget', async () => {
      const orgId = await newOrg('ai-over-budget');
      await setBudget(orgId, 1_000);
      await spend(orgId, 1_500);

      const decision = await checkAiCompletionAllowed(orgId);

      expect(decision.allowed).toBe(false);
    });

    it('a zero budget refuses the very first request', async () => {
      const orgId = await newOrg('ai-zero-budget');
      await setBudget(orgId, 0);

      const decision = await checkAiCompletionAllowed(orgId);

      expect(decision.allowed).toBe(false);
      if (!decision.allowed) expect(decision.reason).toBe('budget_exceeded');
    });

    it('reports a warning threshold once spend crosses 80% while still allowing', async () => {
      const orgId = await newOrg('ai-warn');
      await setBudget(orgId, 1_000);
      await spend(orgId, 850);

      const decision = await checkAiCompletionAllowed(orgId);

      expect(decision.allowed).toBe(true);
      if (decision.allowed) expect(decision.warnThresholdPercent).toBe(80);
    });

    it('never a "never" — no budget row at all means unlimited, not zero', async () => {
      // The `?? null` in readAiSpendState must not confuse "no row" with "$0".
      const orgId = await newOrg('ai-no-row');
      await spend(orgId, 999_999);

      const decision = await checkAiCompletionAllowed(orgId);

      expect(decision.allowed).toBe(true);
    });
  });
});

describe('recordAiUsage', () => {
  it('writes a ledger row inside the caller-supplied transaction', async () => {
    const orgId = await newOrg('ai-record');

    await withOrgScope(orgId, async (tx) => {
      await recordAiUsage(tx, orgId, {
        id: newId<'AiUsageLedgerId'>(),
        membershipId: undefined,
        feature: 'standup',
        provider: 'anthropic',
        model: 'claude-sonnet-4',
        inputTokens: 100,
        outputTokens: 50,
        costCents: 3,
      });
    });

    const state = await readAiSpendState(orgId);
    expect(state.spentCents).toBe(3);
  });

  it('emits ai_usage.recorded to the outbox only when an envelope is given', async () => {
    const orgId = await newOrg('ai-record-event');

    await withOrgScope(orgId, async (tx) => {
      await recordAiUsage(
        tx,
        orgId,
        {
          id: newId<'AiUsageLedgerId'>(),
          membershipId: undefined,
          feature: 'standup',
          provider: 'anthropic',
          model: 'claude-sonnet-4',
          inputTokens: 10,
          outputTokens: 10,
          costCents: 1,
        },
        { orgId, actorId: OWNER, requestId },
      );
    });

    await admin.setOrg(orgId);
    const rows = await admin.query(
      `SELECT name FROM platform.outbox WHERE org_id = $1 AND name = 'ai_usage.recorded'`,
      [orgId],
    );
    await admin.setOrg(null);

    expect(rows.rowCount).toBe(1);
  });
});
