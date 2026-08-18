import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeAuditDatabase, initializePlatformAdminDatabase } from '@taskflow/db';
import { connectAsMigrator } from '@taskflow/db/testing';
import { S3StorageProvider } from '@taskflow/storage';
import { FakePaymentProvider, StripePaymentProvider } from '@taskflow/payments';
import { TwilioTelephonyProvider } from '@taskflow/telephony';
import { masterKeysFromBase64, SoftwareKeyProvider } from '@taskflow/security';
import type { KeyProvider, PaymentProvider, StorageProvider } from '@taskflow/contracts';
import {
  createSeedContext,
  type PlatformOperatorSeedConfig,
  type TelephonySeedConfig,
} from './context.js';
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
import { catalogModule } from './modules/billing.catalog.js';
import { subscriptionsModule } from './modules/billing.subscriptions.js';
import { apiTokensModule } from './modules/platform.api-tokens.js';
import { webhooksModule } from './modules/platform.webhooks.js';

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
      '  --profile <name>   minimal | demo (default) | large | marketing | showcase',
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

  /* Of the three guards here, only NODE_ENV actually discriminates a
     production database — and nothing in compose.prod.yaml's one-shot jobs
     sets it. The role check only refuses `taskflow_app` (seeding legitimately
     runs as the migrator), and the name check only refuses a `_test` suffix (a
     production database is called `taskflow`). So a single unset environment
     variable stood between `pnpm seed` and writing fixtures into a live
     tenant.

     The host is the honest signal: a development database is on this machine.
     Anything else needs the operator to say so out loud, which is a thing you
     cannot do by accident. */
  let host: string;
  try {
    host = new URL(migrationUrl).hostname;
  } catch {
    host = '';
  }

  const isLocal = ['localhost', '127.0.0.1', '::1', '', 'host.docker.internal'].includes(host);
  if (!isLocal && process.env['SEED_I_MEAN_IT'] !== '1') {
    console.error(
      `Refusing to seed a database on "${host}": that is not this machine.\n` +
        'This script writes fixture organizations, users and messages. If you really\n' +
        'mean to seed a remote database, re-run with SEED_I_MEAN_IT=1.',
    );
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

/**
 * The processor the plan catalog is seeded through.
 *
 * `fake` unless `PAYMENTS_PROVIDER=stripe` AND a key is present — the same
 * explicit switch `apps/api` uses, deliberately not credential-sniffed.
 *
 * ## The warning is the point
 *
 * Seeding the catalog runs the REAL `createPlan`/`setPrice` service functions
 * — that is what makes the seeded catalog identical to one an operator built
 * by hand, rather than a set of rows that merely look like it. Against a live
 * key those functions do exactly what they do in production: create Products
 * and Prices in that Stripe account, on every run, accumulating.
 *
 * That is a side effect on somebody else's system, reached by typing
 * `pnpm seed`, so it is announced before it happens rather than discovered in
 * a Stripe dashboard later. `SEED_PAYMENTS=fake` forces the fake regardless
 * of how the rest of the environment is configured, which is the escape hatch
 * for a developer whose `.env` points at a shared test account.
 */
function buildPayments(): PaymentProvider {
  if (process.env['SEED_PAYMENTS'] === 'fake') {
    console.warn('billing.catalog: SEED_PAYMENTS=fake — using the in-memory processor.');
    return new FakePaymentProvider();
  }

  const secretKey = process.env['STRIPE_SECRET_KEY'];
  if (process.env['PAYMENTS_PROVIDER'] !== 'stripe' || !secretKey) {
    return new FakePaymentProvider();
  }

  console.warn(
    'billing.catalog: PAYMENTS_PROVIDER=stripe — this run will CREATE REAL Stripe Products and\n' +
      '  Prices in the account that key belongs to, and will do so again on every subsequent run.\n' +
      '  Set SEED_PAYMENTS=fake to seed the catalog against the in-memory processor instead.',
  );
  return new StripePaymentProvider({ secretKey });
}

/**
 * The platform operator's login, or null to seed no operator at all.
 *
 * Both `SEED_PLATFORM_ADMIN_EMAIL` and `SEED_PLATFORM_ADMIN_PASSWORD` must be
 * set — the same all-or-nothing shape `buildTelephonySeedConfig` uses for its
 * four variables, so a half-configured pair fails the same way a fully absent
 * one does rather than seeding an account with an empty password. Unlike
 * every other `build*` function here, there is no fallback to a fixture
 * value: the account this seeds can suspend any organization and read a
 * global audit log, and `identity.users`'s own header explains why that must
 * never come from a hardcoded pair committed to the repository.
 */
function buildPlatformOperatorConfig(): PlatformOperatorSeedConfig | null {
  const email = process.env['SEED_PLATFORM_ADMIN_EMAIL'];
  const password = process.env['SEED_PLATFORM_ADMIN_PASSWORD'];
  if (!email || !password) return null;
  return { email, password };
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

/**
 * The carrier + key material `comms.telephony` needs, or null to skip it.
 *
 * Built here rather than in the module for the same reason `buildStorage` is:
 * guardrail 7 bans bare `process.env` outside a validated schema, and a CLI
 * entry point is the one exempted process boundary (`packages/config/eslint/
 * security.js`). The module receives a resolved object or nothing.
 *
 * FOUR things must all be present, and a missing one is a SKIP rather than an
 * error — a contributor with no Twilio account must still be able to seed
 * everything else:
 *
 *   - TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN, to ask the carrier which
 *     numbers the account actually holds.
 *   - MASTER_KEY_ID / MASTER_KEY_BASE64, because `comms.subaccounts` stores a
 *     genuinely wrapped data key and a placeholder there fails to unwrap the
 *     first time real code reads it.
 *   - TELEPHONY_INDEX_KEY, the blind-index key. Deliberately separate from
 *     the master key (see `counterparty.ts`): one compromise should not both
 *     decrypt the column and let an attacker generate indexes to confirm
 *     guesses against it.
 *
 * `isLive: false` is passed to the provider even against real credentials.
 * Nothing here places a call or buys anything — the only carrier method used
 * is the read-only `listOwnedNumbers` — and `isLive` is what a fixture would
 * assert on to prove no real spend occurred.
 */
function buildTelephonySeedConfig(): TelephonySeedConfig | null {
  const accountSid = process.env['TWILIO_ACCOUNT_SID'];
  const authToken = process.env['TWILIO_AUTH_TOKEN'];
  const masterKeyId = process.env['MASTER_KEY_ID'];
  const masterKeyBase64 = process.env['MASTER_KEY_BASE64'];
  const indexKeyBase64 = process.env['TELEPHONY_INDEX_KEY'];

  if (!accountSid || !authToken) return null;
  if (!masterKeyId || !masterKeyBase64 || !indexKeyBase64) return null;

  return {
    provider: new TwilioTelephonyProvider({
      accountSid,
      authToken,
      isLive: false,
    }),
    keys: new SoftwareKeyProvider({
      masterKeys: masterKeysFromBase64({ [masterKeyId]: masterKeyBase64 }),
      currentMasterKeyId: masterKeyId,
    }),
    indexKey: Buffer.from(indexKeyBase64, 'base64'),
  };
}

/**
 * The envelope-encryption master key the webhook module needs.
 *
 * Same env pair telephony uses (`MASTER_KEY_ID`/`MASTER_KEY_BASE64`), because
 * it is the same key: a per-webhook data key wrapped under this master is
 * unwrappable by the running application exactly when the application was
 * started with the same two variables. Null when unset — the webhook module
 * skips itself, exactly like telephony, never fakes a secret that would fail
 * the first unwrap.
 */
function buildKeysProvider(): KeyProvider | null {
  const masterKeyId = process.env['MASTER_KEY_ID'];
  const masterKeyBase64 = process.env['MASTER_KEY_BASE64'];

  if (!masterKeyId || !masterKeyBase64) return null;

  return new SoftwareKeyProvider({
    masterKeys: masterKeysFromBase64({ [masterKeyId]: masterKeyBase64 }),
    currentMasterKeyId: masterKeyId,
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

  /* `billing.catalog` calls the operator console's own service functions, and
     those run under `withPlatformAdminScope` — a pool of their own, as
     `taskflow_platform_admin`, which nothing initializes by default. Without
     this the catalog module throws "Platform-admin database not initialized"
     rather than seeding, and the seeder is one of the few sanctioned callers
     of that role (the same reasoning platform.admin.ts gives for writing
     `platform.operators` as the migrator). */
  const platformAdminUrl = process.env['DATABASE_PLATFORM_ADMIN_URL'];
  if (platformAdminUrl) {
    initializePlatformAdminDatabase({
      url: platformAdminUrl,
      applicationName: 'taskflow-seed',
    });
  } else {
    console.warn(
      'billing.catalog: DATABASE_PLATFORM_ADMIN_URL not set — the plan catalog will be skipped,\n' +
        '  so seeded orgs will have no plan to be on.',
    );
  }

  const platformOperator = buildPlatformOperatorConfig();
  if (!platformOperator) {
    console.warn(
      'platform.admin: SEED_PLATFORM_ADMIN_EMAIL/SEED_PLATFORM_ADMIN_PASSWORD not set — the\n' +
        '  platform operator will be skipped, so the seeded database will have no\n' +
        '  /platform-admin console access. Set both to seed one.',
    );
  }

  const connection = await connectAsMigrator({ url: migrationUrl });

  try {
    /* `billing.catalog` is a ROOT rather than a dependency of something else:
     nothing in the tenant graph requires it (an org's plan is written by
     `billing.subscriptions`, which does), and a module no root reaches is a
     module that silently never runs. */
    const roots = [auditModule, catalogModule, subscriptionsModule];

    if (args.reset) {
      await reset({
        connection,
        roots,
        platformOperatorEmail: platformOperator?.email ?? null,
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

    const telephony = buildTelephonySeedConfig();
    if (!telephony) {
      console.warn(
        'comms.telephony: TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN, MASTER_KEY_* or ' +
          'TELEPHONY_INDEX_KEY not set — telephony will be skipped.',
      );
    }

    const payments = buildPayments();
    const keys = buildKeysProvider();
    if (!keys) {
      console.warn(
        'platform.webhooks: MASTER_KEY_ID/MASTER_KEY_BASE64 not set — webhooks will be skipped.',
      );
    }

    const { ctx, record } = createSeedContext({
      connection,
      rng,
      profile,
      now: new Date(),
      chaos: args.chaos,
      storage,
      telephony,
      keys,
      payments,
      platformOperator,
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

    const { users, password, operatorPassword } = ctx.use(usersModule);
    const { orgs } = ctx.use(orgsModule);
    const { operator } = ctx.use(adminModule);

    console.warn('\nSeeded tenant users (all share one password):');
    console.warn(`  password: ${password}`);
    for (const org of orgs) {
      console.warn(`  ${org.slug.padEnd(12)} owner: ${org.owner.email}`);
    }
    console.warn(
      `  (${String(users.length)} accounts total, @${users[0]?.email.split('@')[1] ?? ''})`,
    );
    /* The console has no nav link until someone IS an operator — this is the
       only place a fresh database says who that is. Its own credentials, on
       their own lines, because reusing the shared demo password for the one
       account that can suspend any organization would put the console behind
       whatever password a demo audience was just shown. Absent entirely when
       `operator` is null — nothing was seeded, so nothing to print. */
    if (operator !== null && operatorPassword !== null) {
      console.warn('\nPlatform operator (separate credentials, belongs to NO org):');
      console.warn(`  email:    ${operator.email}`);
      console.warn(`  password: ${operatorPassword}`);
      console.warn('  sign in, then follow "Platform console" on the org picker.');
    }

    /* One-time secrets (Phase 10): the API token and the webhook signing
       secret exist in plaintext exactly once, at mint — the same rule the
       services follow. Printed here so a demo developer can copy them into a
       script or a test receiver instead of having to mint fresh ones. */
    const apiToken = ctx.use(apiTokensModule);
    const webhook = ctx.use(webhooksModule);
    if (apiToken.token !== null) {
      console.warn('\nSeeded API token (shown once, like a real mint):');
      console.warn(`  ${apiToken.token}`);
    }
    if (webhook.signingSecret !== null) {
      console.warn('\nSeeded webhook signing secret (shown once, like a real creation):');
      console.warn(`  ${webhook.signingSecret}`);
    }

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
  /* The `??` is load-bearing and ESLint reports it as unnecessary, because
     TypeScript's own lib declares `JSON.stringify` as returning `string`. It
     returns `undefined` for `undefined`, for a function, and for a symbol —
     all three of which reach this branch, since the parameter is `unknown`.
     Same shape as the TanStack Query guard in `login-page.tsx`: the type is
     wrong, not the code. */
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- see above: JSON.stringify is typed `string` but returns undefined for undefined/function/symbol
  return JSON.stringify(value) ?? 'unknown';
}

main().catch((error: unknown) => {
  reportFailure(error);
  process.exit(1);
});
