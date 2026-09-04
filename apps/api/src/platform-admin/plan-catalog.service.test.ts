import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  unsafeAsId,
  type OrgId,
  type RequestId,
  type StorageProvider,
  type UserId,
} from '@taskflow/contracts';
import { RecordingEventBus } from '@taskflow/events';
import { closeDatabase, initializeDatabase } from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import { FakePaymentProvider } from '@taskflow/payments';
import { TEST_ENV, testContext, testPrincipal } from '../testing/fixtures.js';
import * as orgs from '../tenancy/org.service.js';
import { getEntitlements, resetEntitlementCache } from '../billing/entitlement-resolver.js';
import { createCallerFactory } from '../trpc/builder.js';
import { createPlatformAdminRouter } from './router.js';
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
 * The router-level case below exists because the route ORIGINALLY declared
 * `expiresAt: z.date()`, which validates only an actual `Date` instance.
 * There is no transformer on this tRPC instance (builder.ts's own header), so
 * a `Date` sent from a browser arrives JSON-serialized as a plain string —
 * which `z.date()` refuses outright. Nothing caught it: the service-level
 * assertions below call `setOrgEntitlements` in-process with a real `Date`,
 * which both `z.date()` and `z.coerce.date()` accept identically, and the
 * seed CLI does the same. Only a caller that hands the route a STRING, the
 * shape JSON actually delivers, tells the two apart.
 */

const OWNER = unsafeAsId<'UserId'>('0195dd30-0000-7000-8000-000000000001');
const requestId = unsafeAsId<'RequestId'>('0195dd30-0000-7000-8000-0000000000ff');
const actorOf = (userId: UserId): { userId: UserId; requestId: RequestId } => ({
  userId,
  requestId,
});
const operatorOf = (userId: UserId): PlatformOperator => ({ userId, requestId });

const unusedStorage: StorageProvider = new Proxy(
  {},
  {
    get(_target, method) {
      return () => {
        throw new Error(`StorageProvider.${String(method)} was not expected to be called here.`);
      };
    },
  },
) as StorageProvider;
const unusedScanner = { host: '127.0.0.1', port: 1, timeoutMs: 500 };

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

  await admin.setOrg(null);
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

describe('platformAdmin.plans.setOrgEntitlements — the route', () => {
  it('accepts an ISO date string for expiresAt, the shape JSON actually delivers', async () => {
    /* The regression test. Before this fix, `expiresAt: z.date()` refused
       anything that was not already a `Date` instance — which is every real
       browser request, since there is no transformer on this tRPC instance.
       `createCallerFactory` calls the resolver in-process, so passing a real
       `Date` here would prove nothing; passing the STRING a JSON body
       actually carries is what distinguishes the fix from the bug. */
    const orgId = await newOrg('wire-date');
    const context = testContext({ principal: testPrincipal('owner') });
    const caller = createCallerFactory(
      createPlatformAdminRouter({
        events: new RecordingEventBus(),
        payments: new FakePaymentProvider(),
        storage: unusedStorage,
        scanner: unusedScanner,
      }),
    )(context);

    const future = new Date(Date.now() + 3_600_000).toISOString();

    const result = await caller.plans.setOrgEntitlements({
      orgId,
      featuresAdd: ['docs'],
      featuresRemove: [],
      telephonyCapCents: null,
      automationRunsPerHour: null,
      turnIssuancePerDay: null,
      reason: 'wire-format regression test',
      /* The double cast, same reasoning as `Wire<T>`'s own: the TS input type
         says `Date`, and a real JSON body never carries one — this simulates
         what actually arrives rather than what the type promises. */
      expiresAt: future as unknown as Date,
    });

    expect(result.cleared).toBe(false);
    expect((await getEntitlements(orgId)).sources.docs).toBe('override');
  });
});
