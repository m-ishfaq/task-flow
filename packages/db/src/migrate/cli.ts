/**
 * Migration CLI.
 *
 *   pnpm --filter @taskflow/db migrate:up
 *   pnpm --filter @taskflow/db migrate:down
 *   pnpm --filter @taskflow/db migrate:status
 *   pnpm --filter @taskflow/db migrate:verify
 *
 * Connects as taskflow_migrator via DATABASE_MIGRATION_URL. It must never be
 * given the application's DATABASE_URL: taskflow_app has no DDL rights, and
 * granting them to make migrations "just work" would hand the runtime role the
 * ability to drop its own RLS policies (§8.3).
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { down, status, up, verify, type RunnerOptions } from './runner.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = resolve(here, '..', '..', 'migrations');

/**
 * Load the repo-root .env, which is what CLAUDE.md and .env.example tell a
 * developer to create.
 *
 * `loadEnvFile` follows `--env-file` semantics and does NOT overwrite variables
 * already present, so a deployed environment's injected secrets always win over
 * a stray file. That ordering is the whole reason this is safe to do here.
 */
const envFile = resolve(here, '..', '..', '..', '..', '.env');
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

const migrationUrl = process.env['DATABASE_MIGRATION_URL'];
if (!migrationUrl) {
  console.error(
    'DATABASE_MIGRATION_URL is not set.\n' +
      'Copy .env.example to .env, or export it directly. It must point at the\n' +
      'taskflow_migrator role — not the application role.',
  );
  process.exit(1);
}

if (migrationUrl.includes('taskflow_app:')) {
  // Cheap check against the most likely misconfiguration, which would otherwise
  // fail deep inside a migration with a confusing permissions error.
  console.error(
    'DATABASE_MIGRATION_URL points at taskflow_app. Migrations must run as\n' +
      'taskflow_migrator; the application role has no DDL rights by design.',
  );
  process.exit(1);
}

const options: RunnerOptions = {
  migrationUrl,
  migrationsDir,
  log: (message) => {
    console.warn(message);
  },
};

const command = process.argv[2] ?? 'status';

try {
  switch (command) {
    case 'up': {
      const applied = await up(options);
      console.warn(
        applied === 0 ? 'Already up to date.' : `Applied ${String(applied)} migration(s).`,
      );
      break;
    }

    case 'down': {
      const rawCount = process.argv[3] ?? '1';
      const count = Number(rawCount);
      if (!Number.isInteger(count) || count < 1) {
        console.error(`Invalid count "${rawCount}" — expected a positive integer.`);
        process.exit(1);
      }
      const reverted = await down(options, count);
      console.warn(`Reverted ${String(reverted)} migration(s).`);
      break;
    }

    case 'status': {
      const rows = await status(options);
      if (rows.length === 0) {
        console.warn('No migrations found.');
        break;
      }
      for (const row of rows) {
        const mark = row.checksumMismatch ? 'CHANGED!' : row.applied ? 'applied ' : 'pending ';
        console.warn(`  ${mark} ${String(row.id).padStart(4, '0')}_${row.name}`);
      }
      if (rows.some((r) => r.checksumMismatch)) {
        console.error('\nAn applied migration was modified. Add a new migration instead.');
        process.exit(1);
      }
      break;
    }

    case 'verify': {
      await verify(options);
      break;
    }

    default:
      console.error(`Unknown command "${command}". Expected: up | down | status | verify`);
      process.exit(1);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
