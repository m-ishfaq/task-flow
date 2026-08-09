import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { unsafeAsId, type OrgId, type UserId } from '@taskflow/contracts';
import { closeDatabase, initializeDatabase, initializePlatformAdminDatabase } from '@taskflow/db';
import { readOperatorChain } from '@taskflow/db';
import { verifyOperatorChain, type StoredOperatorEntry } from '@taskflow/security';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import { createCallerFactory } from '../trpc/builder.js';
import { testAppRouter, testContext, testPrincipal } from '../testing/fixtures.js';

/**
 * The platform-operator console's ROUTE-LEVEL behaviour, against real
 * Postgres (Phase 12 §3.2, §4). `packages/db/src/platform-admin.test.ts`
 * already proves the grants and the chain trigger in isolation; this file
 * proves the thing that only exists once `platformRoute` composes them with
 * `isPlatformOperator` and the router — the same "prove it end to end,
 * through the real stack" reasoning `tenancy.service.test.ts` documents for
 * its own slice.
 */

const PLATFORM_ADMIN_URL =
  process.env['TEST_DATABASE_PLATFORM_ADMIN_URL'] ??
  'postgresql://taskflow_platform_admin:platform-admin-dev-secret@localhost:5433/taskflow_test';

const OPERATOR = unsafeAsId<'UserId'>('0195ee10-0000-7000-8000-000000000001');
const NON_OPERATOR = unsafeAsId<'UserId'>('0195ee10-0000-7000-8000-000000000002');
const TARGET_USER = unsafeAsId<'UserId'>('0195ee10-0000-7000-8000-000000000003');
const ORG = '0195ee10-0000-7000-8000-0000000000aa' as OrgId;

let admin: AdminConnection;

async function cleanup(): Promise<void> {
  await admin.setOrg(null);
  await admin.query(`DELETE FROM platform.operator_audit_log`);
  await admin.query(`DELETE FROM platform.operator_chain_head`);
  await admin.query(`DELETE FROM platform.operators`);
  await admin.query(`DELETE FROM platform.flag_overrides`);
  await admin.setOrg(ORG);
  await admin.query(`DELETE FROM identity.memberships WHERE org_id = $1`, [ORG]);
  await admin.query(`DELETE FROM identity.orgs WHERE id = $1`, [ORG]);
  await admin.setOrg(null);
  await admin.query(`DELETE FROM identity.sessions WHERE user_id = $1`, [TARGET_USER]);
  await admin.query(`DELETE FROM identity.users WHERE id = ANY($1::uuid[])`, [
    [OPERATOR, NON_OPERATOR, TARGET_USER],
  ]);
}

function callerFor(userId: UserId) {
  const { router } = testAppRouter();
  return createCallerFactory(router)(
    testContext({ principal: testPrincipal('member', { userId, org: null }) }),
  );
}

beforeAll(async () => {
  await applyMigrations();
  admin = await connectAsMigrator();
  await cleanup();

  await admin.query(
    `INSERT INTO identity.users (id, email, email_normalized, email_verified_at)
     VALUES ($1, 'operator@platform-admin.test', 'operator@platform-admin.test', now()),
            ($2, 'member@platform-admin.test', 'member@platform-admin.test', now()),
            ($3, 'target@platform-admin.test', 'target@platform-admin.test', now())`,
    [OPERATOR, NON_OPERATOR, TARGET_USER],
  );
  await admin.query(
    `INSERT INTO platform.operators (user_id, granted_by, note) VALUES ($1, $1, 'seeded for test')`,
    [OPERATOR],
  );
  await admin.setOrg(ORG);
  await admin.query(
    `INSERT INTO identity.orgs (id, name, slug) VALUES ($1, 'Console Test Org', 'console-test-org')`,
    [ORG],
  );
  await admin.setOrg(null);

  initializeDatabase({
    url: 'postgresql://taskflow_app:app-dev-secret@localhost:5433/taskflow_test',
    applicationName: 'taskflow-platform-admin-router-test',
  });
  initializePlatformAdminDatabase({
    url: PLATFORM_ADMIN_URL,
    applicationName: 'taskflow-platform-admin-router-test-writer',
  });
});

afterAll(async () => {
  await closeDatabase();
  await cleanup();
  await admin.end();
});

beforeEach(async () => {
  await admin.setOrg(null);
  await admin.query(`DELETE FROM platform.operator_audit_log`);
  await admin.query(`DELETE FROM platform.operator_chain_head`);
  await admin.query(`DELETE FROM platform.flag_overrides`);
  await admin.setOrg(ORG);
  await admin.query(`UPDATE identity.orgs SET status = 'active' WHERE id = $1`, [ORG]);
  await admin.setOrg(null);
  await admin.query(`UPDATE identity.users SET status = 'active' WHERE id = $1`, [TARGET_USER]);
  await admin.query(`DELETE FROM identity.sessions WHERE user_id = $1`, [TARGET_USER]);
});

describe('platformRoute — the FORBIDDEN gate', () => {
  it('refuses every platformAdmin.* call from an authenticated non-operator', async () => {
    const caller = callerFor(NON_OPERATOR);

    await expect(
      caller.platformAdmin.orgs.list({ limit: 10, before: null, search: null }),
    ).rejects.toThrow(/permission/i);
    await expect(
      caller.platformAdmin.users.list({ limit: 10, before: null, search: null }),
    ).rejects.toThrow();
    await expect(caller.platformAdmin.flags.list()).rejects.toThrow();
    await expect(caller.platformAdmin.audit.list({ limit: 10, before: null })).rejects.toThrow();
  });

  it('answers self.check honestly for both roles, with no step-up and no FORBIDDEN', async () => {
    // self.check is deliberately NOT platformRoute (router.ts's own comment) —
    // it must never throw for an ordinary member, only report `false`.
    await expect(callerFor(OPERATOR).platformAdmin.self.check()).resolves.toEqual({
      isOperator: true,
    });
    await expect(callerFor(NON_OPERATOR).platformAdmin.self.check()).resolves.toEqual({
      isOperator: false,
    });
  });

  it('lets a real operator through', async () => {
    const result = await callerFor(OPERATOR).platformAdmin.orgs.list({
      limit: 10,
      before: null,
      search: null,
    });
    expect(result.orgs.some((org) => org.orgId === ORG)).toBe(true);
  });
});

describe('the operator audit log — every call, including reads (§4)', () => {
  it('writes one row per successful platformAdmin.* call, and none for a refused one', async () => {
    await callerFor(OPERATOR).platformAdmin.orgs.list({ limit: 10, before: null, search: null });
    await callerFor(OPERATOR).platformAdmin.flags.list();
    await callerFor(NON_OPERATOR)
      .platformAdmin.orgs.list({ limit: 10, before: null, search: null })
      .catch(() => undefined);

    const chain = await readOperatorChain();
    const actions = chain.map((entry) => entry.action).sort();

    expect(actions).toEqual(['flags.list', 'orgs.list']);
    expect(chain.every((entry) => entry.operatorId === OPERATOR)).toBe(true);
  });

  it('records the target for a call that names one', async () => {
    await callerFor(OPERATOR).platformAdmin.orgs.suspend({ orgId: ORG });

    const chain = await readOperatorChain();
    const entry = chain.find((row) => row.action === 'orgs.suspend');
    expect(entry?.target).toBe(`{"orgId": "${ORG}"}`);
  });

  it('records no target for a call with no id-shaped field', async () => {
    await callerFor(OPERATOR).platformAdmin.flags.list();

    const chain = await readOperatorChain();
    const entry = chain.find((row) => row.action === 'flags.list');
    expect(entry?.target).toBeNull();
  });
});

describe('org suspend/reactivate — round trip through the router', () => {
  it('suspends and reactivates, refusing a redundant call each way', async () => {
    const caller = callerFor(OPERATOR);

    await expect(caller.platformAdmin.orgs.suspend({ orgId: ORG })).resolves.toEqual({
      status: 'suspended',
    });
    await expect(caller.platformAdmin.orgs.suspend({ orgId: ORG })).rejects.toThrow(
      /already suspended/i,
    );

    await expect(caller.platformAdmin.orgs.reactivate({ orgId: ORG })).resolves.toEqual({
      status: 'active',
    });
    await expect(caller.platformAdmin.orgs.reactivate({ orgId: ORG })).rejects.toThrow(
      /not suspended/i,
    );
  });
});

describe('user suspend/reactivate — round trip through the router (Wave 2 §3.1)', () => {
  it('suspends and reactivates, refusing a redundant call each way', async () => {
    const caller = callerFor(OPERATOR);

    await expect(caller.platformAdmin.users.suspend({ userId: TARGET_USER })).resolves.toEqual({
      status: 'suspended',
    });
    await expect(caller.platformAdmin.users.suspend({ userId: TARGET_USER })).rejects.toThrow(
      /already suspended/i,
    );

    await expect(caller.platformAdmin.users.reactivate({ userId: TARGET_USER })).resolves.toEqual({
      status: 'active',
    });
    await expect(caller.platformAdmin.users.reactivate({ userId: TARGET_USER })).rejects.toThrow(
      /not suspended/i,
    );
  });

  it('revokes existing sessions immediately on suspend', async () => {
    await admin.query(
      `INSERT INTO identity.sessions (id, user_id, authenticated_at, expires_at)
       VALUES (gen_random_uuid(), $1, now(), now() + interval '30 days')`,
      [TARGET_USER],
    );

    await callerFor(OPERATOR).platformAdmin.users.suspend({ userId: TARGET_USER });

    const rows = await admin.query(
      `SELECT revoked_at, revoked_reason FROM identity.sessions WHERE user_id = $1`,
      [TARGET_USER],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.['revoked_at']).not.toBeNull();
    expect(rows.rows[0]?.['revoked_reason']).toBe('account_suspended');
  });

  it('is refused for a non-operator', async () => {
    await expect(
      callerFor(NON_OPERATOR).platformAdmin.users.suspend({ userId: TARGET_USER }),
    ).rejects.toThrow();
  });
});

describe('chain-verifier agreement (§4)', () => {
  it('readOperatorChain and verifyOperatorChain agree on a healthy chain', async () => {
    await callerFor(OPERATOR).platformAdmin.orgs.list({ limit: 10, before: null, search: null });
    await callerFor(OPERATOR).platformAdmin.flags.list();
    await callerFor(OPERATOR).platformAdmin.orgs.suspend({ orgId: ORG });
    await callerFor(OPERATOR).platformAdmin.orgs.reactivate({ orgId: ORG });

    const chain = await readOperatorChain();
    expect(chain.length).toBeGreaterThanOrEqual(4);

    const verification = verifyOperatorChain(chain);
    expect(verification.intact).toBe(true);
    expect(verification.breaks).toEqual([]);
    expect(verification.verified).toBe(chain.length);
  });

  it('notices a tampered action the same way it would in production', async () => {
    await callerFor(OPERATOR).platformAdmin.flags.list();
    const [entry] = await readOperatorChain();
    if (!entry) throw new Error('expected one entry');

    const tampered: StoredOperatorEntry = { ...entry, action: 'orgs.suspend' };
    const verification = verifyOperatorChain([tampered]);

    expect(verification.intact).toBe(false);
    expect(verification.breaks).toEqual([
      { seq: entry.seq, id: entry.seq, reason: 'hash_mismatch' },
    ]);
  });
});
