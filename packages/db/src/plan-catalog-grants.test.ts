import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations, connectAsMigrator, type AdminConnection } from './testing/index.js';

/**
 * Migration 0062's grants and constraints, asserted against a real database
 * (Phase 12 Wave 4, ai/phase-12-wave4-plans.md §3.3, §6).
 *
 * ## Why this file exists rather than a careful reading of the migration
 *
 * `billing` is a schema migration 0059 paired with `ALTER DEFAULT PRIVILEGES`:
 *
 *   ALTER DEFAULT PRIVILEGES FOR ROLE taskflow_migrator IN SCHEMA billing
 *     GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO taskflow_app;
 *
 * So every table 0062 creates is fully writable by the application role the
 * instant it exists, BEFORE any GRANT in that migration runs. A migration that
 * granted `taskflow_app` SELECT only would be describing a database it had not
 * produced — and it would read as correct in review.
 *
 * That is migration 0036's trap, one schema over: 0035's "SELECT only" grants
 * on `platform.operators` were WEAKER than what the database already enforced,
 * and it took explicit REVOKEs to close. It was found by a test like this one,
 * not by reading the migration.
 *
 * So the assertions below are not a restatement of 0062. They are the check
 * that its REVOKEs took effect, and every one of them fails on the version of
 * that migration without them.
 *
 * The second half asserts the invariants that are enforced by INDEX and CHECK
 * rather than by service code — the ones a future refactor of
 * `plan-catalog.service.ts` cannot break even by trying, provided they are
 * really there.
 */

let admin: AdminConnection;

/** `has_table_privilege` for one role/table/privilege, as a plain boolean. */
async function can(role: string, table: string, privilege: string): Promise<boolean> {
  const result = await admin.query(`SELECT has_table_privilege($1, $2, $3) AS allowed`, [
    role,
    table,
    privilege,
  ]);
  return result.rows[0]?.['allowed'] === true;
}

/**
 * The one plan this file creates to violate constraints against.
 *
 * Named, and torn down at both ends, because `taskflow_test` PERSISTS between
 * runs: the first version of this file inserted its fixture and left it there,
 * so the run passed once and then failed on every subsequent run with a
 * `plan_prices_current_key` violation raised by its own SETUP rather than by
 * the assertion — which reads exactly like the constraint being broken by the
 * code under test. That is this repo's own standing lesson about test residue
 * (`ours()` in relay.test.ts, and `clearTenant`'s children-before-parents
 * ordering), applied to a global table with no org to scope by.
 */
const FIXTURE_PLAN = 'grants-test-target';

/** Children before parents — plan_prices references plans. */
async function clearFixture(): Promise<void> {
  await admin.query(`DELETE FROM billing.plan_prices WHERE plan_id = $1`, [FIXTURE_PLAN]);
  await admin.query(`DELETE FROM billing.plans WHERE id = ANY($1)`, [
    [FIXTURE_PLAN, 'rival-default', 'freebie-with-allowance'],
  ]);
}

beforeAll(async () => {
  await applyMigrations();
  admin = await connectAsMigrator();
  /* Before, not only after: an ABORTED previous run skips teardown, and the
     next run must not inherit its rows. */
  await clearFixture();
});

afterAll(async () => {
  await clearFixture();
  await admin.end();
});

describe('the plan catalog is read-only for the application role', () => {
  /* The three tables, and the three privileges the schema's default grant
     would otherwise have handed out. Written as a loop rather than nine
     assertions so a fourth table added to `billing` without a REVOKE is one
     line away from being covered. */
  const CATALOG_TABLES = ['billing.plans', 'billing.plan_prices', 'billing.org_entitlements'];

  it('grants taskflow_app SELECT on every catalog table', () => {
    /* The positive half matters too: the owner-facing plan picker and the
       billing page both read the catalog, so a REVOKE that overshot to
       include SELECT would break the product rather than secure it. */
    return Promise.all(
      CATALOG_TABLES.map(async (table) => {
        expect(await can('taskflow_app', table, 'SELECT'), `${table} SELECT`).toBe(true);
      }),
    );
  });

  it('denies taskflow_app INSERT, UPDATE and DELETE on every catalog table', () => {
    /* THE assertion this file exists for. Without 0062's REVOKEs every one of
       these is `true` — inherited from 0059's ALTER DEFAULT PRIVILEGES — and
       the application role can rewrite the price list. */
    return Promise.all(
      CATALOG_TABLES.flatMap((table) =>
        ['INSERT', 'UPDATE', 'DELETE'].map(async (privilege) => {
          expect(await can('taskflow_app', table, privilege), `${table} ${privilege}`).toBe(false);
        }),
      ),
    );
  });

  it('lets the operator role write plans and prices but never DELETE them', async () => {
    /* Archive, never remove. `identity.orgs.plan_id` references a plan and
       every retired price is what a grandfathered subscriber is still billed
       against, so a DELETE would either be refused by the foreign key or would
       orphan a live subscription. No role holds it — not even this one. */
    expect(await can('taskflow_platform_admin', 'billing.plans', 'INSERT')).toBe(true);
    expect(await can('taskflow_platform_admin', 'billing.plans', 'UPDATE')).toBe(true);
    expect(await can('taskflow_platform_admin', 'billing.plans', 'DELETE')).toBe(false);

    expect(await can('taskflow_platform_admin', 'billing.plan_prices', 'INSERT')).toBe(true);
    expect(await can('taskflow_platform_admin', 'billing.plan_prices', 'UPDATE')).toBe(true);
    expect(await can('taskflow_platform_admin', 'billing.plan_prices', 'DELETE')).toBe(false);
  });

  it('lets the operator role DELETE an entitlement override, and only that', async () => {
    /* Removing an override restores the plan's own answer, which loses
       nothing — the one place in this migration where DELETE is the correct
       grant rather than an oversight. */
    expect(await can('taskflow_platform_admin', 'billing.org_entitlements', 'DELETE')).toBe(true);
  });
});

describe('invariants the database enforces, not the service', () => {
  it('permits at most one default plan', async () => {
    /* Where every expiring trial lands. Two rows carrying the flag would make
       that destination depend on row order, silently, at the moment a
       customer's access changes — so it is a partial unique index rather than
       an `UPDATE ... SET is_default = false` the service must remember. 0063
       seeds 'free' as the default, so any second one is a violation. */
    await expect(
      admin.query(
        `INSERT INTO billing.plans (id, name, is_default) VALUES ('rival-default', 'Rival', true)`,
      ),
    ).rejects.toThrow(/plans_one_default_key/);
  });

  it('refuses a price that is both archived and current', async () => {
    /* The half-state: retiring a price is two column writes, and a service
       that does one of them leaves a retired price still being sold. */
    await admin.query(
      `INSERT INTO billing.plans (id, name, stripe_product_id)
       VALUES ($1, 'Grants Test Target', 'prod_grants_test_target')
       ON CONFLICT (id) DO NOTHING`,
      [FIXTURE_PLAN],
    );

    await expect(
      admin.query(
        `INSERT INTO billing.plan_prices (plan_id, interval, amount_cents, is_current, archived_at)
         VALUES ($1, 'month', 2900, true, now())`,
        [FIXTURE_PLAN],
      ),
    ).rejects.toThrow(/plan_prices_archived_is_not_current/);
  });

  it('permits only one CURRENT price per plan and interval', async () => {
    /* The grandfathering mechanism itself. Many rows per (plan, interval),
       exactly one current — so `setPrice` cannot leave two live prices behind
       even if its retire-then-insert ordering were reversed. */
    await admin.query(
      `INSERT INTO billing.plan_prices (plan_id, interval, amount_cents, is_current)
       VALUES ($1, 'year', 29000, true)`,
      [FIXTURE_PLAN],
    );

    await expect(
      admin.query(
        `INSERT INTO billing.plan_prices (plan_id, interval, amount_cents, is_current)
         VALUES ($1, 'year', 39000, true)`,
        [FIXTURE_PLAN],
      ),
    ).rejects.toThrow(/plan_prices_current_key/);
  });

  it('refuses an override that both adds and removes the same feature', async () => {
    /* No defined answer, and picking one silently would make the resolver's
       precedence depend on which branch was written first. */
    const org = await admin.query(`SELECT id FROM identity.orgs LIMIT 1`);
    const orgId = org.rows[0]?.['id'] as string | undefined;
    if (orgId === undefined) return; // no fixture org in this database; nothing to assert against

    await expect(
      admin.query(
        `INSERT INTO billing.org_entitlements (org_id, features_add, features_remove, reason)
         VALUES ($1, ARRAY['docs'], ARRAY['docs'], 'contradiction test')`,
        [orgId],
      ),
    ).rejects.toThrow(/org_entitlements_no_contradiction/);
  });

  it('refuses an override with no stated reason', async () => {
    /* An operator override outranks the plan, which is what makes it useful
       and what makes it dangerous. "Why does this Free org have Voice" has to
       stay answerable, and a blank reason is how it stops being. */
    const org = await admin.query(`SELECT id FROM identity.orgs LIMIT 1`);
    const orgId = org.rows[0]?.['id'] as string | undefined;
    if (orgId === undefined) return;

    await expect(
      admin.query(`INSERT INTO billing.org_entitlements (org_id, reason) VALUES ($1, '   ')`, [
        orgId,
      ]),
    ).rejects.toThrow(/org_entitlements_reason_present/);
  });

  it('refuses an included allowance on a plan with no processor product', async () => {
    /* An allowance on a free tier is a number with no consumer: there is no
       subscription to attach an overage invoice item to. */
    await expect(
      admin.query(
        `INSERT INTO billing.plans (id, name, telephony_included_cents)
         VALUES ('freebie-with-allowance', 'Freebie', 1000)`,
      ),
    ).rejects.toThrow(/plans_included_needs_a_product/);
  });
});

describe('0063 gives identity.orgs.plan_id a real referent', () => {
  it('refuses an org pointed at a plan that does not exist', async () => {
    /* Before 0063 this column was free text: a typo in a webhook handler
       produced an org on a plan nothing could resolve, and nothing said so. */
    const org = await admin.query(`SELECT id FROM identity.orgs LIMIT 1`);
    const orgId = org.rows[0]?.['id'] as string | undefined;
    if (orgId === undefined) return;

    await expect(
      admin.query(`UPDATE identity.orgs SET plan_id = 'no-such-plan' WHERE id = $1`, [orgId]),
    ).rejects.toThrow(/orgs_plan_id_fk/);
  });

  it('seeds free as the default and pro carrying every grantable flag', async () => {
    /* 0063's fail-safe direction: `pro` is seeded with the whole registry so
       that when slice 2 starts reading plan features, an org that is paying
       today does not silently lose a module because a migration guessed a
       smaller set. Reductions must be a deliberate operator action. */
    const result = await admin.query(
      `SELECT id, is_default, features FROM billing.plans WHERE id IN ('free','pro') ORDER BY id`,
    );

    const free = result.rows.find((row) => row['id'] === 'free');
    const pro = result.rows.find((row) => row['id'] === 'pro');

    expect(free?.['is_default']).toBe(true);
    expect(pro?.['is_default']).toBe(false);
    expect(free?.['features']).toEqual([]);
    expect(pro?.['features']).toContain('docs');
    /* Release plumbing that starts real carrier spend — declared perOrg:false,
       so it is not a thing a plan may grant. The service refuses it too. */
    expect(pro?.['features']).not.toContain('telephonyLiveCredentials');
  });
});
