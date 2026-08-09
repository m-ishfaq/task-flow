/**
 * Bootstraps a platform operator (Phase 12 §3.1, §7 decision 7).
 *
 *   pnpm --filter @taskflow/db grant-platform-operator -- \
 *     --email owner@example.com --note "founding operator, 2026-08-09"
 *
 * `platform.operators` has NO application-reachable write path, on purpose:
 * `taskflow_app` holds SELECT only (migration 0036 is what actually makes
 * that true — 0035's explicit grant was weaker than the schema-wide default
 * privileges already in force), and `taskflow_platform_admin` holds nothing
 * at all on
 * this table. This script is the ONLY thing that writes it, connecting as
 * `taskflow_migrator` — the same elevated, migration-only role
 * `docker/postgres/init/02-roles.sql` already reserves for schema changes,
 * used here for a data change instead because there is no other role with
 * INSERT on this table to reach for.
 *
 * No route and no UI: §7 decision 7 is that granting operator access is a
 * migration-or-script action, never a product surface, because a route that
 * writes this table would be a privilege-escalation surface with no
 * operator-side control above it.
 *
 * ## Why this writes the operator chain, and does not publish an event
 *
 * It writes `platform.operator_audit_log` in the SAME transaction as the
 * grant. §5's criterion is that every operator action produces a row in that
 * chain, and granting operator access is the most consequential action in
 * the system — it would be perverse for `orgs.list` to be chained and this
 * not to be. Same transaction, so a chain write that fails takes the grant
 * with it: better no operator than an operator nobody can see was made one.
 *
 * It does NOT publish `platform.operator_granted`, which
 * `apps/api/src/platform-admin/events.ts` does define. That event exists for
 * an in-process subscriber, and this is a standalone script with no EventBus
 * and nothing listening — publishing would construct an object and drop it.
 * The chain row is the durable record; the event's own comment already
 * anticipates a script as its only realistic producer, and this is that
 * script declining to fake a delivery.
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

    const existing = await admin.query(
      `SELECT user_id FROM platform.operators WHERE user_id = $1`,
      [targetRow['id']],
    );
    if (existing.rows.length > 0) {
      console.warn(`${String(targetRow['email'])} is already a platform operator. Nothing to do.`);
      return;
    }

    /* One transaction for the grant AND its chain row (see the file header).
       `seq`, `prev_hash` and `hash` are placeholders the BEFORE INSERT
       trigger overwrites under the global chain-head lock — the same
       discipline `recordOperatorAction` applies, so a writer can never
       choose its own position or digest.

       `granted_by` is the ATTRIBUTED granter and `operator_id` on the chain
       row is the same, deliberately: the chain answers "who did this", and
       for a bootstrapping grant with no prior operator that is the target
       themselves — which the note and this script's own output make legible
       rather than hiding behind a null. */
    await admin.query('BEGIN');
    try {
      await admin.query(
        `INSERT INTO platform.operators (user_id, granted_by, note) VALUES ($1, $2, $3)`,
        [targetRow['id'], grantedById, args.note],
      );

      await admin.query(
        `INSERT INTO platform.operator_audit_log (seq, operator_id, action, target, hash)
         VALUES (0, $1, 'operators.grant', $2::jsonb, '\\x'::bytea)`,
        [grantedById, JSON.stringify({ userId: targetRow['id'], note: args.note })],
      );

      await admin.query('COMMIT');
    } catch (error) {
      await admin.query('ROLLBACK');
      throw error;
    }

    console.warn(
      `Granted platform-operator access to ${String(targetRow['email'])}.\n` +
        `  note: ${args.note}\n` +
        `  granted by: ${args.grantedByEmail ?? '(self — bootstrapping grant)'}\n` +
        `  recorded in platform.operator_audit_log as 'operators.grant'`,
    );
  } finally {
    await admin.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
