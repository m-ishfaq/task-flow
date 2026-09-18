import { DEFAULT_PRODUCT_NAME } from '@taskflow/api/platform-admin/branding-cache';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/**
 * Validated environment for the background worker — guardrail 3.
 *
 * Same contract as `apps/api/src/config/env.ts` and `apps/realtime`'s: this
 * module is the one place in this app permitted to touch `process.env`,
 * everything else receives parsed values, and a misconfiguration fails at BOOT
 * with the variable named rather than surfacing as `undefined` inside a job.
 *
 * Its OWN schema rather than the API's, for the reason `apps/realtime`'s header
 * gives: the two processes need overlapping but different variables, and a
 * shared schema would mean the worker refusing to start over an unset
 * `STORAGE_BUCKET_EXPORTS` it will never read.
 *
 * ## Why this process exists at all
 *
 * `ai/phase-10-automation.md` §9 decision 1. The seven existing background
 * loops stay in `apps/api`; this process takes only NEW work — the automation
 * engine, webhook delivery, and (Phase 11) the analytics rollup refresh. The
 * engine evaluates rules per event, executes actions through the full service
 * layer, and makes outbound HTTP calls with retries, and Node runs all of that
 * on the same thread that serves requests. A slow webhook receiver must not
 * become a slow board for a user who has nothing to do with that rule.
 */

const NonEmpty = z.string().min(1);

/**
 * NOT `.strict()`, unlike most schemas in this codebase — and this note is here
 * because the mistake was made again on the way in.
 *
 * `process.env` carries a few hundred variables belonging to the OS, the shell,
 * and whatever launched the process. Rejecting unknown keys means the worker
 * cannot start on any real machine: it dies listing PATH, HOME, SYSTEMROOT and
 * two hundred others as "unrecognized".
 *
 * `apps/api/src/config/env.ts` already documents this happening to IT, in those
 * words, including that it survived "a unit test suite that fed it a tidy
 * fixture object". This file's first suite did exactly that, passed all five
 * assertions, and the process still failed on its first real boot. The
 * regression test is now `parses a realistic process.env-shaped object`, which
 * feeds the noise rather than the fixture — the only shape of that assertion
 * that fails if someone makes this strict again.
 *
 * The typo protection `.strict()` was reaching for is
 * `assertNoMisspelledVariables` below, which knows which names are ours.
 */
export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  /* The ORDINARY application role. Every action an automation performs runs
     through it, under RLS, inside `withOrgScope` — the same role and the same
     service functions a human action uses. There is deliberately no privileged
     path for the engine to write a card. */
  DATABASE_URL: NonEmpty,
  DATABASE_POOL_MAX: z.coerce.number().int().positive().max(100).default(10),

  /* The automation consumer's CLAIM role. Optional, and the pattern is
     `DATABASE_BACKLINKS_URL`/`DATABASE_SEARCH_URL`'s: a deployment without it
     is valid — the process still serves health and runs whatever else it is
     given — and what must never happen silently is the narrow claim grant being
     bypassed by a fallback to the application role. The engine logs a warning
     and does not start when this is unset. */
  DATABASE_AUTOMATION_URL: NonEmpty.optional(),

  /* The webhook delivery loop's CLAIM role (migration 0049). Same contract as
     DATABASE_AUTOMATION_URL: optional, and the loop declines to start when
     unset rather than falling back to a role that cannot claim across orgs. */
  DATABASE_WEBHOOK_URL: NonEmpty.optional(),

  /* The billing sweep's CLAIM role (migration 0060, Phase 12 Wave 3 §3.4).
     Same contract as the two above: optional, and the sweep declines to
     start when unset rather than falling back to a role that cannot scan
     identity.orgs across every tenant. */
  DATABASE_BILLING_SWEEP_URL: NonEmpty.optional(),

  /* The operations dashboard's writer (migration 0061) — this process's own
     connection as taskflow_ops_events, for the sweep's heartbeat row.
     Optional, same convention: recordOperationalEvent() catches the
     missing-connection error itself, so an instance without this simply
     gets no heartbeat rows rather than a sweep that fails to run. */
  DATABASE_OPS_EVENTS_URL: NonEmpty.optional(),

  /* The AUDIT role's connection (Phase 11). The analytics rollup refresh needs
     to enumerate every tenant, and identity.orgs admits no such read for the
     app role (migration 0004) — migration 0037 grants taskflow_audit an
     explicit read of (id, status). Optional, same contract as the claim pools:
     without it the analytics refresh loop declines to start (it could not
     discover orgs) rather than falling back to a role that would find none. */
  DATABASE_AUDIT_URL: NonEmpty.optional(),

  /* The grace period a past_due org gets before the sweep cancels it — the
     SAME value apps/api's env schema validates, duplicated here rather than
     imported because the two processes' env schemas are deliberately
     independent (this file's own header). Defaults match apps/api's. */
  BILLING_PAST_DUE_GRACE_DAYS: z.coerce.number().int().positive().default(7),

  /* There is deliberately NO BILLING_DEFAULT_PLAN_ID. Which plan an expiring
     trial lands on is `billing.plans.is_default` — one row, enforced by a
     partial unique index, moved by the console's own button. An env var
     naming the same plan would be a second source of truth that can silently
     disagree with the first, and the disagreement is invisible: trials would
     land somewhere every screen says they should not. */

  /**
   * How long before a trial ends the owner is warned.
   *
   * The warning is sent once per trial, keyed on the trial's own end date, so
   * a wide window here does not mean repeated email — it means the warning
   * goes out earlier. 72 hours is enough to notice on a Monday for a Thursday
   * deadline.
   */
  BILLING_TRIAL_ENDING_WARNING_HOURS: z.coerce.number().int().positive().default(72),

  /* The payment processor, for the period-close job that bills usage overage
     (Phase 12 Wave 4 §3.8). The SAME variables apps/api validates, duplicated
     here rather than imported for this file's stated reason — but note the
     consequence of them disagreeing: an API on `stripe` and a worker left on
     `fake` would take real money at checkout and record every tenant's
     overage against an in-memory map that vanishes at restart. `fake` is
     still the default, because a worker that refused to boot without Stripe
     credentials would stop automation and webhook delivery over a billing
     variable.

     The credential itself is optional here for the same reason as in
     apps/api: a `fake` deployment needs none of it, so the refusal belongs
     where something was actually asked to be live. */
  PAYMENTS_PROVIDER: z.enum(['fake', 'stripe']).default('fake'),
  STRIPE_SECRET_KEY: NonEmpty.optional(),

  /* The master key pair. Required, because this process decrypts webhook
     signing secrets at delivery — a deployment that runs the worker runs the
     loop that signs requests, and a worker without the key could not do its
     one new job. Same variables the API validates. */
  MASTER_KEY_ID: NonEmpty,
  MASTER_KEY_BASE64: NonEmpty,

  /** Liveness/readiness only. Nothing else is served on this port. */
  WORKER_PORT: z.coerce.number().int().positive().max(65_535).default(3003),

  /** How often the engine claims a batch from the outbox. */
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(250).max(60_000).default(2_000),

  /* Trial/grace deadlines are day-granularity, not seconds — a slower,
     dedicated interval, rather than reusing WORKER_POLL_INTERVAL_MS, so
     tightening the outbox poll for latency reasons never accidentally
     multiplies how often this sweep scans every tenant's orgs. */
  WORKER_BILLING_SWEEP_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(3_600_000)
    .default(60_000),

  /* How often the analytics rollups are recomputed from card_transitions
     (Phase 11 §6). A full per-org recompute, so it is latency-insensitive and
     runs on its own slow interval like the billing sweep — five minutes by
     default, well short of the six-second dashboards-are-stale threshold §6
     tolerates. */
  WORKER_ANALYTICS_REFRESH_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(3_600_000)
    .default(300_000),

  /* ------------------------------------------------------------------ *
   * Automation telephony (Phase 10 Wave 4, ai/phase-10-automation.md §5.5)
   * ------------------------------------------------------------------ */

  /* Whether the cost-bearing automation actions may EXECUTE here. Default
     false, parsed from the literal string (the `RETENTION_SWEEP_ENABLED`
     lesson — `z.coerce.boolean()` would treat `=false` as true).

     The same flag the API validates gates the BUILDER — the actions cannot
     even be saved while it is off. This second copy is the execution-time
     half: a rule saved while the flag was on must not run after the
     deployment turns it off, and the refusal lands in run history with a
     reason rather than happening somewhere silently. Off-by-default means
     this process builds no telephony provider and imports nothing heavy it
     does not need. */
  AUTOMATION_TELEPHONY_ACTIONS_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),

  /* The carrier and gate configuration, needed ONLY to execute the actions
     above. Optional, and the pattern is the API's own: an unconfigured
     carrier is a valid deployment, and rules that use telephony fail with a
     recorded reason rather than the process refusing to boot. When the flag
     above is on, `buildTelephonyDeps` reads these — the same construction
     and the same validation (including `TELEPHONY_WEBHOOK_ORIGIN` being
     REQUIRED for a live carrier) the API applies, so a rule's call goes
     through the identical chokepoint a human's does. */
  TWILIO_ACCOUNT_SID: NonEmpty.optional(),
  TWILIO_AUTH_TOKEN: NonEmpty.optional(),
  TWILIO_VERIFY_SERVICE_SID: NonEmpty.optional(),
  TELEPHONY_INDEX_KEY: NonEmpty.optional(),
  TELEPHONY_WEBHOOK_ORIGIN: z.string().url().optional(),
  TELEPHONY_DEFAULT_SPEND_CAP_CENTS: z.coerce.number().int().nonnegative().default(2500),
  TELEPHONY_MAX_SPEND_CAP_CENTS: z.coerce.number().int().nonnegative().default(50_000),
});

export type Env = z.infer<typeof EnvSchema>;

/**
 * Variables a developer's `.env` legitimately carries that this process does
 * not read — mirrors `apps/realtime`'s and `apps/collab`'s sets, and exists for
 * the same reason: the misspelling check below has to know about them or it
 * would reject a correct setup.
 *
 * The schema's own keys are unioned in rather than listed a second time. A
 * variable THIS app validates cannot be a typo, so a hand-copied duplicate of
 * it is nothing but a way for the two lists to disagree — the lesson
 * `DATABASE_SEARCH_URL` taught when it was added to a schema, added to
 * `.env.example`, missed here, and then refused to boot naming a variable that
 * was spelled correctly.
 */
const KNOWN_VARIABLES = new Set([
  ...Object.keys(EnvSchema.shape),
  'NODE_ENV',
  'LOG_LEVEL',
  'DATABASE_URL',
  'DATABASE_AUDIT_URL',
  /* The migrator's connection. Not read here — migrations run as a pre-deploy
     step, never from an app process — but legitimately present in a
     developer's `.env`, and the first thing this warning flagged on the
     worker's first successful boot. */
  'DATABASE_MIGRATION_URL',
  'DATABASE_REALTIME_URL',
  'DATABASE_COLLAB_URL',
  'DATABASE_BACKLINKS_URL',
  'DATABASE_NOTIFICATION_SWEEP_URL',
  'DATABASE_PLATFORM_ADMIN_URL',
  'DATABASE_API_TOKEN_URL',
  'DATABASE_RECORDING_INGEST_URL',
  'DATABASE_INTEGRATION_URL',
  'DATABASE_SEARCH_URL',
  'DATABASE_WEBHOOK_URL',
  'DATABASE_POOL_MAX',
  'JWT_PRIVATE_KEY',
  'JWT_PUBLIC_KEY',
  'JWT_STATE_SECRET',
  'MASTER_KEY_ID',
  'MASTER_KEY_BASE64',
  'WEB_ORIGIN',
  'API_PORT',
  'API_TRUST_PROXY',
  'REALTIME_PORT',
  'REALTIME_POLL_INTERVAL_MS',
  'REALTIME_REAUTH_LEAD_SECONDS',
  'COLLAB_PORT',
  'WORKER_PORT',
  'WORKER_POLL_INTERVAL_MS',
  /* Telephony (Phase 7 / Phase 10 Wave 4) — legitimately present in a
     developer's shared .env even when the worker has not been configured to
     place calls, and listed so the misspelling check below cannot reject a
     correctly-spelled variable this process simply does not act on. */
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_VERIFY_SERVICE_SID',
  'TELEPHONY_INDEX_KEY',
  'TELEPHONY_WEBHOOK_ORIGIN',
  'TELEPHONY_DEFAULT_SPEND_CAP_CENTS',
  'TELEPHONY_MAX_SPEND_CAP_CENTS',
]);

/**
 * Validates an arbitrary source, throwing with every failing variable named.
 *
 * Separate from `loadEnv` so it is testable without mutating `process.env` —
 * the shape `apps/api/src/config/env.ts` already uses, and the reason its own
 * env suite can assert on bounds and defaults at all.
 */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid worker environment:\n${detail}`);
  }
  return parsed.data;
}

/** Loads and validates the real environment, or throws naming the variable. */
export function loadEnv(): Env {
  loadDotEnvIfPresent();
  assertNoMisspelledVariables(process.env);
  return parseEnv(process.env);
}

/**
 * Rejects a variable that looks like ours but is not one of ours.
 *
 * THROWS, matching `apps/api`, `apps/realtime` and `apps/collab` verbatim. The
 * first version of this file only warned, which was an inconsistency
 * introduced by this app rather than a considered difference — and the wrong
 * side of it: the failure being prevented is `MASTER_KEY_BASE_64` set instead
 * of `MASTER_KEY_BASE64`, where the real variable is therefore unset and
 * something is running on a default it should not be. A warning scrolls past
 * in a boot log; that is precisely the outcome this check exists to prevent.
 *
 * Scoped to our own prefixes rather than to everything, because "everything"
 * includes the operating system — the schema is deliberately not `.strict()`
 * for the same reason (see its own comment).
 */
export function assertNoMisspelledVariables(source: Record<string, string | undefined>): void {
  const suspects = Object.keys(source).filter(
    (key) =>
      !KNOWN_VARIABLES.has(key) &&
      (key.startsWith('WORKER_') ||
        key.startsWith('DATABASE_') ||
        /* Phase 10 Wave 4: this process now reads telephony configuration, so
           a misspelled TWILIO_/TELEPHONY_/AUTOMATION_ variable is as much
           "ours" as a misspelled WORKER_ one — the API's own check catches it
           for ITS schema, but the worker is a second place the typo is made. */
        key.startsWith('TWILIO_') ||
        key.startsWith('TELEPHONY_') ||
        key.startsWith('AUTOMATION_')),
  );

  if (suspects.length > 0) {
    throw new Error(
      `Unrecognized ${DEFAULT_PRODUCT_NAME} environment variable(s): ${suspects.join(', ')}.\n` +
        'Check the spelling against .env.example — a near-miss name means the real\n' +
        'variable is unset and something is running on a default it should not be.',
    );
  }
}

/** Reads the repo-root `.env` in development, exactly as the other apps do. */
function loadDotEnvIfPresent(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const envFile = resolve(here, '..', '..', '..', '..', '.env');
  if (existsSync(envFile)) {
    process.loadEnvFile(envFile);
  }
}
