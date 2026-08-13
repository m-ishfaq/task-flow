import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { unsafeAsId, type OrgId, type RequestId, type UserId } from '@taskflow/contracts';
import { closeDatabase, initializeDatabase } from '@taskflow/db';
import { applyMigrations, connectAsMigrator, type AdminConnection } from '@taskflow/db/testing';
import { FLAGS } from '@taskflow/feature-flags';
import { TEST_ENV } from '../testing/fixtures.js';
import * as orgs from '../tenancy/org.service.js';
import {
  getEntitlements,
  isFeatureEnabled,
  requireFeature,
  resetEntitlementCache,
} from './entitlement-resolver.js';

/**
 * The entitlement resolver, against real Postgres (Phase 12 Wave 4 §3.1, §6).
 *
 * Four tiers resolve here — operator override, plan, environment, registry
 * default — and the ONLY way to know they compose correctly is to write real
 * rows and read them back through the real evaluator. A unit test with a
 * hand-built fixture would prove the merge function agrees with itself.
 *
 * The assertions below each exist because a weaker version would have passed:
 *
 *   - "a plan grants its features" would pass on an implementation that
 *     ignored the plan and returned `true` for everything, since the registry
 *     now defaults every shipped module ON. So the interesting cases are all
 *     about REMOVING: a plan that omits a module, an override that revokes
 *     one, and an expiry that puts it back.
 *   - "an expired override is ignored" is the one that catches a resolver
 *     which sweeps expiry on a timer instead of checking it on read — the
 *     lapsed grant stays live until the sweep runs, which is exactly what
 *     `expires_at` exists to prevent.
 */

const OWNER = unsafeAsId<'UserId'>('0195dd20-0000-7000-8000-000000000001');
const requestId = unsafeAsId<'RequestId'>('0195dd20-0000-7000-8000-0000000000ff');
const actorOf = (userId: UserId): { userId: UserId; requestId: RequestId } => ({
  userId,
  requestId,
});

/** A plan granting NOTHING — the shape a Free tier has. */
const BARE_PLAN = 'entitlement-test-bare';
/** A plan granting Docs and Chat explicitly. */
const RICH_PLAN = 'entitlement-test-rich';

let admin: AdminConnection;
const created: OrgId[] = [];

async function newOrg(slug: string): Promise<OrgId> {
  const result = await orgs.createOrg({ name: `Org ${slug}`, slug }, actorOf(OWNER), {
    trialDays: 14,
  });
  created.push(result.orgId);
  return result.orgId;
}

/** `identity.orgs` is FORCE RLS'd on app.org_id and the migrator is NOBYPASSRLS. */
async function setPlan(orgId: OrgId, planId: string | null): Promise<void> {
  await admin.setOrg(orgId);
  await admin.query(`UPDATE identity.orgs SET plan_id = $2 WHERE id = $1`, [orgId, planId]);
  await admin.setOrg(null);
  resetEntitlementCache();
}

/** `billing.org_entitlements` is FORCE RLS'd on app.org_id and the migrator is NOBYPASSRLS. */
async function setOverride(
  orgId: OrgId,
  input: {
    readonly add?: readonly string[];
    readonly remove?: readonly string[];
    readonly expiresAt?: Date | null;
  },
): Promise<void> {
  await admin.setOrg(orgId);
  await admin.query(
    `INSERT INTO billing.org_entitlements (org_id, features_add, features_remove, reason, expires_at)
     VALUES ($1, $2, $3, 'resolver test', $4)
     ON CONFLICT (org_id) DO UPDATE
       SET features_add = $2, features_remove = $3, expires_at = $4`,
    [orgId, input.add ?? [], input.remove ?? [], input.expiresAt ?? null],
  );
  await admin.setOrg(null);
  resetEntitlementCache();
}

async function clearOverride(orgId: OrgId): Promise<void> {
  await admin.setOrg(orgId);
  await admin.query(`DELETE FROM billing.org_entitlements WHERE org_id = $1`, [orgId]);
  await admin.setOrg(null);
  resetEntitlementCache();
}

beforeAll(async () => {
  await applyMigrations();
  admin = await connectAsMigrator();
  initializeDatabase({ url: TEST_ENV.DATABASE_URL, applicationName: 'taskflow-entitlement-test' });

  await admin.setOrg(null);
  await admin.query(`DELETE FROM identity.users WHERE id = $1`, [OWNER]);
  await admin.query(
    `INSERT INTO identity.users (id, email, email_normalized, email_verified_at)
     VALUES ($1, 'owner@entitlement.test', 'owner@entitlement.test', now())`,
    [OWNER],
  );

  /* Before, not only after — an aborted previous run skips teardown. */
  await admin.query(`DELETE FROM billing.plans WHERE id = ANY($1)`, [[BARE_PLAN, RICH_PLAN]]);
  await admin.query(
    `INSERT INTO billing.plans (id, name, features) VALUES ($1, 'Bare', '{}'), ($2, 'Rich', $3)`,
    [BARE_PLAN, RICH_PLAN, ['docs', 'chat']],
  );
});

afterEach(() => {
  /* The resolver caches per org for 30s. Every test here changes rows behind
     it, so the cache is dropped between them — otherwise the second assertion
     in any file reads the first one's answer and passes for the wrong reason. */
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
  await admin.query(`DELETE FROM billing.plans WHERE id = ANY($1)`, [[BARE_PLAN, RICH_PLAN]]);
  await admin.query(`DELETE FROM identity.users WHERE id = $1`, [OWNER]);
  await admin.end();
  await closeDatabase();
});

describe('tier 2 — the plan', () => {
  it('leaves a module the plan omits to the registry, rather than forcing it off', async () => {
    /* The subtle one. A plan lists what it GRANTS; a module missing from that
       list is undecided at this tier, not denied — so an org whose plan
       predates a module keeps whatever the registry says rather than losing a
       feature nobody made a decision about. */
    const orgId = await newOrg('ent-bare');
    await setPlan(orgId, BARE_PLAN);

    const entitlements = await getEntitlements(orgId);
    expect(entitlements.features.docs).toBeUndefined();
    expect(await isFeatureEnabled(orgId, 'docs')).toBe(FLAGS.docs.defaultValue);
  });

  it('grants what the plan lists, and records the plan as the source', async () => {
    const orgId = await newOrg('ent-rich');
    await setPlan(orgId, RICH_PLAN);

    const entitlements = await getEntitlements(orgId);
    expect(entitlements.features.docs).toBe(true);
    expect(entitlements.sources.docs).toBe('plan');
    expect(await isFeatureEnabled(orgId, 'docs')).toBe(true);
  });

  it('resolves an org with NO plan to the registry, not to an empty feature set', async () => {
    /* `plan_id` is NULL for the whole trial. Returning "nothing granted" here
       would make a trial the most restricted state in the product rather than
       the least — the opposite of what a trial is for. */
    const orgId = await newOrg('ent-no-plan');
    await setPlan(orgId, null);

    expect(await isFeatureEnabled(orgId, 'docs')).toBe(FLAGS.docs.defaultValue);
  });
});

describe('tier 1 — the operator override', () => {
  it('adds a feature the plan does not grant', async () => {
    const orgId = await newOrg('ent-override-add');
    await setPlan(orgId, BARE_PLAN);
    await setOverride(orgId, { add: ['docs'] });

    const entitlements = await getEntitlements(orgId);
    expect(entitlements.features.docs).toBe(true);
    expect(entitlements.sources.docs).toBe('override');
    expect(await isFeatureEnabled(orgId, 'docs')).toBe(true);
  });

  it('removes a feature the plan DOES grant — the override outranks the plan', async () => {
    /* The assertion that proves precedence rather than coincidence: the plan
       says yes, the override says no, and the answer is no. Reversed
       precedence would return true here and pass every other test in
       this file. */
    const orgId = await newOrg('ent-override-remove');
    await setPlan(orgId, RICH_PLAN);
    await setOverride(orgId, { remove: ['docs'] });

    const entitlements = await getEntitlements(orgId);
    expect(entitlements.features.docs).toBe(false);
    expect(entitlements.sources.docs).toBe('override');
    expect(await isFeatureEnabled(orgId, 'docs')).toBe(false);
  });

  it('ignores an override whose expiry has passed, falling back to the plan', async () => {
    /* Expiry is checked on READ. A resolver that swept it on a timer would
       keep serving the lapsed grant until the sweep ran — and the whole point
       of `expires_at` is that a temporary grant does not become permanent by
       being forgotten. */
    const orgId = await newOrg('ent-override-expired');
    await setPlan(orgId, RICH_PLAN);
    await setOverride(orgId, { remove: ['docs'], expiresAt: new Date(Date.now() - 60_000) });

    expect(await isFeatureEnabled(orgId, 'docs')).toBe(true);
  });

  it('honours an override whose expiry is still in the future', async () => {
    const orgId = await newOrg('ent-override-live');
    await setPlan(orgId, RICH_PLAN);
    await setOverride(orgId, { remove: ['docs'], expiresAt: new Date(Date.now() + 3_600_000) });

    expect(await isFeatureEnabled(orgId, 'docs')).toBe(false);
  });

  it('falls back to the plan once the override row is deleted', async () => {
    const orgId = await newOrg('ent-override-cleared');
    await setPlan(orgId, RICH_PLAN);
    await setOverride(orgId, { remove: ['docs'] });
    expect(await isFeatureEnabled(orgId, 'docs')).toBe(false);

    await clearOverride(orgId);
    expect(await isFeatureEnabled(orgId, 'docs')).toBe(true);
  });
});

describe('ceilings resolve independently per field', () => {
  it('takes the override where present and the plan otherwise', async () => {
    const orgId = await newOrg('ent-limits');
    await admin.query(
      `UPDATE billing.plans SET telephony_cap_cents = 5000, automation_runs_per_hour = 100
       WHERE id = $1`,
      [RICH_PLAN],
    );
    await setPlan(orgId, RICH_PLAN);
    await admin.setOrg(orgId);
    await admin.query(
      `INSERT INTO billing.org_entitlements (org_id, telephony_cap_cents, reason)
       VALUES ($1, 0, 'zero cap test')
       ON CONFLICT (org_id) DO UPDATE SET telephony_cap_cents = 0, automation_runs_per_hour = NULL`,
      [orgId],
    );
    await admin.setOrg(null);
    resetEntitlementCache();

    const { limits } = await getEntitlements(orgId);
    /* ZERO, not 5000. `0` is a real ceiling meaning "no spend at all", and an
       implementation using `||` instead of `??` would silently promote it to
       the plan's value — turning "this org may not spend" into "this org may
       spend up to $50". */
    expect(limits.telephonyCapCents).toBe(0);
    /* The override says nothing about this one, so the plan still decides. */
    expect(limits.automationRunsPerHour).toBe(100);
  });
});

describe('requireFeature — the route gate', () => {
  it('passes silently when the plan includes the module', async () => {
    const orgId = await newOrg('ent-gate-pass');
    await setPlan(orgId, RICH_PLAN);

    await expect(requireFeature(orgId, 'docs', 'Docs')).resolves.toBeUndefined();
  });

  it('throws PLAN_REQUIRED — never FORBIDDEN — when the plan excludes it', async () => {
    /* The distinction this error code exists for. FORBIDDEN means "your role
       does not allow this", which no amount of money changes; PLAN_REQUIRED
       means "your role allows it and your plan does not", which upgrading
       fixes. Collapsing them would tell an Owner they lack permission on
       their own organization.

       Note what this does NOT test: that `can()` still refuses a caller whose
       ROLE forbids the action. That ordering lives in `route()` — the gate
       runs after `couldGrant` — and is asserted by the router-level suites. */
    const orgId = await newOrg('ent-gate-refuse');
    await setPlan(orgId, BARE_PLAN);
    await setOverride(orgId, { remove: ['docs'] });

    const error = await requireFeature(orgId, 'docs', 'Docs').catch((caught: unknown) => caught);

    expect((error as { code?: string }).code).toBe('PLAN_REQUIRED');
    /* The module name rides in `details` so the client can render an upgrade
       CTA without parsing it back out of a sentence. */
    expect((error as { details?: { feature?: string } }).details?.feature).toBe('Docs');
  });
});
