import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { unsafeAsId, type OrgId, type RequestId, type UserId } from '@taskflow/contracts';
import { RecordingEventBus } from '@taskflow/events';
import { closeDatabase, initializeDatabase, initializePlatformAdminDatabase } from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import { FakePaymentProvider } from '@taskflow/payments';
import { TEST_ENV } from '../testing/fixtures.js';
import * as orgs from '../tenancy/org.service.js';
import { getEntitlements, resetEntitlementCache } from '../billing/entitlement-resolver.js';
import { setOrgEntitlements, type PlanCatalogDeps } from './plan-catalog.service.js';
import type { PlatformOperator } from './org-directory.service.js';

/**
 * `setOrgEntitlements` — tier 1 of four, against real Postgres.
 *
 * This is the operator console's per-org override: the escape hatch that
 * outranks the plan ("give this one customer Docs while we sort out their
 * contract"). The service function and its route (`platformAdmin.plans.
 * setOrgEntitlements`) existed with no caller and no test until the console's
 * override dialog gave it one — see `shared.tsx`'s `OrgOverrideDialog`.
 *
 * Calls `setOrgEntitlements` directly with a plain `PlatformOperator` value
 * rather than through a router caller, and deliberately never touches
 * `platform.operators` — same reasoning as `billing-directory.service.test
 * .ts`'s own header: that table is GLOBAL, `platform-admin.service.test.ts`
 * owns resetting it in its own `beforeEach`, and Vitest runs test files in
 * this package in parallel, so a second file granting or clearing rows in
 * it would race that reset. The router-level regression for the
 * `expiresAt: z.date()` -> `z.coerce.date()` fix (proving a route that
 * NEEDS a real operator grant still accepts the wire-format a browser
 * actually sends) lives in `platform-admin.service.test.ts` instead, where
 * that grant is already owned.
 */

const PLATFORM_ADMIN_URL =
  process.env['TEST_DATABASE_PLATFORM_ADMIN_URL'] ??
  'postgresql://taskflow_platform_admin:platform-admin-dev-secret@localhost:5433/taskflow_test';

const OWNER = unsafeAsId<'UserId'>('0195dd30-0000-7000-8000-000000000001');
const requestId = unsafeAsId<'RequestId'>('0195dd30-0000-7000-8000-0000000000ff');
const actorOf = (userId: UserId): { userId: UserId; requestId: RequestId } => ({
  userId,
  requestId,
});
const operatorOf = (userId: UserId): PlatformOperator => ({ userId, requestId });

let admin: AdminConnection;
const created: OrgId[] = [];

async function newOrg(slug: string): Promise<OrgId> {
  const result = await orgs.createOrg({ name: `Override ${slug}`, slug }, actorOf(OWNER), {
    trialDays: 14,
  });
  created.push(result.orgId);
  return result.orgId;
}

function deps(): PlanCatalogDeps {
  return { events: new RecordingEventBus(), payments: new FakePaymentProvider() };
}

beforeAll(async () => {
  await applyMigrations();
  admin = await connectAsMigrator();
  initializeDatabase({ url: TEST_ENV.DATABASE_URL, applicationName: 'taskflow-org-override-test' });
  /* setOrgEntitlements writes through withPlatformAdminScope — without this,
     every call fails boot-time with "Platform-admin database not
     initialized" rather than a test assertion, which is exactly what the
     first version of this file did. */
  initializePlatformAdminDatabase({
    url: PLATFORM_ADMIN_URL,
    applicationName: 'taskflow-org-override-admin',
  });

  await admin.setOrg(null);
  /* Before, not only after — an aborted previous run skips teardown
     (billing.catalog.ts's own comment on the same pattern). setOrgEntitlements
     calls recordOperatorAction, which writes OWNER into
     platform.operator_audit_log as the operator; that row's FK to
     identity.users refuses the user delete below unless it goes first.
     Scoped to OWNER's own rows, not a full-table wipe — the whole table is
     platform-admin.service.test.ts's to reset (see its own header on why
     every other file avoids that), and this only ever touches the handful
     of rows this file's own OWNER id produced. */
  await admin.query(`DELETE FROM platform.operator_audit_log WHERE operator_id = $1`, [OWNER]);
  await admin.query(`DELETE FROM identity.users WHERE id = $1`, [OWNER]);
  await admin.query(
    `INSERT INTO identity.users (id, email, email_normalized, email_verified_at)
     VALUES ($1, 'owner@override.test', 'owner@override.test', now())`,
    [OWNER],
  );
});

afterEach(() => {
  /* The resolver caches per org for 30s — every test here writes the row
     underneath it, so the cache is dropped between tests. Same reason
     entitlement-resolver.test.ts does this. */
  resetEntitlementCache();
});

afterAll(async () => {
  for (const orgId of created) {
    await admin.setOrg(orgId);
    await admin.query(`DELETE FROM billing.org_entitlements WHERE org_id = $1`, [orgId]);
    await admin.query(`DELETE FROM identity.memberships WHERE org_id = $1`, [orgId]);
    await admin.query(`DELETE FROM platform.outbox WHERE org_id = $1`, [orgId]);
    await admin.query(`DELETE FROM identity.orgs WHERE id = $1`, [orgId]);
    await admin.setOrg(null);
  }
  await admin.query(`DELETE FROM platform.operator_audit_log WHERE operator_id = $1`, [OWNER]);
  await admin.query(`DELETE FROM identity.users WHERE id = $1`, [OWNER]);
  await admin.end();
  await closeDatabase();
});

describe('setOrgEntitlements', () => {
  it('grants a feature the plan does not, and the resolver attributes it to the override', async () => {
    const orgId = await newOrg('grant');

    const result = await setOrgEntitlements(deps(), operatorOf(OWNER), {
      orgId,
      featuresAdd: ['docs'],
      featuresRemove: [],
      telephonyCapCents: null,
      automationRunsPerHour: null,
      turnIssuancePerDay: null,
      reason: 'Beta access while the contract is negotiated',
      expiresAt: null,
    });

    expect(result.cleared).toBe(false);

    const entitlements = await getEntitlements(orgId);
    expect(entitlements.features.docs).toBe(true);
    expect(entitlements.sources.docs).toBe('override');
  });

  it('deletes the row — one state for "no override", not an empty one that reads the same', async () => {
    const orgId = await newOrg('clear');

    await setOrgEntitlements(deps(), operatorOf(OWNER), {
      orgId,
      featuresAdd: ['docs'],
      featuresRemove: [],
      telephonyCapCents: null,
      automationRunsPerHour: null,
      turnIssuancePerDay: null,
      reason: 'temporary grant',
      expiresAt: null,
    });
    expect((await getEntitlements(orgId)).sources.docs).toBe('override');

    const cleared = await setOrgEntitlements(deps(), operatorOf(OWNER), {
      orgId,
      featuresAdd: [],
      featuresRemove: [],
      telephonyCapCents: null,
      automationRunsPerHour: null,
      turnIssuancePerDay: null,
      reason: 'no longer needed',
      expiresAt: null,
    });

    expect(cleared.cleared).toBe(true);
    expect((await getEntitlements(orgId)).sources.docs).toBeUndefined();

    const rows = await admin.query(`SELECT 1 FROM billing.org_entitlements WHERE org_id = $1`, [
      orgId,
    ]);
    expect(rows.rowCount).toBe(0);
  });

  it('refuses a feature name the registry does not have', async () => {
    const orgId = await newOrg('unknown-flag');

    await expect(
      setOrgEntitlements(deps(), operatorOf(OWNER), {
        orgId,
        featuresAdd: ['not_a_real_flag'],
        featuresRemove: [],
        telephonyCapCents: null,
        automationRunsPerHour: null,
        turnIssuancePerDay: null,
        reason: 'typo',
        expiresAt: null,
      }),
    ).rejects.toThrow();
  });

  it('refuses telephonyLiveCredentials — real carrier spend, not a grantable feature', async () => {
    /* The same refusal `assertGrantableFeatures` gives the plan catalog
       itself (billing.catalog.ts's own guard) — an override must not be a
       second door to the same spend surface the plan door refuses. */
    const orgId = await newOrg('spend-flag');

    await expect(
      setOrgEntitlements(deps(), operatorOf(OWNER), {
        orgId,
        featuresAdd: ['telephonyLiveCredentials'],
        featuresRemove: [],
        telephonyCapCents: null,
        automationRunsPerHour: null,
        turnIssuancePerDay: null,
        reason: 'nice try',
        expiresAt: null,
      }),
    ).rejects.toThrow();
  });

  it('refuses a feature named in both add and remove', async () => {
    const orgId = await newOrg('contradiction');

    await expect(
      setOrgEntitlements(deps(), operatorOf(OWNER), {
        orgId,
        featuresAdd: ['docs'],
        featuresRemove: ['docs'],
        telephonyCapCents: null,
        automationRunsPerHour: null,
        turnIssuancePerDay: null,
        reason: 'contradictory',
        expiresAt: null,
      }),
    ).rejects.toThrow();
  });

  it('ignores an override past its expiry, falling back to the plan/registry', async () => {
    const orgId = await newOrg('expired');

    await setOrgEntitlements(deps(), operatorOf(OWNER), {
      orgId,
      featuresAdd: ['docs'],
      featuresRemove: [],
      telephonyCapCents: null,
      automationRunsPerHour: null,
      turnIssuancePerDay: null,
      reason: 'already lapsed',
      expiresAt: new Date(Date.now() - 60_000),
    });

    expect((await getEntitlements(orgId)).sources.docs).toBeUndefined();
  });
});

/* The router-level regression for the `expiresAt: z.date()` -> `z.coerce.date()`
   fix lives in platform-admin.service.test.ts instead of here, alongside its
   own `describe('the operator console routes', ...)` — that file already
   owns `platform.operators` for the whole package (see
   billing-directory.service.test.ts's own header on why every OTHER file in
   this directory avoids writing to it: Vitest runs test files in this
   package in parallel, and a second file resetting or granting rows in that
   GLOBAL table would race platform-admin.service.test.ts's own beforeEach). */
