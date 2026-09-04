import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  closeDatabase,
  eq,
  initializePlatformAdminDatabase,
  schema,
  withPlatformAdminScope,
} from '@taskflow/db';
import { unsafeAsId, type PaymentProvider, type RequestId, type UserId } from '@taskflow/contracts';
import { newId } from '@taskflow/security';
import { FakePaymentProvider, StripePaymentProvider } from '@taskflow/payments';
import {
  createPlan,
  updatePlan,
  setPrice,
  listPlans,
  type PlanCatalogDeps,
} from '@taskflow/api/platform-admin/plan-catalog';
import { InMemoryEventBus } from '@taskflow/events';
import { FLAG_NAMES } from '@taskflow/feature-flags';
import { CATALOG } from './modules/billing.catalog.js';

/**
 * The shape `createPlan`/`updatePlan`/`setPrice`/`listPlans` all expect as
 * their `operator` argument. Not imported from `plan-catalog.service.ts`'s
 * own sibling `org-directory.service.ts` — `@taskflow/api`'s package.json
 * `exports` map only opens `./platform-admin/plan-catalog`, and widening it
 * for one type this file can trivially restate structurally is not worth
 * the new export surface. `billing.catalog.ts`'s own `actor` object relies
 * on the identical structural match with no import at all.
 */
interface PlatformOperator {
  readonly userId: UserId;
  readonly requestId: RequestId;
}

/**
 * Reconciles `billing.plans` to `CATALOG` (`modules/billing.catalog.ts`)
 * against ANY database, production included — the tool `--reseed-plans`
 * (`cli.ts`) is deliberately not: that flag runs through the full fixture
 * graph (`resolveModules` walking `catalogModule`'s `requires` chain up
 * through `platform.admin`/`identity.users`), which seeds a bootstrap
 * operator and demo flag overrides (`platform.admin.ts`'s own `OVERRIDES` —
 * `automation: true`, unconditionally, on every run with an operator
 * configured) alongside whatever it was asked for. Fine for a throwaway
 * local database; not something to run against a real one.
 *
 * This script touches nothing but `billing.plans` and `billing.plan_prices`,
 * through the exact same `createPlan`/`updatePlan`/`setPrice` the console's
 * Plans tab calls — same feature-registry validation, same audited
 * operator-log entry, same domain event. The one thing it does differently
 * from `billing.catalog.ts`'s own seed step: pricing is reconciled ONLY when
 * the amount actually differs from what's current. `setPrice` archives the
 * current price and mints a new one unconditionally — correct for the
 * fixture seeder (a fake processor, discarded on `--reset`) and wrong here,
 * where a live Stripe account would grow a fresh, real Price object on every
 * idempotent re-run even when nothing changed.
 *
 * `pnpm --filter @taskflow/seed plans:reconcile --operator-email you@co.com [--dry-run]`
 */

const here = dirname(fileURLToPath(import.meta.url));

/* Load the repo-root .env, exactly as cli.ts does — a process entry point
   reads env before any validated config can exist (the guardrail-7 CLI
   exemption). */
const envFile = resolve(here, '..', '..', '..', '.env');
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

interface Args {
  readonly operatorEmail: string;
  readonly dryRun: boolean;
  readonly yes: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  let operatorEmail: string | undefined;
  let dryRun = false;
  let yes = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    switch (arg) {
      case '--operator-email': {
        const value = argv[i + 1];
        if (!value) throw new Error('--operator-email needs a value.');
        operatorEmail = value;
        i += 1;
        break;
      }
      case '--dry-run':
        dryRun = true;
        break;
      case '--yes':
        yes = true;
        break;
      default:
        throw new Error(
          `Unknown argument "${arg}". Usage: --operator-email <email> [--dry-run] [--yes]`,
        );
    }
  }

  if (!operatorEmail) {
    throw new Error(
      'This tool writes to the live plan catalog and attributes every change to a real ' +
        'operator account — pass --operator-email <email> naming one that already exists ' +
        'in platform.operators. There is no default; a maintenance script must not guess ' +
        'who is running it.',
    );
  }

  return { operatorEmail, dryRun, yes };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is not set. Copy .env.example to .env, or export it directly.`);
    process.exit(1);
  }
  return value;
}

/**
 * Same decision `cli.ts`'s own `assertSafeToSeed` makes for the fixture
 * seeder — the host is the honest signal a database is this machine's own,
 * and anything else needs an operator to say so out loud rather than by
 * accident. Unlike the fixture seeder, this tool is MEANT to run against a
 * remote database (that is the whole reason it exists) — so the gate here is
 * `--yes`, not an env var refusal, and it only guards the WRITE path:
 * `--dry-run` against a remote host needs no confirmation at all.
 */
function isLocalHost(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    host = '';
  }
  return ['localhost', '127.0.0.1', '::1', '', 'host.docker.internal'].includes(host);
}

function buildPayments(): PaymentProvider {
  const secretKey = process.env['STRIPE_SECRET_KEY'];
  if (process.env['PAYMENTS_PROVIDER'] !== 'stripe' || !secretKey) {
    console.warn(
      'plans:reconcile: no live Stripe key configured (PAYMENTS_PROVIDER=stripe + ' +
        'STRIPE_SECRET_KEY) — using the in-memory processor. Fine for a dev database; a ' +
        'production catalog needs the real key so prices resolve to real Stripe objects.',
    );
    return new FakePaymentProvider();
  }
  console.warn(
    'plans:reconcile: PAYMENTS_PROVIDER=stripe — repricing (when it happens) will create a ' +
      'real Stripe Price in the account that key belongs to.',
  );
  return new StripePaymentProvider({ secretKey });
}

async function resolveOperator(operatorEmail: string): Promise<PlatformOperator> {
  const row = await withPlatformAdminScope(async (tx) => {
    const users = await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.emailNormalized, operatorEmail.trim().toLowerCase()))
      .limit(1);
    const user = users[0];
    if (!user) return null;

    const grants = await tx
      .select({ userId: schema.operators.userId })
      .from(schema.operators)
      .where(eq(schema.operators.userId, user.id))
      .limit(1);
    return grants[0] === undefined ? null : user;
  });

  if (row === null) {
    throw new Error(
      `"${operatorEmail}" is not a registered platform operator (no matching row in ` +
        'platform.operators). Only an operator may change the plan catalog — grant the ' +
        'account operator status first, the same one-off script/migration path every other ' +
        'operator grant in this codebase uses (§7 decision 7).',
    );
  }

  return { userId: unsafeAsId<'UserId'>(row.id), requestId: newId<'RequestId'>() };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const platformAdminUrl = requireEnv('DATABASE_PLATFORM_ADMIN_URL');

  /* The same defensive check cli.ts's requireMigrationUrl makes for its own
     role: a connection string is easy to copy from the wrong .env line, and
     the failure mode of getting this one wrong is silent — every write below
     goes through withPlatformAdminScope, which just fails on a permission
     error far from here rather than naming the actual mistake. */
  if (!platformAdminUrl.includes('taskflow_platform_admin:')) {
    console.error(
      'DATABASE_PLATFORM_ADMIN_URL does not name the taskflow_platform_admin role. This tool ' +
        'writes through withPlatformAdminScope, which only that role may do.',
    );
    process.exit(1);
  }

  initializePlatformAdminDatabase({
    url: platformAdminUrl,
    applicationName: 'taskflow-plans-reconcile',
  });

  const remote = !isLocalHost(platformAdminUrl);
  if (remote && !args.dryRun && !args.yes) {
    console.error(
      `Refusing to write to a database on a non-local host: re-run with --yes once you've ` +
        'confirmed this is the database you mean to change, or --dry-run to preview first ' +
        'with no confirmation needed.',
    );
    process.exit(1);
  }

  try {
    const operator = await resolveOperator(args.operatorEmail);
    const deps: PlanCatalogDeps = { events: new InMemoryEventBus(), payments: buildPayments() };

    const unknown = CATALOG.flatMap((tier) =>
      tier.features.filter((flag) => !FLAG_NAMES.includes(flag)),
    );
    if (unknown.length > 0) {
      throw new Error(
        `Unknown feature flag(s) in CATALOG: ${unknown.join(', ')}. Registered: ${FLAG_NAMES.join(', ')}.`,
      );
    }

    const existing = new Map((await listPlans(deps, operator)).map((plan) => [plan.id, plan]));

    let created = 0;
    let updated = 0;
    let unchanged = 0;
    let repriced = 0;

    for (const tier of CATALOG) {
      const current = existing.get(tier.id);

      if (current === undefined) {
        console.warn(`${args.dryRun ? '[dry run] would create' : 'creating'}: ${tier.id}`);
        if (!args.dryRun) {
          await createPlan(deps, operator, {
            id: tier.id,
            name: tier.name,
            description: tier.description,
            sortOrder: tier.sortOrder,
            features: [...tier.features],
            withProduct: tier.withProduct,
            ...tier.limits,
          });
        }
        created += 1;
      } else {
        if (args.dryRun) {
          const featuresDiffer =
            JSON.stringify([...tier.features].sort()) !==
            JSON.stringify([...current.features].sort());
          const limitsDiffer =
            current.telephonyCapCents !== tier.limits.telephonyCapCents ||
            current.automationRunsPerHour !== tier.limits.automationRunsPerHour ||
            current.turnIssuancePerDay !== tier.limits.turnIssuancePerDay ||
            current.telephonyIncludedCents !== tier.limits.telephonyIncludedCents ||
            current.telephonyMarkupPct !== tier.limits.telephonyMarkupPct;
          if (featuresDiffer || limitsDiffer) {
            console.warn(
              `[dry run] would update: ${tier.id}` +
                (featuresDiffer ? ` — features -> [${tier.features.join(', ')}]` : '') +
                (limitsDiffer ? ' — limits changed' : ''),
            );
            updated += 1;
          } else {
            unchanged += 1;
          }
        } else {
          await updatePlan(deps, operator, {
            planId: tier.id,
            name: tier.name,
            description: tier.description,
            sortOrder: tier.sortOrder,
            features: [...tier.features],
            ...tier.limits,
          });
          console.warn(`reconciled: ${tier.id}`);
          updated += 1;
        }
      }

      /* Idempotent pricing — the deliberate difference from billing.catalog.ts's
         own seed step. See this file's header. */
      for (const [interval, amountCents] of [
        ['month', tier.monthlyCents],
        ['year', tier.annualCents],
      ] as const) {
        if (amountCents === null) continue;
        const currentPrice = current?.currentPrices.find((price) => price.interval === interval);
        if (currentPrice?.amountCents === amountCents) continue;

        console.warn(
          `${args.dryRun ? '[dry run] would reprice' : 'repricing'}: ${tier.id} (${interval}) ` +
            `${currentPrice ? `${String(currentPrice.amountCents)} -> ` : ''}${String(amountCents)}`,
        );
        if (!args.dryRun) {
          await setPrice(deps, operator, {
            planId: tier.id,
            interval,
            amountCents,
            currency: 'usd',
          });
        }
        repriced += 1;
      }
    }

    console.warn(
      `${args.dryRun ? 'Dry run complete' : 'Done'} — ${String(created)} created, ` +
        `${String(updated)} ${args.dryRun ? 'to update' : 'reconciled'}, ` +
        `${String(unchanged)} already correct, ${String(repriced)} price(s) ` +
        `${args.dryRun ? 'to change' : 'changed'}.`,
    );
  } finally {
    await closeDatabase();
  }
}

await main();
