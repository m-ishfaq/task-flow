import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { up } from '../migrate/runner.js';

/**
 * Test-only database access — `@taskflow/db/testing`.
 *
 * Exists because guardrail 2 bans importing `pg` outside this package, and test
 * fixtures legitimately need what the application role cannot do: create rows
 * for several tenants, and read across them to check the result.
 *
 * That is not a hole in the guardrail. The connection here is the MIGRATOR, not
 * a privileged application client, and `taskflow_migrator` is `NOBYPASSRLS`
 * like every other role — so seeding still has to scope each insert with
 * `SET app.org_id`, exactly as production code does. A fixture that forgets
 * writes nothing, which is the same failure the application would get.
 *
 * The separate entry point is the point: `@taskflow/db/testing` in a
 * non-test file is visible in a diff and in a dependency graph, where
 * `import pg` buried in a feature module is not.
 */

/**
 * The migrator connection for TESTS — `taskflow_test`, never `taskflow`.
 *
 * The database name is the whole point of this constant. Every suite that
 * imports this module truncates the tables it touches, so aimed at `taskflow`
 * it deletes the developer's own account and boards on each `pnpm verify`. The
 * damage is silent: the run passes, and the next sign-in fails with "Incorrect
 * email or password" because `no_such_user` and a wrong password return the
 * same message by design — so the symptom points at authentication rather than
 * at the test run that caused it.
 *
 * A constant rather than a `process.env` read, because guardrail 7 bans bare
 * env access outside a validated schema and this package has none — it is a
 * library, and its configuration arrives as arguments. Callers that need a
 * different database pass `url`; CI sets exactly this value, so nothing has to.
 */
export const TEST_MIGRATION_URL =
  'postgresql://taskflow_migrator:migrator-dev-secret@localhost:5433/taskflow_test';

export interface AdminOptions {
  /** Overrides the local development connection. */
  readonly url?: string;
}

/** Where the migration files live, resolved from this package rather than guessed. */
export function migrationsDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');
}

/** Applies every pending migration. Idempotent, so every suite may call it. */
export async function applyMigrations(options: AdminOptions = {}): Promise<void> {
  await up({
    migrationUrl: options.url ?? TEST_MIGRATION_URL,
    migrationsDir: migrationsDir(),
  });
}

/**
 * A raw connection as the migrator, for seeding and teardown.
 *
 * Subject to FORCE RLS like everything else — `setOrg` is not a convenience, it
 * is required before touching any tenant table.
 */
export interface AdminConnection {
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  /** Sets `app.org_id` for subsequent statements (clearing `app.user_id`). Pass null to clear it. */
  setOrg(orgId: string | null): Promise<void>;
  /**
   * Sets `app.user_id` for subsequent statements, clearing `app.org_id` —
   * the mirror of `setOrg`, and the same shape `withUserScope` has in
   * production (each sets both variables, one of them empty, so neither can
   * be inherited across a pooled connection).
   *
   * Required to seed the SELF-scoped tables: `platform.push_subscriptions`
   * (0029) and `platform.expo_push_tokens` (0082) gate INSERT on
   * `user_id = current_setting('app.user_id')`, and the migrator does not
   * bypass RLS. Without this there is no way to write those rows at all from
   * a test — `setOrg` actively clears `app.user_id`, so seeding a device row
   * was impossible rather than merely awkward.
   */
  setUser(userId: string | null): Promise<void>;
  end(): Promise<void>;
}

export async function connectAsMigrator(options: AdminOptions = {}): Promise<AdminConnection> {
  const client = new pg.Client({
    connectionString: options.url ?? TEST_MIGRATION_URL,
    application_name: 'taskflow-test-admin',
  });
  await client.connect();

  return {
    query: async (text, values) => {
      const result = await client.query<Record<string, unknown>>(
        text,
        values === undefined ? undefined : [...values],
      );
      return { rows: result.rows, rowCount: result.rowCount };
    },
    setOrg: async (orgId) => {
      await client.query(`SELECT set_config('app.org_id', $1, false)`, [orgId ?? '']);
      await client.query(`SELECT set_config('app.user_id', '', false)`);
    },
    setUser: async (userId) => {
      await client.query(`SELECT set_config('app.user_id', $1, false)`, [userId ?? '']);
      await client.query(`SELECT set_config('app.org_id', '', false)`);
    },
    end: () => client.end(),
  };
}
