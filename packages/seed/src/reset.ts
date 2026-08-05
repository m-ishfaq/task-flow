import type { AdminConnection } from '@taskflow/db/testing';
import { SEED_EMAIL_DOMAIN } from './modules/identity.users.js';
import { resolveModules, tablesInTeardownOrder, type SeedModule } from './registry.js';

/**
 * `pnpm seed --reset` — removes what a previous run created, and nothing else.
 *
 * CLAUDE.md is explicit that this must be surgical, never `TRUNCATE`: a
 * developer's own account and the org they are working in have to survive a
 * re-seed. So the scope is derived from two markers this package controls —
 * never from "every row in these tables" — and both are checked before a
 * single DELETE runs:
 *
 *   - Users: `email_normalized` ending in `SEED_EMAIL_DOMAIN`
 *     (`taskflow.seed.test`, RFC 2606-reserved — no seeded address can ever
 *     be a real mailbox).
 *   - Orgs: every organization one of those users belongs to. Safe because
 *     `tenancy.orgs` only ever adds SEEDED users to a SEEDED org — a real
 *     developer account is never a member of one, short of someone manually
 *     inviting themselves into Acme, which is not a case this guards against.
 *
 * Discovery is the interesting part. `identity.users` carries no `org_id` and
 * is readable directly, but every other table here is RLS-protected and
 * `taskflow_migrator` is `NOBYPASSRLS` like everything else (CLAUDE.md) — so
 * there is no `SELECT * FROM identity.orgs` that lists every tenant. The path
 * that exists is `orgs_self_read` (migration 0004): with `app.user_id` set
 * and `app.org_id` cleared, it answers "which orgs is THIS user in" for
 * exactly the reason the org switcher needs it. Walking it once per seeded
 * user is what turns a list of users into a list of orgs.
 *
 * The audit log is deliberately left alone. `audit.audit_log` and
 * `audit.chain_heads` grant no role DELETE — not even the table owner, since
 * both carry `FORCE ROW LEVEL SECURITY` with policies scoped `TO
 * taskflow_audit` only (migration 0007) — and that is not an oversight this
 * function works around. An audit trail a reset could edit would not be one.
 */

export interface ResetOptions {
  readonly connection: AdminConnection;
  /** The same roots a normal run would seed — reset only needs their tables. */
  readonly roots: readonly SeedModule[];
  readonly log: (message: string) => void;
}

export interface ResetResult {
  readonly orgsRemoved: number;
  readonly usersRemoved: number;
}

export async function reset(options: ResetOptions): Promise<ResetResult> {
  const { connection, roots, log } = options;

  const userIds = await findSeededUserIds(connection);
  if (userIds.length === 0) {
    log('reset: no seeded users found — nothing to remove.');
    return { orgsRemoved: 0, usersRemoved: 0 };
  }

  const orgIds = await findSeededOrgIds(connection, userIds);
  log(
    `reset: found ${String(orgIds.length)} seeded org(s), ${String(userIds.length)} seeded user(s)`,
  );

  const tables = tablesInTeardownOrder(resolveModules(roots)).filter(
    (table) => table !== 'identity.users',
  );

  for (const orgId of orgIds) {
    await connection.setOrg(orgId);
    for (const table of tables) {
      if (table === 'identity.orgs') {
        await connection.query('DELETE FROM identity.orgs WHERE id = $1', [orgId]);
      } else {
        await connection.query(`DELETE FROM ${table} WHERE org_id = $1`, [orgId]);
      }
    }
  }
  await connection.setOrg(null);

  /* Users last, and unscoped — `identity.users` carries no `org_id` (it is
     the one global table, CLAUDE.md). By this point every membership row
     that referenced them is gone, so the foreign key from
     `identity.memberships` no longer holds them in place. */
  await connection.query('DELETE FROM identity.users WHERE id = ANY($1::uuid[])', [userIds]);

  log(`reset: removed ${String(orgIds.length)} org(s) and ${String(userIds.length)} user(s)`);
  return { orgsRemoved: orgIds.length, usersRemoved: userIds.length };
}

async function findSeededUserIds(connection: AdminConnection): Promise<readonly string[]> {
  // identity.users has no tenant RLS, so no scope is needed — but clearing it
  // anyway costs nothing and documents that this read is deliberately global.
  await connection.setOrg(null);
  const result = await connection.query(
    `SELECT id FROM identity.users WHERE email_normalized LIKE '%@' || $1`,
    [SEED_EMAIL_DOMAIN],
  );
  return result.rows.map((row) => String(row['id']));
}

async function findSeededOrgIds(
  connection: AdminConnection,
  userIds: readonly string[],
): Promise<readonly string[]> {
  const orgIds = new Set<string>();

  for (const userId of userIds) {
    // `orgs_self_read` — the one policy answering "which orgs is this user
    // in" with no `app.org_id` set. `setOrg` always clears `app.user_id`
    // (testing/index.ts), so it is set directly here instead.
    await connection.query(`SELECT set_config('app.org_id', '', false)`);
    await connection.query(`SELECT set_config('app.user_id', $1, false)`, [userId]);

    const result = await connection.query('SELECT id FROM identity.orgs');
    for (const row of result.rows) orgIds.add(String(row['id']));
  }

  await connection.setOrg(null);
  return [...orgIds];
}
