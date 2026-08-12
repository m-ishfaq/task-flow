import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';

/**
 * Migration runner (PLAN.md §12).
 *
 * Deliberately hand-rolled rather than delegating to `drizzle-kit migrate`, for
 * three reasons specific to this project:
 *
 *   1. Migrations must run as `taskflow_migrator`, a different role from the one
 *      the application uses. Tooling that assumes one connection cannot express
 *      that separation, and the separation is what makes RLS meaningful (§8.3).
 *   2. Every tenant table needs `ENABLE`/`FORCE ROW LEVEL SECURITY`, a policy,
 *      and grants. Schema-diffing tools do not generate any of that, so the SQL
 *      is authored explicitly.
 *   3. Paired up/down files make the `up → down → up` verification possible,
 *      which is what proves a migration is genuinely reversible before it
 *      reaches production.
 *
 * Expand / migrate / contract is the doctrine (§7):
 *   EXPAND   add the new column/table, nullable, alongside the old
 *   MIGRATE  backfill and dual-write; deploy code reading the new shape
 *   CONTRACT drop the old shape, in a LATER migration
 * Never rename or drop in the same migration that adds. A deploy is not atomic
 * with its migration, so old and new code always run concurrently for a while.
 */

const { Client } = pg;

export interface Migration {
  readonly id: number;
  readonly name: string;
  readonly upSql: string;
  readonly downSql: string;
  readonly checksum: string;
}

export interface MigrationStatus {
  readonly id: number;
  readonly name: string;
  readonly applied: boolean;
  readonly appliedAt?: Date;
  /** True when the file changed after being applied — always an error. */
  readonly checksumMismatch: boolean;
}

const TRACKING_TABLE = 'public.schema_migrations';

/**
 * Fixed and arbitrary — the value only has to be agreed on by every `up`/
 * `down` caller against the same database. Serializes concurrent migration
 * runs: `up` reads which migrations are already applied and then loops
 * applying the pending ones, with nothing between those two steps to stop a
 * second caller from reading the same "not yet applied" answer and racing
 * the first to apply it — which `packages/db/src/testing/index.ts`'s
 * `applyMigrations` makes a real scenario, not a hypothetical one: every
 * test suite calls it from its own setup, and turbo runs suites in parallel
 * against one shared `taskflow_test`. Found live as two concurrent `CREATE
 * TABLE`s for the same migration colliding on Postgres's own catalog insert
 * for the table's implicit row type — "duplicate key value violates unique
 * constraint pg_type_typname_nsp_index" gives no hint that the actual cause
 * is two callers, not a schema bug in the migration itself.
 */
const MIGRATION_LOCK_KEY = 84652211;

const CREATE_TRACKING = `
  CREATE TABLE IF NOT EXISTS ${TRACKING_TABLE} (
    id          integer     PRIMARY KEY,
    name        text        NOT NULL,
    checksum    text        NOT NULL,
    applied_at  timestamptz NOT NULL DEFAULT now()
  );
`;

const FILENAME = /^(\d{4})_([a-z0-9_]+)\.(up|down)\.sql$/;

/** Zero-padded migration id, matching the on-disk filenames. */
const fmtId = (id: number): string => String(id).padStart(4, '0');

const errText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Loads and validates paired migration files from disk, ordered by id. */
export async function loadMigrations(dir: string): Promise<Migration[]> {
  const files = await readdir(dir);
  const ups = new Map<number, { name: string; sql: string }>();
  const downs = new Map<number, string>();

  for (const file of files.sort()) {
    const match = FILENAME.exec(file);
    if (!match) {
      if (file.endsWith('.sql')) {
        throw new Error(`Migration "${file}" does not match NNNN_name.(up|down).sql — rename it.`);
      }
      continue;
    }

    const idRaw = match[1];
    const name = match[2];
    const direction = match[3];
    if (idRaw === undefined || name === undefined || direction === undefined) continue;

    const id = Number(idRaw);
    const sqlText = await readFile(join(dir, file), 'utf8');

    if (direction === 'up') ups.set(id, { name, sql: sqlText });
    else downs.set(id, sqlText);
  }

  const migrations: Migration[] = [];
  for (const [id, up] of [...ups.entries()].sort((a, b) => a[0] - b[0])) {
    const down = downs.get(id);
    if (down === undefined) {
      // A migration with no down file cannot be verified reversible, so it is
      // rejected outright rather than silently trusted.
      throw new Error(
        `Migration ${fmtId(id)}_${up.name} has no .down.sql. ` +
          `Every migration must be reversible — write an explicit down, or an ` +
          `explanatory no-op if the change genuinely cannot be undone.`,
      );
    }

    migrations.push({
      id,
      name: up.name,
      upSql: up.sql,
      downSql: down,
      // Checksum covers only the UP script: down files may be corrected after
      // the fact, but an applied up must never change.
      checksum: createHash('sha256').update(up.sql).digest('hex').slice(0, 16),
    });
  }

  return migrations;
}

async function connect(url: string): Promise<pg.Client> {
  const client = new Client({ connectionString: url, application_name: 'taskflow-migrator' });
  await client.connect();
  return client;
}

export interface RunnerOptions {
  /** Connection string for taskflow_migrator — NOT the application role. */
  readonly migrationUrl: string;
  readonly migrationsDir: string;
  readonly log?: (message: string) => void;
}

export async function status(options: RunnerOptions): Promise<MigrationStatus[]> {
  const migrations = await loadMigrations(options.migrationsDir);
  const client = await connect(options.migrationUrl);

  try {
    await client.query(CREATE_TRACKING);
    const { rows } = await client.query<{ id: number; checksum: string; applied_at: Date }>(
      `SELECT id, checksum, applied_at FROM ${TRACKING_TABLE}`,
    );
    const appliedById = new Map(rows.map((r) => [r.id, r]));

    return migrations.map((m) => {
      const applied = appliedById.get(m.id);
      return {
        id: m.id,
        name: m.name,
        applied: applied !== undefined,
        ...(applied && { appliedAt: applied.applied_at }),
        checksumMismatch: applied !== undefined && applied.checksum !== m.checksum,
      };
    });
  } finally {
    await client.end();
  }
}

/** Applies all pending migrations, each in its own transaction. */
export async function up(options: RunnerOptions): Promise<number> {
  const log = options.log ?? (() => undefined);
  const migrations = await loadMigrations(options.migrationsDir);
  const client = await connect(options.migrationUrl);
  let applied = 0;

  try {
    // Session-level: held for this whole function, released (explicitly, or
    // by client.end() below if something throws first) once every pending
    // migration has been applied and committed — so a second caller blocked
    // here re-reads the tracking table only after seeing the first caller's
    // writes, not the same stale "not yet applied" snapshot.
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    try {
      await client.query(CREATE_TRACKING);
      const { rows } = await client.query<{ id: number; checksum: string }>(
        `SELECT id, checksum FROM ${TRACKING_TABLE}`,
      );
      const appliedById = new Map(rows.map((r) => [r.id, r.checksum]));

      for (const migration of migrations) {
        const existing = appliedById.get(migration.id);

        if (existing !== undefined) {
          if (existing !== migration.checksum) {
            // An applied migration whose file has changed means the database and
            // the repository disagree about history. Continuing would apply later
            // migrations onto a schema that is not what the code expects.
            throw new Error(
              `Migration ${fmtId(migration.id)} (${migration.name}) was modified after being ` +
                `applied (recorded ${existing}, file ${migration.checksum}). Never edit an ` +
                `applied migration — add a new one instead.`,
            );
          }
          continue;
        }

        log(`  up   ${fmtId(migration.id)}_${migration.name}`);

        // Each migration is atomic. Postgres supports transactional DDL, so a
        // failure mid-migration leaves no partially-migrated schema.
        await client.query('BEGIN');
        try {
          await client.query(migration.upSql);
          await client.query(
            `INSERT INTO ${TRACKING_TABLE} (id, name, checksum) VALUES ($1, $2, $3)`,
            [migration.id, migration.name, migration.checksum],
          );
          await client.query('COMMIT');
          applied += 1;
        } catch (error) {
          await client.query('ROLLBACK');
          throw new Error(
            `Migration ${fmtId(migration.id)} (${migration.name}) failed and was rolled back: ` +
              errText(error),
          );
        }
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    }
  } finally {
    await client.end();
  }

  return applied;
}

/** Reverts the most recent `count` applied migrations, newest first. */
export async function down(options: RunnerOptions, count = 1): Promise<number> {
  const log = options.log ?? (() => undefined);
  const migrations = await loadMigrations(options.migrationsDir);
  const byId = new Map(migrations.map((m) => [m.id, m]));
  const client = await connect(options.migrationUrl);
  let reverted = 0;

  try {
    // Same lock `up` takes, and the same reason: nothing else stops a
    // concurrent `up`/`down` pair from reading the tracking table at the
    // same instant and racing to mutate the same rows.
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    try {
      await client.query(CREATE_TRACKING);
      const { rows } = await client.query<{ id: number; name: string }>(
        `SELECT id, name FROM ${TRACKING_TABLE} ORDER BY id DESC LIMIT $1`,
        [count],
      );

      for (const row of rows) {
        const migration = byId.get(row.id);
        if (!migration) {
          throw new Error(
            `Migration ${fmtId(row.id)} (${row.name}) is recorded as applied but its files are ` +
              `missing. Cannot revert what cannot be read.`,
          );
        }

        log(`  down ${fmtId(migration.id)}_${migration.name}`);

        await client.query('BEGIN');
        try {
          await client.query(migration.downSql);
          await client.query(`DELETE FROM ${TRACKING_TABLE} WHERE id = $1`, [migration.id]);
          await client.query('COMMIT');
          reverted += 1;
        } catch (error) {
          await client.query('ROLLBACK');
          throw new Error(
            `Rollback of migration ${fmtId(migration.id)} (${migration.name}) failed: ` +
              errText(error),
          );
        }
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    }
  } finally {
    await client.end();
  }

  return reverted;
}

/**
 * A database `verify` is permitted to destroy.
 *
 * `verify` reverts EVERY migration before re-applying them, so it drops every
 * table and everything in them. Nothing distinguishes a database that exists to
 * be thrown away from one holding a developer's own org, boards and cards except
 * the connection string — which this command does not own and, until now, read
 * from whatever `.env` happened to be on disk.
 *
 * That is not a hypothetical. Run against `taskflow`, it deleted a real account,
 * project, board and card, and then printed `verify: OK — migrations are
 * reversible and re-appliable`. The damage is invisible in the output and
 * indistinguishable from success: the next sign-in fails with "Incorrect email
 * or password", which reads as an authentication bug rather than as the command
 * that caused it.
 *
 * So the target must be marked disposable IN ITS NAME. An assumption that the
 * URL points somewhere safe is exactly the kind of vigilance this codebase does
 * not rely on.
 */
const DISPOSABLE_SUFFIX = '_test';

/**
 * Throws unless `url` names a disposable database.
 *
 * Exported so the CLI can fail before doing anything, and so a test can prove
 * the refusal still fires — a guard that silently stops matching is worse than
 * no guard, because the command keeps reporting OK either way.
 */
export function assertDisposableDatabase(url: string): void {
  let database: string;
  try {
    database = new URL(url).pathname.replace(/^\//, '');
  } catch {
    // An unparseable URL cannot be shown to be safe, and the whole point here is
    // that "probably fine" is not good enough before dropping every table.
    throw new Error('verify: could not read a database name from the connection string.');
  }

  if (!database.endsWith(DISPOSABLE_SUFFIX)) {
    throw new Error(
      `verify: refusing to run against "${database}".\n` +
        'It reverts every migration, which drops every table and all of their\n' +
        'contents. Only a database whose name ends in "_test" may be used.\n' +
        'Set DATABASE_VERIFY_URL, or leave it unset to use taskflow_test.',
    );
  }
}

/**
 * The CI gate: apply everything, revert everything, apply everything again.
 *
 * Catches the two failure modes that only appear under rollback — a down script
 * that does not actually undo its up, and an up script that is not re-runnable
 * from a reverted state. Both are cheap to find here and expensive to find
 * during an incident.
 */
export async function verify(options: RunnerOptions): Promise<void> {
  // Before loading a file or opening a connection: this is destructive, and a
  // check that runs after the first `down` has already lost the data.
  assertDisposableDatabase(options.migrationUrl);

  const log = options.log ?? (() => undefined);
  const migrations = await loadMigrations(options.migrationsDir);

  log('verify: applying all migrations');
  await up(options);

  log(`verify: reverting all ${String(migrations.length)} migration(s)`);
  await down(options, migrations.length);

  const afterDown = await status(options);
  const stillApplied = afterDown.filter((s) => s.applied);
  if (stillApplied.length > 0) {
    throw new Error(
      `verify: ${String(stillApplied.length)} migration(s) still recorded as applied after ` +
        `full rollback: ${stillApplied.map((s) => s.name).join(', ')}`,
    );
  }

  log('verify: re-applying all migrations');
  await up(options);

  log('verify: OK — migrations are reversible and re-appliable');
}
