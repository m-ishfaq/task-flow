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
 *     (`rinavai.seed.test`, RFC 2606-reserved — no seeded address can ever
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
 *
 * `docs.pages` and `docs.page_versions` are one case "children before
 * parents" cannot express, and it is not a gap in `tablesInTeardownOrder` —
 * it is a genuine cycle. Migration 0026's `pages_published_version_fk` makes
 * `docs.pages` reference `docs.page_versions` (a published page points at
 * its snapshot) at the same time `page_versions_page_fk` makes
 * `docs.page_versions` reference `docs.pages` (a version belongs to its
 * page, `ON DELETE CASCADE`) — two tables each depending on the other, which
 * no linear reversed-run-order can resolve, however the module graph is
 * declared. `published_version_id`/`published_at` are nulled out per org
 * BEFORE the generic per-table loop below runs, breaking the cycle exactly
 * the way `wave4.service.test.ts`'s and `tenancy-seed.ts`'s own teardowns
 * already had to — see either file's comment on the identical foreign key
 * refusing the delete in the other order.
 */

export interface ResetOptions {
  readonly connection: AdminConnection;
  /** The same roots a normal run would seed — reset only needs their tables. */
  readonly roots: readonly SeedModule[];
  /**
   * The CURRENTLY configured `SEED_PLATFORM_ADMIN_EMAIL`, or null/undefined
   * when unset. The platform operator's address no longer necessarily ends
   * in `SEED_EMAIL_DOMAIN` (`context.ts`'s `PlatformOperatorSeedConfig`), so
   * the domain-suffix match below cannot find it — this is the second,
   * narrower marker that can. Only the email THIS run is configured with,
   * deliberately: a run with no operator email at all matches nothing extra,
   * which is the safe default for a file whose entire job is to never touch
   * a row it cannot positively identify as its own.
   */
  readonly platformOperatorEmail?: string | null;
  readonly log: (message: string) => void;
}

export interface ResetResult {
  readonly orgsRemoved: number;
  readonly usersRemoved: number;
}

export async function reset(options: ResetOptions): Promise<ResetResult> {
  const { connection, roots, log } = options;

  const userIds = await findSeededUserIds(connection, options.platformOperatorEmail ?? null);
  if (userIds.length === 0) {
    log('reset: no seeded users found — nothing to remove.');
    return { orgsRemoved: 0, usersRemoved: 0 };
  }

  const orgIds = await findSeededOrgIds(connection, userIds);
  log(
    `reset: found ${String(orgIds.length)} seeded org(s), ${String(userIds.length)} seeded user(s)`,
  );

  /**
   * The tables here with no `org_id`, so none can go through the per-org loop
   * below — it would ask Postgres to filter on a column that does not exist,
   * and `people.profiles` did exactly that: `--reset` died with `column
   * "org_id" does not exist` from the moment `people.profiles` joined a
   * module's `tables`, while a plain `pnpm seed` kept working, so the break
   * only surfaced for whoever reached for the flag.
   *
   * Four tables, two cleanup paths:
   *
   *   - `identity.users` and `people.profiles` are removed by the unscoped
   *     DELETE at the end (`profiles_user_id_fkey` is `ON DELETE CASCADE`, so
   *     dropping the user takes the profile with it). Filtering rather than
   *     special-casing a DELETE for it: an explicit statement would be dead
   *     code that reads like a safeguard.
   *   - `platform.operators` (Phase 12 Wave 1, migration 0035) is removed by
   *     the same users DELETE — `operators_user_id_fkey` is also `ON DELETE
   *     CASCADE`, which is deliberate: an operator is a user, and removing the
   *     user must remove their flag.
   *   - `platform.flag_overrides` is the exception. `flag_overrides_set_by_fkey`
   *     has NO cascade — an override row is a fact that should survive the
   *     operator who set it — so the users DELETE would be refused by the
   *     foreign key for any override pointing at a seeded user. Those rows are
   *     deleted explicitly below, keyed by the same user-id marker everything
   *     else in this file keys on.
   *   - `identity.sessions`, `identity.refresh_tokens` and
   *     `platform.push_subscriptions` are all per-USER, not per-org: a sign-in
   *     and a browser's push registration belong to a person, not to whichever
   *     tenant they happened to be looking at. Each references
   *     `identity.users (id) ON DELETE CASCADE` (migrations 0002 and 0029), so
   *     the users DELETE at the end takes them, exactly as it takes
   *     `people.profiles`. They joined the module graph after this set was
   *     written, which is the same way `people.profiles` broke `--reset`
   *     before them — a table with no `org_id` reaching the per-org loop below
   *     fails the whole reset with `column "org_id" does not exist`, naming
   *     the column rather than the table, and only for whoever used the flag.
   */
  const GLOBAL_TABLES = new Set([
    'identity.users',
    'people.profiles',
    'platform.operators',
    'platform.flag_overrides',
    'identity.sessions',
    'identity.refresh_tokens',
    'platform.push_subscriptions',
  ]);

  const allTables = tablesInTeardownOrder(resolveModules(roots));
  /* The per-org loop below filters on `org_id`, so the global tables must be
     excluded from it — but the flag_override guard after it needs to know
     whether the module is in the graph AT ALL, which is why the unfiltered
     list is kept here rather than recomputing or dropping the check. */
  const tables = allTables.filter((table) => !GLOBAL_TABLES.has(table));

  /* The loop below builds its DELETE by interpolating a table name, so a
     table with no `org_id` fails with `column "org_id" does not exist` —
     a message naming the COLUMN and not the table that lacks it, halfway
     through a reset that has already deleted rows. Asking the catalog first
     turns the next occurrence into a sentence naming the table and the list
     above, which is the only part a reader has to change. */
  const orgless = await findTablesWithoutOrgId(connection, tables);
  if (orgless.length > 0) {
    throw new Error(
      `reset: ${orgless.join(', ')} has no org_id column, so it cannot be cleaned per-org. ` +
        'Add it to GLOBAL_TABLES in reset.ts once its cleanup path is understood — see the ' +
        'file header.',
    );
  }

  for (const orgId of orgIds) {
    await connection.setOrg(orgId);

    // Break the docs.pages <-> docs.page_versions cycle before the generic
    // loop below deletes either side of it — see the file header.
    if (tables.includes('docs.pages') || tables.includes('docs.page_versions')) {
      await connection.query(
        'UPDATE docs.pages SET published_version_id = NULL, published_at = NULL WHERE org_id = $1',
        [orgId],
      );
    }

    /* work.sprints (Phase 10.5) has the same shape as the docs cycle, with a
       one-way edge instead of a loop: `cards.sprint_id` references sprints
       WITHOUT a cascade (migration 0054 — the composite FK is what proves a
       card's sprint is its own project's), and the generic loop deletes in
       teardown order, so sprints go before cards. Clearing the reference
       first is exactly what the docs cycle does above — and the same lesson
       from the flag_override block: a table added to the module graph after
       this set was written surfaces here, not in the seeder. */
    if (tables.includes('work.sprints')) {
      await connection.query('UPDATE work.cards SET sprint_id = NULL WHERE org_id = $1', [orgId]);
    }

    for (const table of tables) {
      if (table === 'identity.orgs') {
        await connection.query('DELETE FROM identity.orgs WHERE id = $1', [orgId]);
      } else {
        await connection.query(`DELETE FROM ${table} WHERE org_id = $1`, [orgId]);
      }
    }
  }
  await connection.setOrg(null);

  /* `platform.flag_overrides.set_by` references users WITHOUT cascade
     (migration 0035 — an override outlives the operator who set it), so
     deleting the users below would be refused by that foreign key for any
     override pointing at a seeded user. Delete exactly those first, scoped
     by the same user-id marker everything else keys on: an override a real
     developer set from the console points at a real user and survives,
     which is the surgical boundary this file exists to draw.

     `platform.operators` needs no statement here — its `user_id` FK is ON
     DELETE CASCADE, so the users DELETE below takes the flag with the user. */
  if (allTables.includes('platform.flag_overrides')) {
    await connection.query('DELETE FROM platform.flag_overrides WHERE set_by = ANY($1::uuid[])', [
      userIds,
    ]);
  }

  /* `platform.operator_audit_log.operator_id` references users without
     cascade too, and unlike the override table above it is written by the
     RUNNING APPLICATION rather than by this package.

     This block used to be absent, on the stated reasoning that "the seeder
     deliberately never writes that table, so no seeded-user rows can exist
     to block the delete." That was true of the seeder and false of the
     system: the seeded operator is a seeded user (platform.admin.ts grants
     the flag to user index 0), and `recordOperatorAction` writes a row for
     EVERY platformAdmin.* call — including the read-only list routes, by
     §5's own acceptance criterion. So merely OPENING the operator console
     once with the demo login left rows pointing at a seeded user, and the
     next `--reset` failed on the foreign key with a message naming
     `operator_audit_log`, nowhere near the console that caused it.

     Deleting these is the same surgical boundary the overrides above draw,
     not a weakening of the "a seed must not edit an audit trail" rule: the
     scope is `operator_id = ANY(seeded users)`, so what goes is the record
     of actions taken BY a demo account that is itself being deleted. A real
     developer's operator actions carry their real user id and survive
     untouched. `audit.audit_log` remains genuinely off limits — no role
     holds DELETE on it at all (see the file header). */
  await connection.query(
    'DELETE FROM platform.operator_audit_log WHERE operator_id = ANY($1::uuid[])',
    [userIds],
  );

  /* Users last, and unscoped — `identity.users` carries no `org_id` (it is
     the one global table, CLAUDE.md). By this point every membership row
     that referenced them is gone, so the foreign key from
     `identity.memberships` no longer holds them in place. */
  await connection.query('DELETE FROM identity.users WHERE id = ANY($1::uuid[])', [userIds]);

  log(`reset: removed ${String(orgIds.length)} org(s) and ${String(userIds.length)} user(s)`);
  return { orgsRemoved: orgIds.length, usersRemoved: userIds.length };
}

/**
 * `information_schema.columns` is readable by any role for the tables it owns
 * or holds a privilege on, so this needs no scope and no extra grant — it is
 * asking the catalog a question about shape, not reading tenant data.
 */
async function findTablesWithoutOrgId(
  connection: AdminConnection,
  tables: readonly string[],
): Promise<readonly string[]> {
  if (tables.length === 0) return [];
  const result = await connection.query(
    `SELECT table_schema || '.' || table_name AS name
       FROM information_schema.columns
      WHERE column_name = 'org_id'
        AND table_schema || '.' || table_name = ANY($1::text[])`,
    [[...tables]],
  );
  const withOrgId = new Set(result.rows.map((row) => String(row['name'])));
  return tables.filter((table) => table !== 'identity.orgs' && !withOrgId.has(table));
}

async function findSeededUserIds(
  connection: AdminConnection,
  platformOperatorEmail: string | null,
): Promise<readonly string[]> {
  // identity.users has no tenant RLS, so no scope is needed — but clearing it
  // anyway costs nothing and documents that this read is deliberately global.
  await connection.setOrg(null);
  /* The second branch is a no-op when `platformOperatorEmail` is null:
     `email_normalized = NULL` is UNKNOWN for every row, never TRUE, so the OR
     contributes nothing and the query degrades to the domain-suffix match
     alone — see ResetOptions.platformOperatorEmail's own header. */
  const result = await connection.query(
    `SELECT id FROM identity.users
      WHERE email_normalized LIKE '%@' || $1
         OR email_normalized = $2`,
    [SEED_EMAIL_DOMAIN, platformOperatorEmail?.toLowerCase() ?? null],
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
