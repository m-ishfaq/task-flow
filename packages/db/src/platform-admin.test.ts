import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import {
  closeDatabase,
  initializeDatabase,
  initializePlatformAdminDatabase,
  withOrgScope,
  withPlatformAdminScope,
  type OrgId,
} from './client.js';
import { appendOperatorAuditEntry, readOperatorChain } from './platform-admin.js';
import { up } from './migrate/runner.js';

/**
 * The platform-admin trust tier against real Postgres (Phase 12 §3.1, §3.7,
 * §4, migration 0032).
 *
 * Three properties here cannot be demonstrated any other way, and each is
 * exactly the shape of bug this codebase's own history says survives a type
 * check and a superficial review:
 *
 *   - `taskflow_app` cannot INSERT into `platform.operators` — the one
 *     control in the whole wave with no code-level fallback if the grant is
 *     ever widened by accident. A migration that "looks narrow" (a single
 *     `GRANT SELECT`) can still leave a wider default privilege in force —
 *     see migration 0032's own header for the real instance of this that
 *     this test would have caught.
 *   - `taskflow_platform_admin` actually SEES real rows in `identity.orgs`
 *     with no session variables set — the exact class of failure
 *     `withGlobalScope` would have produced silently (an empty list that
 *     reads as "no orgs exist" rather than "the query is broken").
 *   - The operator audit chain's trigger assigns seq/hash the same way
 *     `audit.chain_entry()` does for the org-scoped chain, under a single
 *     GLOBAL lock rather than a per-org one.
 */

const APP_URL =
  process.env['TEST_DATABASE_URL'] ??
  'postgresql://taskflow_app:app-dev-secret@localhost:5433/taskflow_test';
const PLATFORM_ADMIN_URL =
  process.env['TEST_DATABASE_PLATFORM_ADMIN_URL'] ??
  'postgresql://taskflow_platform_admin:platform-admin-dev-secret@localhost:5433/taskflow_test';
const MIGRATION_URL =
  process.env['TEST_DATABASE_MIGRATION_URL'] ??
  'postgresql://taskflow_migrator:migrator-dev-secret@localhost:5433/taskflow_test';

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/* `0195ee0b`, not `0195ee00` — this file's own prefix used to collide with
   `apps/work/work.service.test.ts`'s `OWNER` (both `...00000001`). turbo
   runs the `packages/db` and `apps/api` test tasks in parallel against the
   SAME `taskflow_test`, and this file's `cleanup()` unconditionally deletes
   `identity.users` for this id — so whichever file's `beforeAll` lost the
   race found its fixture user gone, or present with no `email_verified_at`,
   moments after setting it. That surfaced as `work.service.test.ts`'s
   `createOrg` calls failing with "verify your email", intermittently, in CI
   only — the two suites never run concurrently on a single-package local
   run. Real UUIDs, not the shared literal family the rest of this file's
   neighbours draw from, is what makes a second collision here structurally
   unlikely rather than merely lucky. */
const OPERATOR = '0195ee0b-0000-7000-8000-000000000001';
const ORG_A = '0195ee0b-0000-7000-8000-00000000000a' as OrgId;

/** SQLSTATE for "permission denied". */
const INSUFFICIENT_PRIVILEGE = '42501';

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

let admin: pg.Client;

async function cleanup(): Promise<void> {
  await admin.query(`SELECT set_config('app.org_id', '', false)`);
  await admin.query(`DELETE FROM platform.operator_audit_log`);
  await admin.query(`DELETE FROM platform.operator_chain_head`);
  await admin.query(`DELETE FROM platform.operators`);
  await admin.query(`DELETE FROM platform.flag_overrides`);
  await admin.query(`SELECT set_config('app.org_id', $1, false)`, [ORG_A]);
  await admin.query(`DELETE FROM identity.memberships WHERE org_id = $1`, [ORG_A]);
  await admin.query(`DELETE FROM identity.orgs WHERE id = $1`, [ORG_A]);
  await admin.query(`SELECT set_config('app.org_id', '', false)`);
  await admin.query(`DELETE FROM identity.users WHERE id = $1`, [OPERATOR]);
}

beforeAll(async () => {
  await up({ migrationUrl: MIGRATION_URL, migrationsDir: MIGRATIONS_DIR });

  admin = new pg.Client({ connectionString: MIGRATION_URL });
  await admin.connect();
  await cleanup();

  await admin.query(
    `INSERT INTO identity.users (id, email, email_normalized, email_verified_at)
     VALUES ($1, 'operator@example.test', 'operator@example.test', now())`,
    [OPERATOR],
  );
  await admin.query(`SELECT set_config('app.org_id', $1, false)`, [ORG_A]);
  await admin.query(
    `INSERT INTO identity.orgs (id, name, slug) VALUES ($1, 'Platform Org', 'platform-admin-org')`,
    [ORG_A],
  );
  await admin.query(`SELECT set_config('app.org_id', '', false)`);

  initializeDatabase({ url: APP_URL, applicationName: 'taskflow-platform-admin-test' });
  initializePlatformAdminDatabase({
    url: PLATFORM_ADMIN_URL,
    applicationName: 'taskflow-platform-admin-test-writer',
  });
});

afterAll(async () => {
  await closeDatabase();
  await cleanup();
  await admin.end();
});

beforeEach(async () => {
  await admin.query(`SELECT set_config('app.org_id', '', false)`);
  await admin.query(`DELETE FROM platform.operator_audit_log`);
  await admin.query(`DELETE FROM platform.operator_chain_head`);
  await admin.query(`DELETE FROM platform.operators`);
  await admin.query(`DELETE FROM platform.flag_overrides`);
});

describe('platform.operators — the one grant with no code-level fallback', () => {
  it('refuses an INSERT from the application role', async () => {
    const thrown: unknown = await withOrgScope(ORG_A, async (tx) =>
      tx.execute(sql`
        INSERT INTO platform.operators (user_id, granted_by, note)
        VALUES (${OPERATOR}::uuid, ${OPERATOR}::uuid, 'self-granted')
      `),
    ).catch((error: unknown) => error);

    expect(pgErrorCode(thrown)).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('refuses an INSERT from the platform-admin role too — nothing reachable writes this table', async () => {
    // §3.1: the strictest grant in the system. Not even the console's own
    // role may write it — only taskflow_migrator, via a bootstrap script.
    const thrown: unknown = await withPlatformAdminScope(async (tx) =>
      tx.execute(sql`
        INSERT INTO platform.operators (user_id, granted_by, note)
        VALUES (${OPERATOR}::uuid, ${OPERATOR}::uuid, 'self-granted')
      `),
    ).catch((error: unknown) => error);

    expect(pgErrorCode(thrown)).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('lets the application role SELECT, so isPlatformOperator can answer', async () => {
    await admin.query(
      `INSERT INTO platform.operators (user_id, granted_by, note) VALUES ($1, $1, 'seeded for test')`,
      [OPERATOR],
    );

    const rows = await withOrgScope(ORG_A, async (tx) =>
      tx.execute(sql`SELECT user_id FROM platform.operators WHERE user_id = ${OPERATOR}::uuid`),
    );
    expect(rows.rows).toHaveLength(1);
  });
});

describe('platform.flag_overrides — writable only through taskflow_platform_admin', () => {
  it('refuses a write from the application role', async () => {
    const thrown: unknown = await withOrgScope(ORG_A, async (tx) =>
      tx.execute(sql`
        INSERT INTO platform.flag_overrides (flag_name, value, set_by)
        VALUES ('chat', true, ${OPERATOR}::uuid)
      `),
    ).catch((error: unknown) => error);

    expect(pgErrorCode(thrown)).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('lets taskflow_platform_admin set and clear an override, visible to taskflow_app', async () => {
    await withPlatformAdminScope(async (tx) =>
      tx.execute(sql`
        INSERT INTO platform.flag_overrides (flag_name, value, set_by)
        VALUES ('chat', true, ${OPERATOR}::uuid)
      `),
    );

    const seen = await withOrgScope(ORG_A, async (tx) =>
      tx.execute(sql`SELECT value FROM platform.flag_overrides WHERE flag_name = 'chat'`),
    );
    expect(seen.rows).toEqual([{ value: true }]);

    await withPlatformAdminScope(async (tx) =>
      tx.execute(sql`DELETE FROM platform.flag_overrides WHERE flag_name = 'chat'`),
    );
    const cleared = await withOrgScope(ORG_A, async (tx) =>
      tx.execute(
        sql`SELECT count(*)::int AS n FROM platform.flag_overrides WHERE flag_name = 'chat'`,
      ),
    );
    expect(cleared.rows).toEqual([{ n: 0 }]);
  });
});

describe('identity.orgs — taskflow_platform_admin’s reach (§3.7)', () => {
  it('sees a real org with NO session variables set — the failure withGlobalScope would hide', async () => {
    const rows = await withPlatformAdminScope(async (tx) =>
      tx.execute(sql`SELECT id, status FROM identity.orgs WHERE id = ${ORG_A}::uuid`),
    );
    expect(rows.rows).toEqual([{ id: ORG_A, status: 'active' }]);
  });

  it('can update status', async () => {
    await withPlatformAdminScope(async (tx) =>
      tx.execute(sql`UPDATE identity.orgs SET status = 'suspended' WHERE id = ${ORG_A}::uuid`),
    );

    const rows = await withPlatformAdminScope(async (tx) =>
      tx.execute(sql`SELECT status FROM identity.orgs WHERE id = ${ORG_A}::uuid`),
    );
    expect(rows.rows).toEqual([{ status: 'suspended' }]);

    // Restore for the next test.
    await withPlatformAdminScope(async (tx) =>
      tx.execute(sql`UPDATE identity.orgs SET status = 'active' WHERE id = ${ORG_A}::uuid`),
    );
  });

  it('remains invisible to the ordinary application role with no scope set', async () => {
    const rows = await withOrgScope(
      // A DIFFERENT org than the one seeded — proves this is RLS refusing an
      // unrelated tenant, not a coincidental empty result.
      '0195ee0b-0000-7000-8000-0000000000ff' as OrgId,
      async (tx) =>
        tx.execute(sql`SELECT count(*)::int AS n FROM identity.orgs WHERE id = ${ORG_A}::uuid`),
    );
    expect(rows.rows).toEqual([{ n: 0 }]);
  });
});

describe('the operator audit chain (§4)', () => {
  it('assigns seq and hash in the trigger, chaining prev_hash to the prior entry', async () => {
    await appendOperatorAuditEntry({ operatorId: OPERATOR, action: 'orgs.list', target: null });
    await appendOperatorAuditEntry({
      operatorId: OPERATOR,
      action: 'orgs.suspend',
      target: { orgId: ORG_A },
    });

    const chain = await readOperatorChain();
    expect(chain).toHaveLength(2);

    const [first, second] = chain;
    if (!first || !second) throw new Error('expected two chain entries');

    expect(first.seq).toBe('1');
    expect(second.seq).toBe('2');
    expect(first.prevHash).toBeNull();
    expect(second.prevHash?.toString('hex')).toBe(first.hash.toString('hex'));
    // The placeholder ('' cast to bytea) is gone — a real digest is 32 bytes.
    expect(first.hash).toHaveLength(32);
    expect(first.target).toBeNull();
    expect(second.target).toBe('{"orgId": "' + ORG_A + '"}');
  });

  it('serializes concurrent writers into one unbroken chain — one global lock, not per-org', async () => {
    await Promise.all(
      Array.from({ length: 8 }, async (_unused, index) =>
        appendOperatorAuditEntry({
          operatorId: OPERATOR,
          action: `orgs.list.${String(index)}`,
          target: null,
        }),
      ),
    );

    const chain = await readOperatorChain();
    expect(chain.map((entry) => entry.seq)).toEqual(
      Array.from({ length: 8 }, (_unused, index) => String(index + 1)),
    );

    for (let i = 1; i < chain.length; i += 1) {
      const current = chain[i];
      const previous = chain[i - 1];
      if (!current || !previous) throw new Error('expected a contiguous chain');
      expect(current.prevHash?.toString('hex')).toBe(previous.hash.toString('hex'));
    }
  });

  it('refuses a write from the application role', async () => {
    const thrown: unknown = await withOrgScope(ORG_A, async (tx) =>
      tx.execute(sql`
        INSERT INTO platform.operator_audit_log (operator_id, action, hash)
        VALUES (${OPERATOR}::uuid, 'forged', ''::bytea)
      `),
    ).catch((error: unknown) => error);

    expect(pgErrorCode(thrown)).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('refuses a read from the application role — the accountability log is not org-scoped data', async () => {
    await appendOperatorAuditEntry({ operatorId: OPERATOR, action: 'orgs.list', target: null });

    const thrown: unknown = await withOrgScope(ORG_A, async (tx) =>
      tx.execute(sql`SELECT count(*) FROM platform.operator_audit_log`),
    ).catch((error: unknown) => error);

    expect(pgErrorCode(thrown)).toBe(INSUFFICIENT_PRIVILEGE);
  });
});
