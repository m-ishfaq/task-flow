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
 * The local development migrator connection.
 *
 * A constant rather than a `process.env` read, because guardrail 7 bans bare
 * env access outside a validated schema and this package has none — it is a
 * library, and its configuration arrives as arguments. Callers that need a
 * different database pass `url`; CI sets exactly this value, so nothing has to.
 */
export const DEV_MIGRATION_URL =
  'postgresql://taskflow_migrator:migrator-dev-secret@localhost:5432/taskflow';

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
    migrationUrl: options.url ?? DEV_MIGRATION_URL,
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
  /** Sets `app.org_id` for subsequent statements. Pass null to clear it. */
  setOrg(orgId: string | null): Promise<void>;
  end(): Promise<void>;
}

export async function connectAsMigrator(options: AdminOptions = {}): Promise<AdminConnection> {
  const client = new pg.Client({
    connectionString: options.url ?? DEV_MIGRATION_URL,
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
    end: () => client.end(),
  };
}
