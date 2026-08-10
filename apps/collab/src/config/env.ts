import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/**
 * Validated environment for the collab gateway — guardrail 3.
 *
 * Deliberately its own schema, same reasoning `apps/realtime/src/config/env.ts`
 * gives for having its own rather than importing the API's: this process has
 * no mail, no storage, no ClamAV. TWO database variables, mirroring
 * `apps/realtime`'s own split: `DATABASE_URL` is the ORDINARY application
 * role — the `onAuthenticate` hook reads page and space metadata over it via
 * `withOrgScope`, identical to how `apps/realtime`'s `rooms.ts` loads a board
 * (ai/phase-6-docs.md §6.1, corrected on approval). `DATABASE_COLLAB_URL`
 * arrived with Wave 2's first migration (0024) as `taskflow_collab` — the
 * ONLY role with write access to `docs.yjs_updates` and `docs.page_versions`,
 * and the whole reason guardrail 8's "sockets never write" carve-out is
 * contained to this one small process.
 */

const NonEmpty = z.string().min(1);

const Base64Key = z.string().refine(
  (value) => {
    try {
      return Buffer.from(value, 'base64').length === 32;
    } catch {
      return false;
    }
  },
  { message: 'must be 32 bytes of base64-encoded key material' },
);

export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  /* The ORDINARY application role — see the file header. */
  DATABASE_URL: NonEmpty,
  DATABASE_POOL_MAX: z.coerce.number().int().positive().max(100).default(10),

  /* taskflow_collab, migration 0024 — INSERT/SELECT on docs.yjs_updates
     (plus DELETE for compaction's pruning) and INSERT/SELECT on
     docs.page_versions. Nothing else. */
  DATABASE_COLLAB_URL: NonEmpty,

  /* Same secret, issuer and audience the API signs with — this process is a
     second verifier of the same credential, not a third party, exactly as
     apps/realtime's JWT_SECRET note explains. */
  JWT_SECRET: Base64Key,

  COLLAB_PORT: z.coerce.number().int().positive().max(65_535).default(3002),
  COLLAB_HOST: z.string().default('0.0.0.0'),

  /* The allowed browser origin(s), checked at the handshake — identical
     control to apps/realtime's WEB_ORIGIN, and for the identical reason: a
     page loaded from anywhere else must never get far enough to present a
     token. Comma-separated so an apex + www deployment needs no second var. */
  WEB_ORIGIN: NonEmpty,
});

export type Env = z.infer<typeof EnvSchema>;

/**
 * Every TaskFlow variable this process's misspelling check needs to know
 * about — mirrors `apps/realtime`'s `KNOWN_VARIABLES`, scoped to what a
 * developer's `.env` legitimately carries that starts with a prefix this
 * schema cares about.
 *
 * `EnvSchema.shape` is unioned in for the reason the API's own set gives: a
 * variable this process validates itself cannot be a typo, so listing it twice
 * only creates a way for the two lists to disagree. The hand-written entries
 * are the ones no schema here knows about — every other service's.
 */
const KNOWN_VARIABLES = new Set([
  ...Object.keys(EnvSchema.shape),
  'NODE_ENV',
  'LOG_LEVEL',
  'DATABASE_URL',
  'DATABASE_MIGRATION_URL',
  'DATABASE_AUDIT_URL',
  'DATABASE_REALTIME_URL',
  /* This process's OWN write-exception role (migration 0024) — and the
     backlinks relay's claim role (migration 0025), which a developer's .env
     carries without this process reading it. Both start with `DATABASE_`, so
     the misspelling check claims them, and an unlisted one refuses to boot
     over a variable that is spelled perfectly correctly — which is exactly
     what happened to `DATABASE_COLLAB_URL` when it was added to the schema
     and to .env.example without this set being updated alongside. */
  'DATABASE_COLLAB_URL',
  'DATABASE_BACKLINKS_URL',
  /* The notification sweep's role (migration 0029), the platform-admin
     console's (migration 0035) and the recording-ingest sweep's (migration
     0033). Exactly the same class as the two above, and exactly the same
     failure they document: all three are spelled correctly, none is read
     here, and every one of them refused this process a boot until listed. */
  'DATABASE_NOTIFICATION_SWEEP_URL',
  'DATABASE_PLATFORM_ADMIN_URL',
  'DATABASE_RECORDING_INGEST_URL',
  /* The search indexer's claim role (Phase 8 Wave 2, migration 0045) — read by
     the API's relay, never here, and the fifth variable of this exact class to
     stop a correctly-configured process booting. */
  'DATABASE_SEARCH_URL',
  'DATABASE_POOL_MAX',
  'JWT_SECRET',
  'WEB_ORIGIN',
  /* apps/web's vite.config.ts reads these; no server does. Same reasoning as
     the API's identical note: the `WEB_` prefix makes the misspelling check
     claim them, and an unlisted one stops this process booting over a
     variable that is not misspelled at all. */
  'WEB_API_ORIGIN',
  'WEB_REALTIME_ORIGIN',
  'WEB_COLLAB_ORIGIN',
  /* apps/web's vite.config.ts `server.allowedHosts` — the hosts the dev
     server accepts besides localhost (tunnels such as ngrok). Same class
     as the three above. */
  'WEB_ALLOWED_HOSTS',
  'COLLAB_PORT',
  'COLLAB_HOST',
]);

const TASKFLOW_PREFIXES = ['DATABASE_', 'JWT_', 'WEB_', 'COLLAB_'];

/**
 * Rejects a variable that looks like ours but is not one of ours.
 *
 * Mirrors `apps/realtime`'s identical check — the failure it prevents is a
 * near-miss name (`COLLAB_PROT` instead of `COLLAB_PORT`) silently defaulting
 * rather than erroring, which reads as "the operator changed nothing" instead
 * of what actually happened.
 */
function assertNoMisspelledVariables(source: Record<string, string | undefined>): void {
  const suspects = Object.keys(source).filter(
    (key) =>
      !KNOWN_VARIABLES.has(key) && TASKFLOW_PREFIXES.some((prefix) => key.startsWith(prefix)),
  );

  if (suspects.length > 0) {
    throw new Error(
      `Unrecognized TaskFlow environment variable(s): ${suspects.join(', ')}.\n` +
        'Check the spelling against .env.example — a near-miss name means the real\n' +
        'variable is unset and something is running on a default it should not be.',
    );
  }
}

export function parseEnv(source: Record<string, string | undefined>): Env {
  assertNoMisspelledVariables(source);
  const result = EnvSchema.safeParse(source);

  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');

    throw new Error(`Invalid environment:\n${detail}`);
  }
  return result.data;
}

/** Reads the real environment, loading a repo-root `.env` first if one exists. */
export function loadEnv(): Env {
  const here = dirname(fileURLToPath(import.meta.url));
  const envFile = resolve(here, '..', '..', '..', '..', '.env');

  if (existsSync(envFile)) {
    process.loadEnvFile(envFile);
  }
  return parseEnv(process.env);
}

/** The origins a connection may come from. Same parsing rule as apps/realtime. */
export function allowedOrigins(env: Env): readonly string[] {
  return env.WEB_ORIGIN.split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}
