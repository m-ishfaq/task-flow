import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { unsafeAsId } from '@taskflow/contracts';
import {
  closeDatabase,
  initializeDatabase,
  initializeIntegrationAuthDatabase,
  withIntegrationAuthScope,
  withOrgScope,
} from './index.js';
import { applyMigrations, connectAsMigrator, type AdminConnection } from './testing/index.js';

/**
 * Migration 0056's grants, asserted against a real database, plus the real
 * lookup through the real role.
 *
 * The 0036 lesson, applied to connectors: `platform` carries ALTER DEFAULT
 * PRIVILEGES from 0001, so `taskflow_app` held full CRUD on `integrations`
 * BEFORE 0056's own GRANT ran. The migration's REVOKE of DELETE is what makes
 * "a disconnect is a status flip, never a row gone" a fact rather than an
 * intention, and the only way to know it took is to ask the database.
 *
 * The second half is the lookup-role separation at the heart of §7.2:
 * `taskflow_integration_auth` resolves an inbound Slack/GitHub webhook to an
 * org across every tenant — the request body names a team_id / repository
 * full_name and the row that maps it to an org names its own org, so no value
 * of `app.org_id` is correct for the read — and must be unable to read
 * anyone's outbound credential (`token_*`) or the connector's `name`. That
 * property is invisible in application code, so it needs a test, or the day
 * someone adds a convenience grant is the day it silently stops being true.
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

/** `has_column_privilege` — the shape the lookup role's COLUMN-LEVEL grant takes. */
async function canColumn(
  role: string,
  table: string,
  column: string,
  privilege: string,
): Promise<boolean> {
  const result = await admin.query(`SELECT has_column_privilege($1, $2, $3, $4) AS allowed`, [
    role,
    table,
    column,
    privilege,
  ]);
  return result.rows[0]?.['allowed'] === true;
}

const ORG_A = crypto.randomUUID();
const ORG_B = crypto.randomUUID();

/* Fixture bytea payloads: any two bytes pass the column type; the encryption
   and AAD binding are slice 2's concern and are asserted there. `decode` keeps
   the fixture honest — a bytea column, not a text one. */
const TOKEN_BYTES = "decode('beef', 'hex')";
const VERIFY_BYTES = "decode('c0ffee', 'hex')";

beforeAll(async () => {
  await applyMigrations();
  admin = await connectAsMigrator();

  /* The migrator is NOT RLS-exempt (BYPASSRLS is the one power init scripts
     never grant), so each row must be written under the app.org_id its own
     tenant_isolation policy demands — the api-token-grants scaffolding does
     the same. */
  await admin.setOrg(ORG_A);
  await admin.query(`INSERT INTO identity.orgs (id, name, slug) VALUES ($1, $2, $3)`, [
    ORG_A,
    'Integration grants A',
    `integration-grants-a-${crypto.randomUUID().slice(0, 8)}`,
  ]);
  /* Org A holds a Slack workspace (no per-org verify secret — Slack
     verification uses the deployment-wide signing secret, so verify_* is
     NULL) and a GitHub repository (verify secret present — D4). The second
     row also proves the app role's org confinement below counts rows, not
     kinds. */
  await admin.query(
    `INSERT INTO platform.integrations
       (id, org_id, provider, name, provider_scope,
        token_ciphertext, token_wrapped, token_master_id)
     VALUES
       ($1, $2, 'slack', 'Example Workspace', 'T12345',
        ${TOKEN_BYTES}, ${TOKEN_BYTES}, 'master-1')`,
    [crypto.randomUUID(), ORG_A],
  );
  await admin.query(
    `INSERT INTO platform.integrations
       (id, org_id, provider, name, provider_scope,
        token_ciphertext, token_wrapped, token_master_id,
        verify_ciphertext, verify_wrapped, verify_master_id)
     VALUES
       ($1, $2, 'github', 'acme/todo', 'acme/todo',
        ${TOKEN_BYTES}, ${TOKEN_BYTES}, 'master-1',
        ${VERIFY_BYTES}, ${VERIFY_BYTES}, 'master-1')`,
    [crypto.randomUUID(), ORG_A],
  );

  await admin.setOrg(ORG_B);
  await admin.query(`INSERT INTO identity.orgs (id, name, slug) VALUES ($1, $2, $3)`, [
    ORG_B,
    'Integration grants B',
    `integration-grants-b-${crypto.randomUUID().slice(0, 8)}`,
  ]);
  await admin.query(
    `INSERT INTO platform.integrations
       (id, org_id, provider, name, provider_scope,
        token_ciphertext, token_wrapped, token_master_id)
     VALUES
       ($1, $2, 'slack', 'Other Workspace', 'T67890',
        ${TOKEN_BYTES}, ${TOKEN_BYTES}, 'master-1')`,
    [crypto.randomUUID(), ORG_B],
  );
  await admin.setOrg(null);

  /* The application connection the RLS suite runs its org-scoped reads on,
     and the auth-role connection the lookup suite runs its cross-org read on
     — the same hardcoded role URLs every other grants suite uses. */
  initializeDatabase({
    url: 'postgresql://taskflow_app:app-dev-secret@localhost:5433/taskflow_test',
    applicationName: 'integration-grants',
  });

  initializeIntegrationAuthDatabase({
    url: 'postgresql://taskflow_integration_auth:integration-auth-dev-secret@localhost:5433/taskflow_test',
    applicationName: 'taskflow-integration-grants-test',
  });
});

afterAll(async () => {
  await admin.setOrg(ORG_A);
  await admin.query(`DELETE FROM platform.integrations WHERE org_id = $1`, [ORG_A]);
  await admin.setOrg(ORG_B);
  await admin.query(`DELETE FROM platform.integrations WHERE org_id = $1`, [ORG_B]);
  await admin.query(`DELETE FROM identity.orgs WHERE id = $1`, [ORG_B]);
  await admin.setOrg(ORG_A);
  await admin.query(`DELETE FROM identity.orgs WHERE id = $1`, [ORG_A]);
  await admin.setOrg(null);
  await admin.end();
  await closeDatabase();
});

describe('taskflow_integration_auth — the lookup role, by GRANT', () => {
  it('may read exactly the lookup columns, across every org', async () => {
    for (const column of [
      'org_id',
      'provider',
      'provider_scope',
      'verify_ciphertext',
      'verify_wrapped',
      'verify_master_id',
    ]) {
      expect(
        await canColumn('taskflow_integration_auth', 'platform.integrations', column, 'SELECT'),
        `taskflow_integration_auth must SELECT ${column}`,
      ).toBe(true);
    }
  });

  it('cannot read the outbound credential, the name, or anything else', async () => {
    /* THE column-level exclusion. Without it, the role that resolves "who is
       this webhook for" across every tenant is also a cross-tenant reader of
       every org's outbound Slack/GitHub credentials. */
    for (const column of [
      'id',
      'name',
      'status',
      'token_ciphertext',
      'token_wrapped',
      'token_master_id',
      'created_by',
      'created_at',
    ]) {
      expect(
        await canColumn('taskflow_integration_auth', 'platform.integrations', column, 'SELECT'),
        `taskflow_integration_auth must not SELECT ${column}`,
      ).toBe(false);
    }
  });

  it('holds no write privilege anywhere', async () => {
    for (const privilege of ['INSERT', 'UPDATE', 'DELETE']) {
      expect(
        await can('taskflow_integration_auth', 'platform.integrations', privilege),
        `taskflow_integration_auth must not hold ${privilege} on platform.integrations`,
      ).toBe(false);
    }
  });

  it('cannot reach a tenant table or the API-token store', async () => {
    expect(await can('taskflow_integration_auth', 'work.cards', 'SELECT')).toBe(false);
    expect(await can('taskflow_integration_auth', 'platform.api_tokens', 'SELECT')).toBe(false);
  });
});

describe('taskflow_app — what 0056 grants, and what it takes back', () => {
  it("manages the org's connectors but never hard-deletes one", async () => {
    /* THE 0036 ASSERTION for this table. ALTER DEFAULT PRIVILEGES granted
       DELETE here before 0056's own GRANT ran; the explicit REVOKE removes
       it. Delete that one line from the migration and this test fails —
       nothing in the application would. */
    expect(await can('taskflow_app', 'platform.integrations', 'SELECT')).toBe(true);
    expect(await can('taskflow_app', 'platform.integrations', 'INSERT')).toBe(true);
    expect(await can('taskflow_app', 'platform.integrations', 'UPDATE')).toBe(true);
    expect(await can('taskflow_app', 'platform.integrations', 'DELETE')).toBe(false);
  });
});

describe('the real lookup, as the real role', () => {
  it('resolves a connector scope to its org across every tenant', async () => {
    /* The auth role's read is cross-org BY DESIGN — an inbound webhook names
       a team_id / repository with no org context, and the row answers. Both
       orgs' rows must be visible through one read. */
    const rows = await withIntegrationAuthScope(async (tx) => {
      const result = await tx.execute(
        `SELECT org_id, provider, provider_scope FROM platform.integrations ORDER BY provider_scope`,
      );
      return result.rows;
    });

    expect(rows).toHaveLength(3);
    /* Slack rows carry a NULL verify secret and the SELECT still succeeds —
       the column grant covers the columns, not the values. */
    expect(rows.map((row) => row['provider_scope'])).toEqual(['T12345', 'T67890', 'acme/todo']);
  });
});

describe('the app role is RLS-confined where the lookup role deliberately is not', () => {
  /* The two roles answer different questions, and the contrast is the point:
     `taskflow_integration_auth` MUST cross orgs (an inbound webhook names no
     org — its row does), while `taskflow_app` must NEVER: every connector row
     the app role reads is inside its tenant_isolation policy. The lookup
     above proves the first; these two prove the second, as REAL org-scoped
     SELECTs rather than privilege checks — a privilege is only a claim, and
     RLS is the behaviour. */

  it('taskflow_app under org A scope sees only org A connectors', async () => {
    await withOrgScope(unsafeAsId<'OrgId'>(ORG_A), async (tx) => {
      const result = await tx.execute(`SELECT count(*)::int AS n FROM platform.integrations`);
      /* Two in org A (slack + github) — never three, never one. */
      expect(result.rows[0]?.['n']).toBe(2);
    });
    await withOrgScope(unsafeAsId<'OrgId'>(ORG_B), async (tx) => {
      const result = await tx.execute(`SELECT count(*)::int AS n FROM platform.integrations`);
      expect(result.rows[0]?.['n']).toBe(1);
    });
  });
});
