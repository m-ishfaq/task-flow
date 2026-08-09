/**
 * Bootstraps a platform operator (Phase 12 §3.1, §7 decision 7).
 *
 *   pnpm --filter @taskflow/db grant-platform-operator -- \
 *     --email owner@example.com --note "founding operator, 2026-08-09"
 *
 * `platform.operators` has NO application-reachable write path, on purpose:
 * `taskflow_app` holds SELECT only, and `taskflow_platform_admin` holds
 * nothing at all on this table — see migration 0032's own header for why
 * that is deliberately stricter than every other cross-tenant role in this
 * system. This script is the ONLY thing that writes it, connecting as
 * `taskflow_migrator` — the same elevated, migration-only role
 * `docker/postgres/init/02-roles.sql` already reserves for schema changes,
 * used here for a data change instead because there is no other role with
 * INSERT on this table to reach for.
 *
 * No route, no UI, and deliberately no domain event — see
 * `apps/api/src/platform-admin/events.ts`'s own header for why a
 * `platform.operatorGranted` event is not defined: there is no outbox path
 * for a table with no org, and inventing one for an action that happens
 * (realistically) once or twice in this system's whole lifetime would be
 * bookkeeping for a feature that does not exist. This script logs what it
 * did to its own stdout instead, which is the accountability record a
 * human operator reads at the moment it matters — right after running it.
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectAsMigrator } from './testing/index.js';

const here = dirname(fileURLToPath(import.meta.url));

const envFile = resolve(here, '..', '..', '..', '.env');
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

interface Args {
  readonly email: string;
  readonly note: string;
  /** Who to attribute the grant to. Defaults to the target themselves — see printHelp. */
  readonly grantedByEmail: string | null;
  readonly help: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  let email: string | null = null;
  let note: string | null = null;
  let grantedByEmail: string | null = null;
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;

    switch (arg) {
      case '--email': {
        const value = argv[i + 1];
        if (!value) throw new Error('--email needs a value.');
        email = value;
        i += 1;
        break;
      }
      case '--note': {
        const value = argv[i + 1];
        if (!value) throw new Error('--note needs a value.');
        note = value;
        i += 1;
        break;
      }
      case '--granted-by': {
        const value = argv[i + 1];
        if (!value) throw new Error('--granted-by needs a value.');
        grantedByEmail = value;
        i += 1;
        break;
      }
      case '--help':
      case '-h':
        help = true;
        break;
      default:
        throw new Error(`Unknown argument "${arg}". Try --help.`);
    }
  }

  if (help) return { email: '', note: '', grantedByEmail, help: true };
  if (email === null) throw new Error('--email is required. Try --help.');
  if (note === null || note.trim().length === 0) {
    throw new Error('--note is required and must not be blank — who this is and why.');
  }

  return { email, note, grantedByEmail, help: false };
}

function printHelp(): void {
  console.warn(
    [
      'pnpm --filter @taskflow/db grant-platform-operator -- [options]',
      '',
      '  --email <address>        the account to grant platform-operator access to',
      '  --note <text>            who this is and why, required, never blank',
      '  --granted-by <address>   attribute the grant to a DIFFERENT existing operator;',
      "                           defaults to the target's own address, for a first,",
      '                           bootstrapping grant with no prior operator to attribute it to',
      '  --help                   this message',
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const migrationUrl = process.env['DATABASE_MIGRATION_URL'];
  if (!migrationUrl) {
    throw new Error(
      'DATABASE_MIGRATION_URL is not set.\n' +
        'Copy .env.example to .env, or export it directly. It must point at the\n' +
        'taskflow_migrator role — the only role with INSERT on platform.operators.',
    );
  }

  const admin = await connectAsMigrator({ url: migrationUrl });

  try {
    // identity.users carries no RLS — a user is not owned by an org — so this
    // is readable with no scope set, the same property that lets login
    // resolve any email to an account before any org is known.
    const normalized = args.email.trim().toLowerCase();
    const target = await admin.query(
      `SELECT id, email FROM identity.users WHERE email_normalized = $1`,
      [normalized],
    );
    const targetRow = target.rows[0];
    if (!targetRow) {
      throw new Error(`No account with the address "${args.email}".`);
    }

    let grantedById = targetRow['id'];
    if (args.grantedByEmail !== null) {
      const grantedByNormalized = args.grantedByEmail.trim().toLowerCase();
      const grantedByResult = await admin.query(
        `SELECT id FROM identity.users WHERE email_normalized = $1`,
        [grantedByNormalized],
      );
      const grantedByRow = grantedByResult.rows[0];
      if (!grantedByRow) {
        throw new Error(`No account with the address "${args.grantedByEmail}" (--granted-by).`);
      }
      grantedById = grantedByRow['id'];
    }

    const existing = await admin.query(`SELECT user_id FROM platform.operators WHERE user_id = $1`, [
      targetRow['id'],
    ]);
    if (existing.rows.length > 0) {
      console.warn(`${String(targetRow['email'])} is already a platform operator. Nothing to do.`);
      return;
    }

    await admin.query(
      `INSERT INTO platform.operators (user_id, granted_by, note) VALUES ($1, $2, $3)`,
      [targetRow['id'], grantedById, args.note],
    );

    console.warn(
      `Granted platform-operator access to ${String(targetRow['email'])}.\n` +
        `  note: ${args.note}\n` +
        `  granted by: ${args.grantedByEmail ?? '(self — bootstrapping grant)'}`,
    );
  } finally {
    await admin.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
