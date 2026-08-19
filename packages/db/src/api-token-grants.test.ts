import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { unsafeAsId } from '@taskflow/contracts';
import {
  closeDatabase,
  initializeApiTokenAuthDatabase,
  initializeDatabase,
  resolveApiToken,
  withOrgScope,
} from './index.js';
import { applyMigrations, connectAsMigrator, type AdminConnection } from './testing/index.js';

/**
 * Migrations 0050 + 0051's grants, asserted against a real database, plus the
 * real lookup through the real role.
 *
 * The 0036 lesson, applied to tokens: `platform` carries ALTER DEFAULT
 * PRIVILEGES from 0001, so `taskflow_app` held full CRUD on `api_tokens`
 * BEFORE 0050's own GRANT ran. The migration's REVOKE of DELETE is what makes
 * "a token is never hard-deleted — revocation is the operation" a fact rather
 * than an intention, and the only way to know it took is to ask the database.
 *
 * The second half is the lookup-role separation at the heart of §6.2:
 * `taskflow_api_token_auth` resolves a presented `tf_pat` by its hash across
 * every tenant — the token row names its org, so no value of `app.org_id` is
 * correct for the read — and must be unable to read what its tokens are
 * called (`name`, `token_prefix`) or when they were last used. 0051 widened
 * the grant with `id` and `created_at` — the auth path needs them as the
 * principal's `sessionId` and `authenticatedAt` (§6.4 step 5) — but the
 * exclusions are the point and stay asserted below. That property is
 * invisible in application code, so it needs a test, or the day someone adds
 * a convenience grant is the day it silently stops being true.
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
const USER = crypto.randomUUID();

/* Token row ids, module-level so the RLS suite below can seed and count quota
   rows against the SAME fixtures the lookup tests resolve. */
const TOKEN_A_LIVE = crypto.randomUUID();
const TOKEN_A_REVOKED = crypto.randomUUID();
const TOKEN_B_LIVE = crypto.randomUUID();

/* Fixture "hashes": any 64-char hex passes the CHECK; resolveApiToken is an
   equality lookup, so the value's provenance does not matter. Avoids
   importing node:crypto, which guardrail 5 bans outside packages/security. */
const LIVE_HASH = 'a'.repeat(64);
const REVOKED_HASH = 'b'.repeat(64);

beforeAll(async () => {
  await applyMigrations();
  admin = await connectAsMigrator();

  /* The migrator is NOT RLS-exempt (BYPASSRLS is the one power init scripts
     never grant), so each row must be written under the app.org_id its own
     tenant_isolation policy demands — the delivery test's scaffolding does
     the same: users under null scope, an org and its rows under that org. */
  await admin.setOrg(null);
  await admin.query(
    `INSERT INTO identity.users (id, email, email_normalized, email_verified_at)
     VALUES ($1, $2, $2, now())`,
    [USER, `api-token-${crypto.randomUUID().slice(0, 8)}@grants.test`],
  );

  /* One live token and one revoked token in org A, one live token in org B —
     the third is what proves the lookup role crosses orgs while the
     application role's RLS does not. */
  await admin.setOrg(ORG_A);
  await admin.query(`INSERT INTO identity.orgs (id, name, slug) VALUES ($1, $2, $3)`, [
    ORG_A,
    'Token grants A',
    `token-grants-a-${crypto.randomUUID().slice(0, 8)}`,
  ]);
  await admin.query(
    `INSERT INTO platform.api_tokens
       (id, org_id, created_by, name, token_hash, token_prefix, scopes, revoked_at)
     VALUES
       ($1, $2, $3, 'live', $4, 'live_pref1', ARRAY['card:read']::text[], NULL),
       ($5, $2, $3, 'revoked', $6, 'revok_pref', ARRAY['card:read']::text[], now())`,
    [TOKEN_A_LIVE, ORG_A, USER, LIVE_HASH, TOKEN_A_REVOKED, REVOKED_HASH],
  );
  /* A quota row per org, with DISTINCT counters — the RLS suite asserts which
     one each org scope sees. The count column is 5 for A, 7 for B. */
  await admin.query(
    `INSERT INTO platform.api_token_quota (token_id, org_id, quota_date, used_count, expensive_count)
     VALUES ($1, $2, CURRENT_DATE, 5, 0)`,
    [TOKEN_A_LIVE, ORG_A],
  );

  await admin.setOrg(ORG_B);
  await admin.query(`INSERT INTO identity.orgs (id, name, slug) VALUES ($1, $2, $3)`, [
    ORG_B,
    'Token grants B',
    `token-grants-b-${crypto.randomUUID().slice(0, 8)}`,
  ]);
  await admin.query(
    `INSERT INTO platform.api_tokens
       (id, org_id, created_by, name, token_hash, token_prefix, scopes, revoked_at)
     VALUES       ($1, $2, $3, 'other-org', $4, 'other_pref', ARRAY['card:read']::text[], NULL)`,
    [TOKEN_B_LIVE, ORG_B, USER, 'c'.repeat(64)],
  );
  await admin.query(
    `INSERT INTO platform.api_token_quota (token_id, org_id, quota_date, used_count, expensive_count)
     VALUES ($1, $2, CURRENT_DATE, 7, 0)`,
    [TOKEN_B_LIVE, ORG_B],
  );
  await admin.setOrg(null);

  /* The application connection the RLS suite runs its org-scoped reads on —
     the same hardcoded taskflow_app URL the auth suite uses. */
  initializeDatabase({
    url: 'postgresql://taskflow_app:app-dev-secret@localhost:5433/taskflow_test',
    applicationName: 'api-token-grants',
  });

  initializeApiTokenAuthDatabase({
    url: 'postgresql://taskflow_api_token_auth:api-token-auth-dev-secret@localhost:5433/taskflow_test',
    applicationName: 'taskflow-api-token-grants-test',
  });
});

afterAll(async () => {
  await admin.setOrg(ORG_A);
  await admin.query(`DELETE FROM platform.api_tokens WHERE org_id = $1`, [ORG_A]);
  await admin.setOrg(ORG_B);
  await admin.query(`DELETE FROM platform.api_tokens WHERE org_id = $1`, [ORG_B]);
  await admin.query(`DELETE FROM identity.orgs WHERE id = $1`, [ORG_B]);
  await admin.setOrg(ORG_A);
  await admin.query(`DELETE FROM identity.orgs WHERE id = $1`, [ORG_A]);
  await admin.setOrg(null);
  await admin.query(`DELETE FROM identity.users WHERE id = $1`, [USER]);
  await admin.end();
  await closeDatabase();
});

describe('taskflow_api_token_auth — the lookup role, by GRANT', () => {
  it('may read exactly the lookup columns, across every org', async () => {
    /* 0051 added `id` and `created_at` to the grant — the auth path needs
       them as sessionId/authenticatedAt. 0079 added `expires_at`, which the
       lookup filters on so an expired token resolves to nothing. Everything
       else 0050 granted stays. */
    for (const column of [
      'token_hash',
      'org_id',
      'created_by',
      'scopes',
      'revoked_at',
      'id',
      'created_at',
      'expires_at',
    ]) {
      expect(
        await canColumn('taskflow_api_token_auth', 'platform.api_tokens', column, 'SELECT'),
      ).toBe(true);
    }
  });

  it('cannot read what the tokens are called or when they were last used', async () => {
    /* THE column-level exclusion. Without it, the role that authenticates a
       token across every tenant is also a cross-tenant reader of token names
       and usage. */
    for (const column of ['name', 'token_prefix', 'last_used_at']) {
      expect(
        await canColumn('taskflow_api_token_auth', 'platform.api_tokens', column, 'SELECT'),
        `taskflow_api_token_auth must not SELECT ${column}`,
      ).toBe(false);
    }
  });

  it('holds no write privilege anywhere', async () => {
    for (const privilege of ['INSERT', 'UPDATE', 'DELETE']) {
      expect(
        await can('taskflow_api_token_auth', 'platform.api_tokens', privilege),
        `taskflow_api_token_auth must not hold ${privilege} on platform.api_tokens`,
      ).toBe(false);
    }
  });

  it('cannot reach a tenant table', async () => {
    expect(await can('taskflow_api_token_auth', 'work.cards', 'SELECT')).toBe(false);
  });
});

describe('taskflow_app — what 0050 grants, and what it takes back', () => {
  it("manages the org's tokens but never hard-deletes one", async () => {
    /* THE 0036 ASSERTION for this table. ALTER DEFAULT PRIVILEGES granted
       DELETE here before 0050's own GRANT ran; the explicit REVOKE removes
       it. Delete that one line from the migration and this test fails —
       nothing in the application would. */
    expect(await can('taskflow_app', 'platform.api_tokens', 'SELECT')).toBe(true);
    expect(await can('taskflow_app', 'platform.api_tokens', 'INSERT')).toBe(true);
    expect(await can('taskflow_app', 'platform.api_tokens', 'UPDATE')).toBe(true);
    expect(await can('taskflow_app', 'platform.api_tokens', 'DELETE')).toBe(false);
  });

  it('0052: consumes quota but never deletes a quota row', async () => {
    /* The same 0036 assertion for the quota table. The consume statement is
       an upsert (INSERT + UPDATE) and the counters are append-only by
       design — the row dies with its token, via the ON DELETE CASCADE, and
       nothing in the application deletes one directly. */
    expect(await can('taskflow_app', 'platform.api_token_quota', 'SELECT')).toBe(true);
    expect(await can('taskflow_app', 'platform.api_token_quota', 'INSERT')).toBe(true);
    expect(await can('taskflow_app', 'platform.api_token_quota', 'UPDATE')).toBe(true);
    expect(await can('taskflow_app', 'platform.api_token_quota', 'DELETE')).toBe(false);

    /* The lookup role never touches quota: authentication reads api_tokens
       and nothing else; the consuming statement runs as the app role inside
       the route gate. */
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
      expect(
        await can('taskflow_api_token_auth', 'platform.api_token_quota', privilege),
        `taskflow_api_token_auth must not hold ${privilege} on platform.api_token_quota`,
      ).toBe(false);
    }
  });
});

describe('resolveApiToken — the real lookup, as the real role', () => {
  it('resolves a live token to its org, holder, scopes, row id and mint time', async () => {
    const resolved = await resolveApiToken(LIVE_HASH);
    expect(resolved).toMatchObject({
      orgId: ORG_A,
      createdBy: USER,
      scopes: ['card:read'],
    });
    /* The auth path (slice 3) uses these two as sessionId and
       authenticatedAt — the token IS the credential, so its row id and mint
       time are the request's session and proof-of-credential time. */
    expect(resolved?.tokenId).toEqual(expect.any(String) as string);
    expect(resolved?.createdAt).toBeInstanceOf(Date);
  });

  it('refuses a revoked token — revocation takes effect on the next request', async () => {
    expect(await resolveApiToken(REVOKED_HASH)).toBeUndefined();
  });

  it('refuses an unknown hash', async () => {
    expect(await resolveApiToken('d'.repeat(64))).toBeUndefined();
  });

  it('refuses an empty string before it touches the database', async () => {
    expect(await resolveApiToken('')).toBeUndefined();
  });
});

describe('the app role is RLS-confined where the lookup role deliberately is not', () => {
  /* The two roles answer different questions, and the contrast is the point:
     `taskflow_api_token_auth` MUST cross orgs (the presented token's row names
     its org — no app.org_id is correct for the read), while `taskflow_app`
     must NEVER: every token the app role reads is inside its tenant_isolation
     policy. `resolveApiToken` above proves the first; these two prove the
     second, as REAL org-scoped SELECTs rather than privilege checks — a
     privilege is only a claim, and RLS is the behaviour. */

  it('taskflow_app under org A scope sees only org A tokens', async () => {
    /* The org ids are fixture uuids; `unsafeAsId` is the trust-boundary
       constructor for exactly this — a value that came from `randomUUID`
       and never crossed a wire. */
    await withOrgScope(unsafeAsId<'OrgId'>(ORG_A), async (tx) => {
      const result = await tx.execute(`SELECT count(*)::int AS n FROM platform.api_tokens`);
      /* Two in org A (live + revoked) — never three, never one. */
      expect(result.rows[0]?.['n']).toBe(2);
    });
    await withOrgScope(unsafeAsId<'OrgId'>(ORG_B), async (tx) => {
      const result = await tx.execute(`SELECT count(*)::int AS n FROM platform.api_tokens`);
      expect(result.rows[0]?.['n']).toBe(1);
    });
  });

  it('api_token_quota is org-confined for the app role too', async () => {
    await withOrgScope(unsafeAsId<'OrgId'>(ORG_A), async (tx) => {
      const result = await tx.execute(
        `SELECT used_count::int AS used FROM platform.api_token_quota`,
      );
      /* Org A seeded 5; org B's row (7) is invisible from here. Without RLS,
         the consume helper could charge one org's quota against another. */
      expect(result.rows[0]?.['used']).toBe(5);
    });
    await withOrgScope(unsafeAsId<'OrgId'>(ORG_B), async (tx) => {
      const result = await tx.execute(
        `SELECT used_count::int AS used FROM platform.api_token_quota`,
      );
      expect(result.rows[0]?.['used']).toBe(7);
    });
  });
});
