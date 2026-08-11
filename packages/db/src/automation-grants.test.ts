import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations, connectAsMigrator, type AdminConnection } from './testing/index.js';

/**
 * Migration 0047's grants, asserted against a real database.
 *
 * ## Why this file exists rather than a careful reading of the migration
 *
 * `platform` is one of the schemas migration 0001 paired with
 * `ALTER DEFAULT PRIVILEGES`, which means `taskflow_app` is granted full CRUD
 * on every table the migrator creates there — BEFORE any GRANT in 0047 runs.
 *
 * That is exactly the trap migration 0036 had to correct elsewhere: 0035's
 * "SELECT only" grants on `platform.operators` were WEAKER than what the
 * database already enforced, so the table was writable by the app role despite
 * the migration plainly saying otherwise. A migration creating a table in a
 * schema with default privileges must say what the table must NOT have, not
 * only what it should — and the only way to know it worked is to ask the
 * database.
 *
 * So the assertions below are not a restatement of the migration. They are the
 * check that its REVOKEs actually took effect, and they would have failed on
 * the version of this migration that omitted them.
 *
 * The second half is the claim-only separation (§2, §4): `taskflow_automation`
 * decides WHICH events might fire a rule and must be unable to read a rule,
 * write a run, or touch a budget. That property is worth a test because it is
 * invisible in application code — nothing imports it, nothing calls it, and it
 * only fails the day someone adds a convenience grant.
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

beforeAll(async () => {
  await applyMigrations();
  admin = await connectAsMigrator();
});

afterAll(async () => {
  await admin.end();
});

describe('taskflow_automation — claim-only, by GRANT', () => {
  it('may claim from the outbox and mark its own dispatch rows', async () => {
    /* The 0016 recipe. Without the UPDATE privilege AND the matching
       `WITH CHECK (false)` policy, `claimPending`'s `FOR UPDATE ... SKIP
       LOCKED` silently returns zero rows — a consumer that boots cleanly, logs
       nothing and delivers nothing. */
    expect(await can('taskflow_automation', 'platform.outbox', 'SELECT')).toBe(true);
    expect(await can('taskflow_automation', 'platform.outbox', 'UPDATE')).toBe(true);
    expect(await can('taskflow_automation', 'platform.outbox_dispatch', 'INSERT')).toBe(true);
  });

  it('cannot read a single automation rule', async () => {
    /* THE separation. The role that decides which events might fire a rule
       cannot see the rules — those are read afterward, per event, over the
       ordinary app connection inside withOrgScope. */
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
      expect(
        await can('taskflow_automation', 'platform.automations', privilege),
        `taskflow_automation must not hold ${privilege} on platform.automations`,
      ).toBe(false);
    }
  });

  it('cannot write a run record or touch a budget', async () => {
    for (const table of ['platform.automation_runs', 'platform.automation_budget']) {
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
        expect(
          await can('taskflow_automation', table, privilege),
          `taskflow_automation must not hold ${privilege} on ${table}`,
        ).toBe(false);
      }
    }
  });

  it('cannot reach a tenant table', async () => {
    /* A spot check on the blast radius. The engine's actions run as
       taskflow_app; the claim role has no business anywhere near work data. */
    expect(await can('taskflow_automation', 'work.cards', 'SELECT')).toBe(false);
    expect(await can('taskflow_automation', 'chat.messages', 'SELECT')).toBe(false);
  });
});

describe('taskflow_app — what 0047 grants, and what it takes back', () => {
  it('holds full CRUD on the rules themselves', async () => {
    /* Ordinary org-scoped application data: an admin writes a rule through a
       route, the engine reads it under withOrgScope. */
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
      expect(await can('taskflow_app', 'platform.automations', privilege)).toBe(true);
    }
  });

  it('can append a run record but never rewrite or erase one', async () => {
    /* THE 0036 ASSERTION. `ALTER DEFAULT PRIVILEGES` on `platform` granted
       UPDATE and DELETE here before 0047's own GRANT ran; the explicit REVOKEs
       are what remove them. Delete those two lines from the migration and this
       test is what fails — nothing in the application would. */
    expect(await can('taskflow_app', 'platform.automation_runs', 'SELECT')).toBe(true);
    expect(await can('taskflow_app', 'platform.automation_runs', 'INSERT')).toBe(true);
    expect(await can('taskflow_app', 'platform.automation_runs', 'UPDATE')).toBe(false);
    expect(await can('taskflow_app', 'platform.automation_runs', 'DELETE')).toBe(false);
  });

  it('can increment a budget but never delete one', async () => {
    /* Deleting a budget row resets an org's hourly allowance, which is the
       whole control — so the app role, which is what a compromised runtime
       holds, must not be able to. */
    expect(await can('taskflow_app', 'platform.automation_budget', 'SELECT')).toBe(true);
    expect(await can('taskflow_app', 'platform.automation_budget', 'INSERT')).toBe(true);
    expect(await can('taskflow_app', 'platform.automation_budget', 'UPDATE')).toBe(true);
    expect(await can('taskflow_app', 'platform.automation_budget', 'DELETE')).toBe(false);
  });
});
