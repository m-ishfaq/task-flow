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

  /** Liveness/readiness only. Nothing else is served on this port. */
  WORKER_PORT: z.coerce.number().int().positive().max(65_535).default(3003),

  /** How often the engine claims a batch from the outbox. */
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(250).max(60_000).default(2_000),
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
  'DATABASE_RECORDING_INGEST_URL',
  'DATABASE_SEARCH_URL',
  'DATABASE_POOL_MAX',
  'JWT_SECRET',
  'WEB_ORIGIN',
  'API_PORT',
  'API_TRUST_PROXY',
  'REALTIME_PORT',
  'REALTIME_POLL_INTERVAL_MS',
  'REALTIME_REAUTH_LEAD_SECONDS',
  'COLLAB_PORT',
  'WORKER_PORT',
  'WORKER_POLL_INTERVAL_MS',
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
      !KNOWN_VARIABLES.has(key) && (key.startsWith('WORKER_') || key.startsWith('DATABASE_')),
  );

  if (suspects.length > 0) {
    throw new Error(
      `Unrecognized TaskFlow environment variable(s): ${suspects.join(', ')}.\n` +
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
