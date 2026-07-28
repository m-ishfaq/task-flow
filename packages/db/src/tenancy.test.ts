import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { sql } from 'drizzle-orm';
import { RELATIONS, RESOURCE_TYPES, ROLES } from '@taskflow/policy';
import {
  closeDatabase,
  initializeDatabase,
  withGlobalScope,
  withOrgScope,
  withUserScope,
  type OrgId,
  type UserId,
} from './client.js';
import { up } from './migrate/runner.js';

/**
 * Tenancy isolation on the real tables (PLAN.md §8.3, migrations 0004 & 0005).
 *
 * client.test.ts proves the RLS MECHANISM against a throwaway probe table. This
 * file proves the actual tenancy schema — including the two places where this
 * migration deliberately departs from the standard policy, which are exactly
 * the places a mistake would be invisible:
 *
 *   - `identity.orgs` filters on `id`, not `org_id`.
 *   - `identity.memberships` and `identity.orgs` each carry a second,
 *     SELECT-only policy keyed on `app.user_id`, so the org switcher can read
 *     across orgs.
 *
 * The second one is the dangerous one, and the test that matters most here is
 * `refuses to write a membership in user scope`: if that policy were ever
 * widened from FOR SELECT to FOR ALL, any authenticated caller could admit
 * themselves to any organization. Nothing else in the system would notice.
 *
 * Runs against real Postgres — `docker compose up -d`.
 */

const APP_URL =
  process.env['DATABASE_URL'] ?? 'postgresql://taskflow_app:app-dev-secret@localhost:5432/taskflow';
const MIGRATION_URL =
  process.env['DATABASE_MIGRATION_URL'] ??
  'postgresql://taskflow_migrator:migrator-dev-secret@localhost:5432/taskflow';

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/* Fixed ids: a failing run should be reproducible, and these rows are torn down
   by id rather than by truncating tables another test may be using. */
const ORG_A = '0195aa00-0000-7000-8000-00000000000a' as OrgId;
const ORG_B = '0195aa00-0000-7000-8000-00000000000b' as OrgId;

/** In both orgs — the case the org switcher exists for. */
const USER_BOTH = '0195aa00-0000-7000-8000-000000000001' as UserId;
/** In org A only. */
const USER_A = '0195aa00-0000-7000-8000-000000000002' as UserId;
/** In no org at all: signed up, joined nothing. */
const USER_NONE = '0195aa00-0000-7000-8000-000000000003' as UserId;

const TEAM_A = '0195aa00-0000-7000-8000-0000000000a1';
const TUPLE_A = '0195aa00-0000-7000-8000-0000000000c1';

const ORG_IDS = [ORG_A, ORG_B];
const USER_IDS = [USER_BOTH, USER_A, USER_NONE];

/** SQLSTATE for "new row violates row-level security policy". */
const RLS_VIOLATION = '42501';
/** SQLSTATE for a foreign key violation. */
const FK_VIOLATION = '23503';
/** SQLSTATE for a CHECK constraint violation. */
const CHECK_VIOLATION = '23514';

/** Walks the `cause` chain for a Postgres SQLSTATE. See client.test.ts. */
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

/** Seeds as the migrator, which is subject to FORCE RLS like every other role. */
async function seedScoped(orgId: OrgId, statements: readonly [string, unknown[]][]): Promise<void> {
  await admin.query(`SELECT set_config('app.org_id', $1, false)`, [orgId]);
  await admin.query(`SELECT set_config('app.user_id', '', false)`);
  for (const [text, values] of statements) {
    await admin.query(text, values);
  }
}

async function cleanup(): Promise<void> {
  // Unscoped deletes would silently affect zero rows under FORCE RLS, so each
  // org's rows are removed inside that org's scope. Users are last: they are
  // not tenant-scoped, and the memberships referencing them cascade.
  for (const orgId of ORG_IDS) {
    await admin.query(`SELECT set_config('app.org_id', $1, false)`, [orgId]);
    await admin.query(`DELETE FROM authz.relationship_tuples WHERE org_id = $1`, [orgId]);
    await admin.query(`DELETE FROM identity.team_members WHERE org_id = $1`, [orgId]);
    await admin.query(`DELETE FROM identity.teams WHERE org_id = $1`, [orgId]);
    await admin.query(`DELETE FROM identity.memberships WHERE org_id = $1`, [orgId]);
    await admin.query(`DELETE FROM identity.orgs WHERE id = $1`, [orgId]);
  }
  await admin.query(`SELECT set_config('app.org_id', '', false)`);
  await admin.query(`DELETE FROM identity.users WHERE id = ANY($1::uuid[])`, [USER_IDS]);
}

beforeAll(async () => {
  await up({ migrationUrl: MIGRATION_URL, migrationsDir: MIGRATIONS_DIR });

  admin = new pg.Client({ connectionString: MIGRATION_URL });
  await admin.connect();
  await cleanup();

  // Users are not tenant-scoped (see migration 0002) so they insert unscoped.
  for (const [index, userId] of USER_IDS.entries()) {
    await admin.query(
      `INSERT INTO identity.users (id, email, email_normalized, email_verified_at)
       VALUES ($1, $2, $2, now())`,
      [userId, `tenancy-${String(index)}@example.test`],
    );
  }

  await seedScoped(ORG_A, [
    [`INSERT INTO identity.orgs (id, name, slug) VALUES ($1, 'Org A', 'tenancy-org-a')`, [ORG_A]],
    [
      `INSERT INTO identity.memberships (id, org_id, user_id, role)
       VALUES (gen_random_uuid(), $1, $2, 'owner')`,
      [ORG_A, USER_BOTH],
    ],
    [
      `INSERT INTO identity.memberships (id, org_id, user_id, role)
       VALUES (gen_random_uuid(), $1, $2, 'member')`,
      [ORG_A, USER_A],
    ],
    [
      `INSERT INTO identity.teams (id, org_id, name, slug) VALUES ($1, $2, 'Platform', 'platform')`,
      [TEAM_A, ORG_A],
    ],
    [
      `INSERT INTO identity.team_members (org_id, team_id, user_id) VALUES ($1, $2, $3)`,
      [ORG_A, TEAM_A, USER_A],
    ],
    [
      `INSERT INTO authz.relationship_tuples
         (id, org_id, subject_type, subject_id, relation, object_type, object_id)
       VALUES ($1, $2, 'team', $3, 'editor', 'board', $4)`,
      [TUPLE_A, ORG_A, TEAM_A, '0195aa00-0000-7000-8000-0000000000b1'],
    ],
  ]);

  await seedScoped(ORG_B, [
    [`INSERT INTO identity.orgs (id, name, slug) VALUES ($1, 'Org B', 'tenancy-org-b')`, [ORG_B]],
    [
      `INSERT INTO identity.memberships (id, org_id, user_id, role)
       VALUES (gen_random_uuid(), $1, $2, 'admin')`,
      [ORG_B, USER_BOTH],
    ],
  ]);

  initializeDatabase({ url: APP_URL, applicationName: 'taskflow-tenancy-test' });
});

afterAll(async () => {
  await closeDatabase();
  await cleanup();
  await admin.end();
});

describe('org scope', () => {
  it('sees only its own org row, filtering on id rather than org_id', async () => {
    // identity.orgs is the one table whose tenant column is the primary key.
    const a = await withOrgScope(ORG_A, async (tx) =>
      tx.execute(sql`SELECT slug FROM identity.orgs`),
    );
    expect(a.rows).toEqual([{ slug: 'tenancy-org-a' }]);

    const b = await withOrgScope(ORG_B, async (tx) =>
      tx.execute(sql`SELECT slug FROM identity.orgs`),
    );
    expect(b.rows).toEqual([{ slug: 'tenancy-org-b' }]);
  });

  it('sees only its own memberships', async () => {
    const rows = await withOrgScope(ORG_A, async (tx) =>
      tx.execute(sql`SELECT role FROM identity.memberships ORDER BY role`),
    );
    expect(rows.rows).toEqual([{ role: 'member' }, { role: 'owner' }]);
  });

  it('cannot read a membership from another org by user id', async () => {
    // USER_BOTH is an admin in org B. Asking about them from org A must not
    // reveal that, or "is this person an admin somewhere?" leaks across tenants.
    const rows = await withOrgScope(ORG_A, async (tx) =>
      tx.execute(sql`SELECT role FROM identity.memberships WHERE user_id = ${USER_BOTH}`),
    );
    expect(rows.rows).toEqual([{ role: 'owner' }]);
  });

  it('cannot escalate a role in another org', async () => {
    const result = await withOrgScope(ORG_A, async (tx) =>
      tx.execute(sql`UPDATE identity.memberships SET role = 'owner' WHERE user_id = ${USER_BOTH}
                     AND org_id = ${ORG_B}`),
    );
    expect(result.rowCount).toBe(0);

    const check = await withOrgScope(ORG_B, async (tx) =>
      tx.execute(sql`SELECT role FROM identity.memberships WHERE user_id = ${USER_BOTH}`),
    );
    expect(check.rows).toEqual([{ role: 'admin' }]);
  });

  it('refuses to write a membership stamped with another org', async () => {
    const thrown: unknown = await withOrgScope(ORG_A, async (tx) =>
      tx.execute(sql`INSERT INTO identity.memberships (id, org_id, user_id, role)
                     VALUES (gen_random_uuid(), ${ORG_B}, ${USER_NONE}, 'owner')`),
    ).catch((error: unknown) => error);

    expect(pgErrorCode(thrown)).toBe(RLS_VIOLATION);
  });

  it('sees only its own relationship tuples', async () => {
    const a = await withOrgScope(ORG_A, async (tx) =>
      tx.execute(sql`SELECT relation FROM authz.relationship_tuples`),
    );
    expect(a.rows).toEqual([{ relation: 'editor' }]);

    const b = await withOrgScope(ORG_B, async (tx) =>
      tx.execute(sql`SELECT relation FROM authz.relationship_tuples`),
    );
    expect(b.rows).toEqual([]);
  });
});

describe('creating an organization', () => {
  const NEW_ORG = '0195aa00-0000-7000-8000-0000000000cc' as OrgId;

  it('works inside a scope named for the org being created', async () => {
    // The chicken-and-egg that isn't. WITH CHECK requires id = app.org_id, and
    // the id is generated application-side (UUIDv7, §7.1) — so the service
    // mints it, scopes to it, and inserts the org and its owner membership in
    // one transaction. No privileged path, no escape hatch to reach for later.
    await withOrgScope(NEW_ORG, async (tx) => {
      await tx.execute(
        sql`INSERT INTO identity.orgs (id, name, slug) VALUES (${NEW_ORG}, 'New', 'tenancy-new')`,
      );
      return tx.execute(sql`INSERT INTO identity.memberships (id, org_id, user_id, role)
                            VALUES (gen_random_uuid(), ${NEW_ORG}, ${USER_NONE}, 'owner')`);
    });

    const rows = await withOrgScope(NEW_ORG, async (tx) =>
      tx.execute(sql`SELECT slug FROM identity.orgs`),
    );
    expect(rows.rows).toEqual([{ slug: 'tenancy-new' }]);

    await admin.query(`SELECT set_config('app.org_id', $1, false)`, [NEW_ORG]);
    await admin.query(`DELETE FROM identity.memberships WHERE org_id = $1`, [NEW_ORG]);
    await admin.query(`DELETE FROM identity.orgs WHERE id = $1`, [NEW_ORG]);
  });

  it('refuses to create an org under a different scope', async () => {
    const thrown: unknown = await withOrgScope(ORG_A, async (tx) =>
      tx.execute(
        sql`INSERT INTO identity.orgs (id, name, slug) VALUES (${NEW_ORG}, 'Sneaky', 'tenancy-sneaky')`,
      ),
    ).catch((error: unknown) => error);

    expect(pgErrorCode(thrown)).toBe(RLS_VIOLATION);
  });
});

describe('user scope', () => {
  it('lists every org the user belongs to', async () => {
    // The question no value of app.org_id can answer, and the only reason
    // app.user_id exists.
    const rows = await withUserScope(USER_BOTH, async (tx) =>
      tx.execute(sql`SELECT slug FROM identity.orgs ORDER BY slug`),
    );
    expect(rows.rows).toEqual([{ slug: 'tenancy-org-a' }, { slug: 'tenancy-org-b' }]);
  });

  it('lists only the caller’s own memberships, not their colleagues’', async () => {
    const rows = await withUserScope(USER_BOTH, async (tx) =>
      tx.execute(sql`SELECT role FROM identity.memberships ORDER BY role`),
    );
    expect(rows.rows).toEqual([{ role: 'admin' }, { role: 'owner' }]);

    // USER_A is a member of org A alongside USER_BOTH and must not appear.
    const solo = await withUserScope(USER_A, async (tx) =>
      tx.execute(sql`SELECT count(*)::int AS n FROM identity.memberships`),
    );
    expect(solo.rows).toEqual([{ n: 1 }]);
  });

  it('shows a user with no membership nothing at all', async () => {
    const rows = await withUserScope(USER_NONE, async (tx) =>
      tx.execute(sql`SELECT count(*)::int AS n FROM identity.orgs`),
    );
    expect(rows.rows).toEqual([{ n: 0 }]);
  });

  it('refuses to write a membership in user scope', async () => {
    /* THE test in this file.
     *
     * The self-read policies are FOR SELECT precisely so this fails. Were they
     * ever written FOR ALL — or were a WITH CHECK added "for symmetry" — this
     * INSERT would succeed and any authenticated caller could admit themselves
     * to any organization, as an owner, with nothing else in the system
     * noticing. The tenant policy cannot save it either: app.org_id is empty in
     * user scope, so its WITH CHECK is NULL rather than true. */
    const thrown: unknown = await withUserScope(USER_NONE, async (tx) =>
      tx.execute(sql`INSERT INTO identity.memberships (id, org_id, user_id, role)
                     VALUES (gen_random_uuid(), ${ORG_A}, ${USER_NONE}, 'owner')`),
    ).catch((error: unknown) => error);

    expect(pgErrorCode(thrown)).toBe(RLS_VIOLATION);

    const check = await withOrgScope(ORG_A, async (tx) =>
      tx.execute(
        sql`SELECT count(*)::int AS n FROM identity.memberships WHERE user_id = ${USER_NONE}`,
      ),
    );
    expect(check.rows).toEqual([{ n: 0 }]);
  });

  it('cannot promote itself by updating its own membership', async () => {
    // A read policy grants no write. USER_A is a member in org A; an UPDATE in
    // user scope must match zero rows rather than silently succeeding.
    const result = await withUserScope(USER_A, async (tx) =>
      tx.execute(sql`UPDATE identity.memberships SET role = 'owner' WHERE user_id = ${USER_A}`),
    );
    expect(result.rowCount).toBe(0);

    const check = await withOrgScope(ORG_A, async (tx) =>
      tx.execute(sql`SELECT role FROM identity.memberships WHERE user_id = ${USER_A}`),
    );
    expect(check.rows).toEqual([{ role: 'member' }]);
  });

  it('reaches no tenant table other than orgs and memberships', async () => {
    // app.user_id widens exactly two policies. Everything else still filters on
    // app.org_id, which user scope clears — so these are ordinary zero-row
    // results, the same as an unscoped query.
    const rows = await withUserScope(USER_A, async (tx) =>
      tx.execute(sql`SELECT
          (SELECT count(*)::int FROM identity.teams)               AS teams,
          (SELECT count(*)::int FROM identity.team_members)        AS team_members,
          (SELECT count(*)::int FROM authz.relationship_tuples)    AS tuples`),
    );
    expect(rows.rows).toEqual([{ teams: 0, team_members: 0, tuples: 0 }]);
  });
});

describe('scope isolation on a pooled connection', () => {
  it('does not let a user scope widen a later org scope', async () => {
    /* Permissive policies are OR'ed. If app.user_id survived from an earlier
       transaction on the same pooled connection, org A's scope would also see
       USER_BOTH's org B membership — a cross-tenant read produced by nothing
       more than connection reuse. Both scopes set BOTH variables for this
       reason. */
    await withUserScope(USER_BOTH, async (tx) => tx.execute(sql`SELECT slug FROM identity.orgs`));

    const rows = await withOrgScope(ORG_A, async (tx) =>
      tx.execute(sql`SELECT slug FROM identity.orgs`),
    );
    expect(rows.rows).toEqual([{ slug: 'tenancy-org-a' }]);
  });

  it('does not let an org scope leak into a later user scope', async () => {
    await withOrgScope(ORG_A, async (tx) => tx.execute(sql`SELECT slug FROM identity.orgs`));

    const rows = await withUserScope(USER_NONE, async (tx) =>
      tx.execute(sql`SELECT count(*)::int AS n FROM identity.orgs`),
    );
    expect(rows.rows).toEqual([{ n: 0 }]);
  });

  it('leaves global scope seeing nothing', async () => {
    await withUserScope(USER_BOTH, async (tx) => tx.execute(sql`SELECT slug FROM identity.orgs`));

    const rows = await withGlobalScope(async (tx) =>
      tx.execute(sql`SELECT count(*)::int AS n FROM identity.orgs`),
    );
    expect(rows.rows).toEqual([{ n: 0 }]);
  });
});

describe('cross-org integrity', () => {
  it('refuses a team_members row whose org_id and team_id disagree', async () => {
    /* team_members carries a denormalized org_id so RLS can filter on a column
       of its own table. The composite foreign key is what stops the copy from
       lying: without it, a row could claim org B while pointing at org A's
       team, and RLS would show it to org B. */
    const thrown: unknown = await withOrgScope(ORG_B, async (tx) =>
      tx.execute(sql`INSERT INTO identity.team_members (org_id, team_id, user_id)
                     VALUES (${ORG_B}, ${TEAM_A}, ${USER_BOTH})`),
    ).catch((error: unknown) => error);

    expect(pgErrorCode(thrown)).toBe(FK_VIOLATION);
  });

  it('rejects a role outside the catalog', async () => {
    const thrown: unknown = await withOrgScope(ORG_A, async (tx) =>
      tx.execute(sql`INSERT INTO identity.memberships (id, org_id, user_id, role)
                     VALUES (gen_random_uuid(), ${ORG_A}, ${USER_NONE}, 'superadmin')`),
    ).catch((error: unknown) => error);

    expect(pgErrorCode(thrown)).toBe(CHECK_VIOLATION);
  });

  it('rejects a relation outside the catalog', async () => {
    const thrown: unknown = await withOrgScope(ORG_A, async (tx) =>
      tx.execute(sql`INSERT INTO authz.relationship_tuples
                       (id, org_id, subject_type, subject_id, relation, object_type, object_id)
                     VALUES (gen_random_uuid(), ${ORG_A}, 'user', ${USER_A}, 'admin', 'board',
                             ${'0195aa00-0000-7000-8000-0000000000b2'})`),
    ).catch((error: unknown) => error);

    expect(pgErrorCode(thrown)).toBe(CHECK_VIOLATION);
  });
});

/**
 * The CHECK constraints above are a second copy of lists that live in
 * packages/policy. A value the engine has never heard of grants nothing (see
 * decide.ts), so drift fails SAFE — and silently, which is why it is worth a
 * test rather than a comment.
 *
 * Asserted in this direction on purpose: the database must accept everything
 * the policy engine can produce. The reverse (the database accepting only what
 * the engine knows) is checked too, since a value storable but unrecognized
 * would deny at runtime with no indication why.
 */
describe('schema mirrors the policy catalog', () => {
  async function checkValues(table: string, constraint: string): Promise<Set<string>> {
    const { rows } = await admin.query<{ def: string }>(
      `SELECT pg_get_constraintdef(c.oid) AS def
         FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid
        WHERE t.relname = $1 AND c.conname = $2`,
      [table, constraint],
    );
    const def = rows[0]?.def ?? '';
    return new Set(
      [...def.matchAll(/'([^']+)'::text/g)]
        .map((match) => match[1])
        .filter((value): value is string => value !== undefined),
    );
  }

  it('accepts exactly the roles in @taskflow/policy', async () => {
    const stored = await checkValues('memberships', 'memberships_role_valid');
    expect([...stored].sort()).toEqual([...ROLES].sort());
  });

  it('accepts exactly the relations in @taskflow/policy', async () => {
    const stored = await checkValues('relationship_tuples', 'tuples_relation_valid');
    expect([...stored].sort()).toEqual([...RELATIONS].sort());
  });

  it('accepts exactly the resource types in @taskflow/policy', async () => {
    const stored = await checkValues('relationship_tuples', 'tuples_object_type_valid');
    expect([...stored].sort()).toEqual([...RESOURCE_TYPES].sort());
  });
});
