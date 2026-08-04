import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  closeDatabase,
  initializeDatabase,
  withGlobalScope,
  withOrgScope,
  type OrgId,
} from './client.js';
import { tenantRlsPolicy } from './rls.js';
import { up } from './migrate/runner.js';
import { sql } from 'drizzle-orm';

/**
 * Integration test for the tenant-scoped client (PLAN.md §2.1 guardrail 2, §8.3).
 *
 * Runs against real Postgres — `docker compose up -d` must be running. There is
 * no mock here on purpose: RLS is a database behaviour, and a mocked version
 * would assert only that this file's own assumptions are self-consistent.
 *
 * This is the precursor to the full tenancy isolation fuzz test (guardrail 8),
 * which enumerates every endpoint in Phase 0B. Here we prove the primitive that
 * fuzz test will depend on.
 */

const APP_URL =
  process.env['TEST_DATABASE_URL'] ?? 'postgresql://taskflow_app:app-dev-secret@localhost:5433/taskflow_test';
const MIGRATION_URL =
  process.env['TEST_DATABASE_MIGRATION_URL'] ??
  'postgresql://taskflow_migrator:migrator-dev-secret@localhost:5433/taskflow_test';

const ORG_A = '11111111-1111-1111-1111-111111111111' as OrgId;
const ORG_B = '22222222-2222-2222-2222-222222222222' as OrgId;

const TABLE = 'work.rls_client_probe';

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/** SQLSTATE for "new row violates row-level security policy". */
const RLS_VIOLATION = '42501';

/**
 * Walks the `cause` chain for a Postgres SQLSTATE.
 *
 * ORMs wrap driver errors, and how deeply they wrap changes between versions —
 * drizzle 0.45 added a "Failed query: ..." wrapper that hid the original. Tests
 * asserting on database behaviour should key off the code, which is stable.
 */
function pgErrorCode(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth += 1) {
    if (typeof current === 'object' && 'code' in current) {
      const { code } = current;
      if (typeof code === 'string') return code;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

beforeAll(async () => {
  // The probe table lives in the `work` schema, which migration 0001 creates.
  // Applying migrations here rather than assuming a prepared database keeps this
  // test hermetic: it passes against a fresh container with no manual setup, and
  // does not depend on the order of steps in CI.
  //
  // This was a real failure — the test passed locally only because migrate:up
  // had been run by hand earlier in the session, and failed on the first CI run
  // with 'schema "work" does not exist'.
  await up({ migrationUrl: MIGRATION_URL, migrationsDir: MIGRATIONS_DIR });

  const admin = new pg.Client({ connectionString: MIGRATION_URL });
  await admin.connect();

  await admin.query(`DROP TABLE IF EXISTS ${TABLE}`);
  await admin.query(`
    CREATE TABLE ${TABLE} (
      id     serial PRIMARY KEY,
      org_id uuid NOT NULL,
      data   text NOT NULL
    )
  `);
  await admin.query(tenantRlsPolicy('work', 'rls_client_probe'));
  await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${TABLE} TO taskflow_app`);
  await admin.query(`GRANT USAGE, SELECT ON SEQUENCE work.rls_client_probe_id_seq TO taskflow_app`);

  // Seeded as the migrator, which is subject to FORCE RLS like everyone else —
  // so scope each insert explicitly.
  await admin.query(`SELECT set_config('app.org_id', $1, false)`, [ORG_A]);
  await admin.query(`INSERT INTO ${TABLE} (org_id, data) VALUES ($1, 'org A row')`, [ORG_A]);
  await admin.query(`SELECT set_config('app.org_id', $1, false)`, [ORG_B]);
  await admin.query(`INSERT INTO ${TABLE} (org_id, data) VALUES ($1, 'org B row')`, [ORG_B]);

  await admin.end();

  initializeDatabase({ url: APP_URL, applicationName: 'taskflow-test' });
});

afterAll(async () => {
  await closeDatabase();
  const admin = new pg.Client({ connectionString: MIGRATION_URL });
  await admin.connect();
  await admin.query(`DROP TABLE IF EXISTS ${TABLE}`);
  await admin.end();
});

describe('withOrgScope', () => {
  it('sees only the scoped org’s rows', async () => {
    const rowsA = await withOrgScope(ORG_A, async (tx) =>
      tx.execute(sql`SELECT data FROM work.rls_client_probe`),
    );
    expect(rowsA.rows).toEqual([{ data: 'org A row' }]);

    const rowsB = await withOrgScope(ORG_B, async (tx) =>
      tx.execute(sql`SELECT data FROM work.rls_client_probe`),
    );
    expect(rowsB.rows).toEqual([{ data: 'org B row' }]);
  });

  it('cannot reach another org’s row even when targeting it by primary key', async () => {
    // The classic IDOR shape: a valid id from another tenant, guessed or leaked.
    const all = await withOrgScope(ORG_B, async (tx) =>
      tx.execute(sql`SELECT id FROM work.rls_client_probe`),
    );
    const orgBId = (all.rows[0] as { id: number }).id;

    const attempt = await withOrgScope(ORG_A, async (tx) =>
      tx.execute(sql`SELECT data FROM work.rls_client_probe WHERE id = ${orgBId}`),
    );
    expect(attempt.rows).toEqual([]);
  });

  it('refuses to write a row stamped with another org (WITH CHECK)', async () => {
    // USING filters what a query can SEE; WITH CHECK constrains what it may
    // WRITE. Without the latter, org A could insert rows into org B's data.
    const thrown: unknown = await withOrgScope(ORG_A, async (tx) =>
      tx.execute(
        sql`INSERT INTO work.rls_client_probe (org_id, data) VALUES (${ORG_B}, 'smuggled')`,
      ),
    ).catch((error: unknown) => error);

    // Asserted on SQLSTATE rather than the message. Drizzle 0.45 wraps driver
    // errors as "Failed query: ..." and moves the Postgres text into `cause`,
    // which silently broke a message-based assertion on upgrade. Codes are
    // stable across ORM versions and locales; messages are not.
    expect(pgErrorCode(thrown)).toBe(RLS_VIOLATION);
  });

  it('cannot update another org’s row', async () => {
    const result = await withOrgScope(ORG_A, async (tx) =>
      tx.execute(sql`UPDATE work.rls_client_probe SET data = 'tampered' WHERE data = 'org B row'`),
    );
    expect(result.rowCount).toBe(0);

    const check = await withOrgScope(ORG_B, async (tx) =>
      tx.execute(sql`SELECT data FROM work.rls_client_probe`),
    );
    expect(check.rows).toEqual([{ data: 'org B row' }]);
  });

  it('does not leak scope into a later unscoped transaction on a pooled connection', async () => {
    // SET LOCAL is transaction-scoped, but the underlying connection is reused.
    // If scope survived the transaction, one tenant's request could inherit
    // another's context — the worst possible pooling bug.
    await withOrgScope(ORG_A, async (tx) =>
      tx.execute(sql`SELECT data FROM work.rls_client_probe`),
    );

    const leaked = await withGlobalScope(async (tx) =>
      tx.execute(sql`SELECT data FROM work.rls_client_probe`),
    );
    expect(leaked.rows).toEqual([]);
  });
});

describe('withGlobalScope', () => {
  it('returns zero rows from tenant tables rather than all rows', async () => {
    // The defining property of guardrail 3: absent org context fails CLOSED.
    const rows = await withGlobalScope(async (tx) =>
      tx.execute(sql`SELECT data FROM work.rls_client_probe`),
    );
    expect(rows.rows).toEqual([]);
  });
});
