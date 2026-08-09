import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeAuditDatabase } from '@taskflow/db';
import { connectAsMigrator } from '@taskflow/db/testing';
import { S3StorageProvider } from '@taskflow/storage';
import type { StorageProvider } from '@taskflow/contracts';
import { createSeedContext } from './context.js';
import { createRng } from './rng.js';
import {
  DEFAULT_PROFILE,
  findProfile,
  plannedCardCount,
  plannedMessageCount,
  plannedPageCount,
} from './profiles.js';
import { resolveModules } from './registry.js';
import { reset } from './reset.js';
import { usersModule } from './modules/identity.users.js';
import { orgsModule } from './modules/tenancy.orgs.js';
// Every other module is reached transitively through `auditModule`'s own
// `requires` chain (platform.audit -> ... -> identity.users) — importing it
// alone is what registers the whole graph. `usersModule`, `orgsModule` and
// `adminModule` are imported here only because the printouts below read their
// output directly.
import { auditModule } from './modules/platform.audit.js';
import { adminModule } from './modules/platform.admin.js';

/**
 * `pnpm seed [--profile <name>] [--seed <value>] [--reset] [--chaos]`
 *
 * Everything below `parseArgs` and the three safety guards is process
 * plumbing: build a context, walk the module graph in dependency order,
 * print what happened. The actual seeding logic lives in `modules/*.ts`,
 * where each module owns exactly the tables it named in `tables`.
 *
 * `auditModule` is the only root this passes to `resolveModules`. Its own
 * `requires` reach every other module transitively (CLAUDE.md, the
 * `registry.ts` header) — adding a Chat module in a later phase means adding
 * one file and one entry in that module's `requires`, not a line here.
 */

const here = dirname(fileURLToPath(import.meta.url));

/* Load the repo-root .env, exactly as `migrate/cli.ts` does — this file is
   listed in the guardrail-7 CLI exemption (`packages/config/eslint/security.js`)
   for the same reason that one is: a process entry point reads argv and env
   before any validated config can exist to read it from. */
const envFile = resolve(here, '..', '..', '..', '.env');
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

interface Args {
  readonly profile: string;
  readonly seed: string;
  readonly reset: boolean;
  readonly chaos: boolean;
  readonly help: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  let profile = DEFAULT_PROFILE;
  let seed = 'taskflow-dev';
  let doReset = false;
  let chaos = false;
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;

    switch (arg) {
      case '--profile': {
        const value = argv[i + 1];
        if (!value) throw new Error('--profile needs a value.');
        profile = value;
        i += 1;
        break;
      }
      case '--seed': {
        const value = argv[i + 1];
        if (!value) throw new Error('--seed needs a value.');
        seed = value;
        i += 1;
        break;
      }
      case '--reset':
        doReset = true;
        break;
      case '--chaos':
        chaos = true;
        break;
      case '--help':
      case '-h':
        help = true;
        break;
      default:
        throw new Error(`Unknown argument "${arg}". Try --help.`);
    }
  }

  return { profile, seed, reset: doReset, chaos, help };
}

function printHelp(): void {
  console.warn(
    [
      'pnpm seed [options]',
      '',
      '  --profile <name>   minimal | demo (default) | large',
      '  --seed <value>     RNG seed — same value always produces the same database',
      "  --reset            remove this package's previously seeded orgs/users first",
      '  --chaos            deliberately create a degenerate rank, to exercise rebalance',
      '  --help             this message',
    ].join('\n'),
  );
}

/* ---------------------------------------------------------------------- *
 * Safety guards — all three run before a single write.
 * ---------------------------------------------------------------------- */

function requireMigrationUrl(): string {
  const url = process.env['DATABASE_MIGRATION_URL'];
  if (!url) {
    console.error(
      'DATABASE_MIGRATION_URL is not set.\n' +
        'Copy .env.example to .env, or export it directly. It must point at the\n' +
        'taskflow_migrator role — not the application role.',
    );
    process.exit(1);
  }
  return url;
}

/**
 * Refuses `NODE_ENV=production`, a database name ending in `_test`, and the
 * application role — three separate ways to seed data into a place it must
 * never end up (CLAUDE.md, "Guards before a single write").
 */
function assertSafeToSeed(migrationUrl: string): void {
  if (process.env['NODE_ENV'] === 'production') {
    console.error('Refusing to seed: NODE_ENV=production.');
    process.exit(1);
  }

  if (migrationUrl.includes('taskflow_app:')) {
    console.error(
      'DATABASE_MIGRATION_URL points at taskflow_app. Seeding writes as taskflow_migrator;\n' +
        'the application role is not meant to receive bulk inserts from outside a request.',
    );
    process.exit(1);
  }

  let databaseName: string;
  try {
    databaseName = new URL(migrationUrl).pathname.replace(/^\//, '');
  } catch {
    console.error(`DATABASE_MIGRATION_URL is not a valid connection string: ${migrationUrl}`);
    process.exit(1);
  }

  if (databaseName.endsWith('_test')) {
    console.error(
      `Refusing to seed "${databaseName}": that suffix is reserved for the test suites, which\n` +
        'truncate these tables on every run. Point DATABASE_MIGRATION_URL at your dev database.',
    );
    process.exit(1);
  }
}

function buildStorage(): StorageProvider | null {
  const endpoint = process.env['STORAGE_ENDPOINT'];
  const accessKeyId = process.env['STORAGE_ACCESS_KEY_ID'];
  const secretAccessKey = process.env['STORAGE_SECRET_ACCESS_KEY'];
  const bucket = process.env['STORAGE_BUCKET_ATTACHMENTS'];
  if (!accessKeyId || !secretAccessKey || !bucket) return null;

  return new S3StorageProvider({
    ...(endpoint === undefined ? {} : { endpoint }),
    region: process.env['STORAGE_REGION'] ?? 'us-east-1',
    bucket,
    accessKeyId,
    secretAccessKey,
    forcePathStyle: (process.env['STORAGE_FORCE_PATH_STYLE'] ?? 'true') !== 'false',
  });
}

/* ---------------------------------------------------------------------- *
 * Main
 * ---------------------------------------------------------------------- */

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const profile = findProfile(args.profile);
  const migrationUrl = requireMigrationUrl();
  assertSafeToSeed(migrationUrl);

  const auditUrl = process.env['DATABASE_AUDIT_URL'];
  if (auditUrl) {
    initializeAuditDatabase({ url: auditUrl, applicationName: 'taskflow-seed' });
  }

  const connection = await connectAsMigrator({ url: migrationUrl });

  try {
    const roots = [auditModule];

    if (args.reset) {
      await reset({
        connection,
        roots,
        log: (message) => {
          console.warn(message);
        },
      });
    }

    console.warn(
      `Seeding profile "${profile.name}" — ${String(profile.orgs.length)} org(s), ` +
        `~${String(plannedCardCount(profile))} live card(s), ` +
        // A floor, not an estimate: threaded replies are a function of the mix
        // rather than of the plan (see `plannedMessageCount`).
        `${String(plannedMessageCount(profile))}+ message(s), ` +
        // A ceiling, for the opposite reason — see `plannedPageCount`.
        `<=${String(plannedPageCount(profile))} page(s). Seed: ${args.seed}${
          args.chaos ? ' (chaos)' : ''
        }`,
    );

    const rng = createRng(args.seed);
    const storage = buildStorage();
    if (profile.attachments && !storage) {
      console.warn(
        'platform.attachments: STORAGE_* not fully configured — attachments will be skipped.',
      );
    }

    const { ctx, record } = createSeedContext({
      connection,
      rng,
      profile,
      now: new Date(),
      chaos: args.chaos,
      storage,
      log: (message) => {
        console.warn(message);
      },
    });

    const ordered = resolveModules(roots);
    // Modules share one RNG stream and one outbox buffer, and must run
    // strictly in the dependency order `resolveModules` derived — not
    // in parallel, and not out of order.
    for (const module of ordered) {
      const output = await module.seed(ctx);
      record(module, output);
    }

    const { users, password } = ctx.use(usersModule);
    const { orgs } = ctx.use(orgsModule);
    const { operator } = ctx.use(adminModule);

    console.warn('\nSeeded users (all share one password):');
    console.warn(`  password: ${password}`);
    for (const org of orgs) {
      console.warn(`  ${org.slug.padEnd(12)} owner: ${org.owner.email}`);
    }
    console.warn(
      `  (${String(users.length)} accounts total, @${users[0]?.email.split('@')[1] ?? ''})`,
    );
    /* The console has no nav link until someone IS an operator — this is the
       only place a fresh database says who that is. */
    console.warn(`  platform operator: ${operator.email}`);

    console.warn('\nDone.');
  } finally {
    await connection.end();
  }
}

/**
 * Fields a `pg` error carries that say WHY Postgres refused, all absent from
 * the message. `constraint` alone is usually the whole answer.
 */
const PG_ERROR_FIELDS = [
  'code',
  'detail',
  'hint',
  'constraint',
  'table',
  'schema',
  'column',
  'where',
  'routine',
] as const;

/**
 * Prints the cause chain, not just the top error.
 *
 * Drizzle wraps every driver failure in an error whose message is the SQL and
 * the bound parameters, and puts the driver's own error on `cause`. `.stack`
 * does not include a cause, so the seed's failures printed a hundred lines of
 * statement and parameters and NOT the one line saying what Postgres objected
 * to — which turns "read the error" into an afternoon of inference from the
 * database's after-state. `console.error(error)` would render the chain via
 * `util.inspect`, but it also re-prints the whole wrapped query per level; the
 * pg fields below are the part worth reading.
 */
function reportFailure(error: unknown): void {
  console.error(error instanceof Error ? (error.stack ?? error.message) : describe(error));

  let cause: unknown = error instanceof Error ? error.cause : undefined;
  for (let depth = 0; depth < 5 && cause !== null && cause !== undefined; depth += 1) {
    const record: Record<string, unknown> =
      typeof cause === 'object' ? (cause as Record<string, unknown>) : {};

    console.error(`\ncaused by: ${describe(record['message'] ?? cause)}`);
    for (const field of PG_ERROR_FIELDS) {
      const value = record[field];
      if (value !== undefined && value !== null) console.error(`  ${field}: ${describe(value)}`);
    }
    cause = record['cause'];
  }
}

/** Anything printable, without an object silently becoming `[object Object]`. */
function describe(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value) ?? 'unknown';
}

main().catch((error: unknown) => {
  reportFailure(error);
  process.exit(1);
});
