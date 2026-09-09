import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { unsafeAsId, type OrgId, type UserId } from '@taskflow/contracts';
import { closeDatabase, initializeAuditDatabase, initializeDatabase } from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import { createCallerFactory } from '../trpc/builder.js';
import { TEST_ENV, testAppRouter, testContext, testPrincipal } from '../testing/fixtures.js';
import * as orgs from './org.service.js';

/**
 * `tenancy.orgs.get`, through the real tRPC router — the ROUTE's own floor,
 * as distinct from `tenancy.service.test.ts`'s "settings capabilities"
 * describe block, which calls `orgs.getOrg` directly and never exercised
 * `couldGrant` at all.
 *
 * Found from a real report: a Guest could see other members' data in the
 * standup view and a raw backend error on the People page, both traced back
 * to the SAME root cause — `tenancy.orgs.get` used to be
 * `route({ permission: 'org:read' })`, and `org:read` is an
 * `ORG_LEVEL_PERMISSIONS` entry (`packages/policy/src/permissions.ts`) that
 * `GUEST`'s empty role list (`packages/policy/src/roles.ts`) can never
 * satisfy — no tuple narrows an org-level permission back down. Every
 * capability-gated nav item on both platforms reads this route to decide
 * what to show, so a Guest's session had it erroring in the background from
 * the moment the app shell rendered, long before anyone opened Standup or
 * People. `getOrg` itself never checked `org:read` internally (it only
 * computes each `capabilities` field through its own real `can()` call), so
 * the fix is `memberRoute` — membership only, no permission floor — the
 * identical shape `platform.notifications`' own routes already use for "no
 * single Permission describes this, and every role needs it."
 */

const OWNER = unsafeAsId<'UserId'>('0196a000-0000-7000-8000-000000000001');
const GUEST = unsafeAsId<'UserId'>('0196a000-0000-7000-8000-000000000002');
const requestId = unsafeAsId<'RequestId'>('0196a000-0000-7000-8000-0000000000ff');

const USERS: readonly [UserId, string][] = [
  [OWNER, 'owner@tenancy-router.test'],
  [GUEST, 'guest@tenancy-router.test'],
];

let admin: AdminConnection;
const created: OrgId[] = [];

async function newOrg(slug: string): Promise<OrgId> {
  const result = await orgs.createOrg({ name: `Org ${slug}`, slug }, { userId: OWNER, requestId });
  created.push(result.orgId);
  return result.orgId;
}

async function removeOrg(orgId: string): Promise<void> {
  await admin.setOrg(orgId);
  await admin.query(`DELETE FROM audit.audit_log WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM audit.chain_heads WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM platform.outbox WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM authz.relationship_tuples WHERE org_id = $1`, [orgId]);
  await admin.query(`DELETE FROM authz.member_grants WHERE org_id = $1`, [orgId]);
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

  initializeDatabase({ url: TEST_ENV.DATABASE_URL, applicationName: 'tenancy-router-test' });
  initializeAuditDatabase({
    url:
      process.env['TEST_DATABASE_AUDIT_URL'] ??
      'postgresql://taskflow_audit:audit-dev-secret@localhost:5433/taskflow_test',
    applicationName: 'tenancy-router-test-audit',
  });
});

beforeEach(async () => {
  for (const orgId of created) await removeOrg(orgId);
  created.length = 0;
});

afterAll(async () => {
  for (const orgId of created) await removeOrg(orgId);
  await admin.setOrg(null);
  await admin.query(`DELETE FROM identity.users WHERE id = ANY($1::uuid[])`, [
    USERS.map(([id]) => id),
  ]);
  await admin.end();
  await closeDatabase();
});

describe('tenancy.orgs.get', () => {
  it('answers a Guest with no tuples — memberRoute, not a permission floor', async () => {
    const orgId = await newOrg('router-get-guest');

    const context = testContext({
      principal: testPrincipal('guest', {
        userId: GUEST,
        org: { orgId, role: 'guest', tuples: [], memberGrants: [] },
      }),
    });
    const caller = callerFactory(context);

    const result = await caller.tenancy.orgs.get();

    expect(result.orgId).toBe(orgId);
    // Every field false — a Guest's role grants nothing, and this fixture
    // holds no tuple either — but the CALL itself succeeds, which is the
    // property this test exists to prove. Before the fix, `couldGrant`
    // refused this at the route floor with FORBIDDEN, before `getOrg` ever
    // ran, because `org:read` is org-level and no tuple can satisfy it.
    expect(result.capabilities.viewDirectory).toBe(false);
    expect(result.capabilities.manageMembers).toBe(false);
    expect(result.capabilities.updateOrg).toBe(false);
  });

  it('still answers an Owner with every capability the role grants', async () => {
    // The regression guard on the other side of the same change: swapping
    // `route({ permission })` for `memberRoute` must not accidentally widen
    // anything either — an Owner's answer is unchanged from what
    // `tenancy.service.test.ts`'s own service-level assertion already
    // proves, exercised here through the real route instead of the bare
    // service function.
    const orgId = await newOrg('router-get-owner');

    const context = testContext({
      principal: testPrincipal('owner', {
        userId: OWNER,
        org: { orgId, role: 'owner', tuples: [], memberGrants: [] },
      }),
    });
    const caller = callerFactory(context);

    const result = await caller.tenancy.orgs.get();

    expect(result.orgId).toBe(orgId);
    expect(result.capabilities.viewDirectory).toBe(true);
    expect(result.capabilities.manageMembers).toBe(true);
    expect(result.capabilities.updateOrg).toBe(true);
  });
});
