import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { unsafeAsId } from '@taskflow/contracts';
import { closeDatabase, initializeDatabase, withOrgScope } from './index.js';
import { applyMigrations, connectAsMigrator, type AdminConnection } from './testing/index.js';

/**
 * Migration 0054's grants and RLS, asserted against a real database
 * (ai/phase-10.5-sprints.md, Slice 1).
 *
 * Three of 0054's claims are invisible in application code and need the
 * database to prove them:
 *
 *   - **`REVOKE DELETE`** — the `work` schema carries ALTER DEFAULT PRIVILEGES
 *     from 0001, so `taskflow_app` held DELETE on `sprints` before the
 *     migration's REVOKE ran. The lifecycle's terminal states are
 *     `completed`/`cancelled` — the record Phase 11's burndown reads — and a
 *     hard delete would erase history nothing asked to erase. Delete that one
 *     line from the migration and nothing in the application notices.
 *   - **The one-active-sprint invariant is the DATABASE's, not the service's**
 *     — the partial unique index refuses a second `active` row even from a
 *     caller that never consults the service.
 *   - **The composite FK makes a card's sprint provably its own project's** —
 *     a card in org A / project A cannot name a sprint in org B / project B,
 *     the same-tenant wrong-project write `withOrgScope` does nothing about.
 *
 * Plus the RLS half: org-confined reads, asserted as real org-scoped SELECTs
 * rather than privilege checks.
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

const ORG_A = crypto.randomUUID();
const ORG_B = crypto.randomUUID();
const PROJECT_A = crypto.randomUUID();
const PROJECT_B = crypto.randomUUID();
const BOARD_A = crypto.randomUUID();
const LIST_A = crypto.randomUUID();
const CARD_A = crypto.randomUUID();

const SPRINT_A_PLANNED = crypto.randomUUID();
const SPRINT_A_ACTIVE = crypto.randomUUID();
const SPRINT_B_PLANNED = crypto.randomUUID();

beforeAll(async () => {
  await applyMigrations();
  admin = await connectAsMigrator();

  /* The migrator is NOT RLS-exempt, so each row must be written under the
     app.org_id its own tenant policy demands (the api-token-grants suite's
     scaffolding does the same). */
  await admin.setOrg(ORG_A);
  await admin.query(`INSERT INTO identity.orgs (id, name, slug) VALUES ($1, $2, $3)`, [
    ORG_A,
    'Sprint grants A',
    `sprint-grants-a-${crypto.randomUUID().slice(0, 8)}`,
  ]);
  await admin.query(`INSERT INTO work.projects (id, org_id, name, key) VALUES ($1, $2, $3, $4)`, [
    PROJECT_A,
    ORG_A,
    'Sprint project A',
    'SPA',
  ]);
  await admin.query(
    `INSERT INTO work.boards (id, org_id, project_id, name, rank) VALUES ($1, $2, $3, $4, $5)`,
    [BOARD_A, ORG_A, PROJECT_A, 'Board A', 'a0'],
  );
  await admin.query(
    `INSERT INTO work.lists (id, org_id, project_id, board_id, name, rank)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [LIST_A, ORG_A, PROJECT_A, BOARD_A, 'Todo', 'a0'],
  );
  /* One planned and one ACTIVE sprint in org A — the one-active index needs a
     first active row to collide with. */
  await admin.query(
    `INSERT INTO work.sprints (id, org_id, project_id, name, starts_on, ends_on, status)
     VALUES ($1, $2, $3, 'Planned A', CURRENT_DATE, CURRENT_DATE + 14, 'planned'),
            ($4, $2, $3, 'Active A', CURRENT_DATE - 7, CURRENT_DATE + 7, 'active')`,
    [SPRINT_A_PLANNED, ORG_A, PROJECT_A, SPRINT_A_ACTIVE],
  );
  await admin.query(
    `INSERT INTO work.cards
       (id, org_id, project_id, board_id, list_id, number, title, rank)
     VALUES ($1, $2, $3, $4, $5, 1, 'Card A', 'a0')`,
    [CARD_A, ORG_A, PROJECT_A, BOARD_A, LIST_A],
  );

  await admin.setOrg(ORG_B);
  await admin.query(`INSERT INTO identity.orgs (id, name, slug) VALUES ($1, $2, $3)`, [
    ORG_B,
    'Sprint grants B',
    `sprint-grants-b-${crypto.randomUUID().slice(0, 8)}`,
  ]);
  await admin.query(`INSERT INTO work.projects (id, org_id, name, key) VALUES ($1, $2, $3, $4)`, [
    PROJECT_B,
    ORG_B,
    'Sprint project B',
    'SPB',
  ]);
  /* Org B has a PLANNED sprint and no active one — the second test's legal
     insert. */
  await admin.query(
    `INSERT INTO work.sprints (id, org_id, project_id, name, starts_on, ends_on, status)
     VALUES ($1, $2, $3, 'Planned B', CURRENT_DATE + 7, CURRENT_DATE + 21, 'planned')`,
    [SPRINT_B_PLANNED, ORG_B, PROJECT_B],
  );
  await admin.setOrg(null);

  initializeDatabase({
    url: 'postgresql://taskflow_app:app-dev-secret@localhost:5433/taskflow_test',
    applicationName: 'sprints-grants',
  });
});

afterAll(async () => {
  /* Children before parents: cards reference sprints, sprints reference
     projects, everything references orgs. */
  await admin.setOrg(ORG_A);
  await admin.query(`DELETE FROM work.cards WHERE org_id = $1`, [ORG_A]);
  await admin.query(`DELETE FROM work.sprints WHERE org_id = $1`, [ORG_A]);
  await admin.query(`DELETE FROM work.lists WHERE org_id = $1`, [ORG_A]);
  await admin.query(`DELETE FROM work.boards WHERE org_id = $1`, [ORG_A]);
  await admin.query(`DELETE FROM work.projects WHERE org_id = $1`, [ORG_A]);
  await admin.setOrg(ORG_B);
  await admin.query(`DELETE FROM work.sprints WHERE org_id = $1`, [ORG_B]);
  await admin.query(`DELETE FROM work.projects WHERE org_id = $1`, [ORG_B]);
  await admin.query(`DELETE FROM identity.orgs WHERE id = $1`, [ORG_B]);
  await admin.setOrg(ORG_A);
  await admin.query(`DELETE FROM identity.orgs WHERE id = $1`, [ORG_A]);
  await admin.setOrg(null);
  await admin.end();
  await closeDatabase();
});

describe('taskflow_app — what 0054 grants, and what it takes back', () => {
  it("manages the project's sprints but never hard-deletes one", async () => {
    /* THE 0036 ASSERTION for this table. ALTER DEFAULT PRIVILEGES granted
       DELETE here before 0054's REVOKE ran; the explicit REVOKE removes it.
       Delete that one line from the migration and this test fails — nothing
       in the application would. */
    expect(await can('taskflow_app', 'work.sprints', 'SELECT')).toBe(true);
    expect(await can('taskflow_app', 'work.sprints', 'INSERT')).toBe(true);
    expect(await can('taskflow_app', 'work.sprints', 'UPDATE')).toBe(true);
    expect(await can('taskflow_app', 'work.sprints', 'DELETE')).toBe(false);
  });
});

describe("the one-active-sprint invariant is the database's", () => {
  it('refuses a second active sprint for a project that already has one', async () => {
    await admin.setOrg(ORG_A);
    await expect(
      admin.query(
        `INSERT INTO work.sprints (id, org_id, project_id, name, starts_on, ends_on, status)
         VALUES ($1, $2, $3, 'Second active', CURRENT_DATE, CURRENT_DATE + 14, 'active')`,
        [crypto.randomUUID(), ORG_A, PROJECT_A],
      ),
    ).rejects.toThrow(/unique/i);
    await admin.setOrg(null);
  });

  it('allows an active sprint for a project that has none', async () => {
    await admin.setOrg(ORG_B);
    await admin.query(
      `INSERT INTO work.sprints (id, org_id, project_id, name, starts_on, ends_on, status)
       VALUES ($1, $2, $3, 'Active B', CURRENT_DATE - 3, CURRENT_DATE + 11, 'active')`,
      [crypto.randomUUID(), ORG_B, PROJECT_B],
    );
    await admin.setOrg(null);
  });
});

describe("the composite FK — a card can never name another project's sprint", () => {
  it('refuses a sprint from another org AND project', async () => {
    await admin.setOrg(ORG_A);
    await expect(
      admin.query(`UPDATE work.cards SET sprint_id = $1 WHERE id = $2`, [SPRINT_B_PLANNED, CARD_A]),
    ).rejects.toThrow(/foreign key/i);
    await admin.setOrg(null);
  });

  it("accepts a sprint from the card's own project", async () => {
    await admin.setOrg(ORG_A);
    await admin.query(`UPDATE work.cards SET sprint_id = $1 WHERE id = $2`, [
      SPRINT_A_PLANNED,
      CARD_A,
    ]);
    await admin.query(`UPDATE work.cards SET sprint_id = NULL WHERE id = $1`, [CARD_A]);
    await admin.setOrg(null);
  });
});

describe('RLS — org confinement for the app role', () => {
  it('taskflow_app under org A scope sees only org A sprints', async () => {
    await withOrgScope(unsafeAsId<'OrgId'>(ORG_A), async (tx) => {
      const result = await tx.execute(`SELECT count(*)::int AS n FROM work.sprints`);
      /* Two in org A (planned + active) — never three, never one. */
      expect(result.rows[0]?.['n']).toBe(2);
    });
    await withOrgScope(unsafeAsId<'OrgId'>(ORG_B), async (tx) => {
      const result = await tx.execute(`SELECT count(*)::int AS n FROM work.sprints`);
      /* One in org B (planned) plus the active one the test above inserted. */
      expect(result.rows[0]?.['n']).toBe(2);
    });
  });
});
