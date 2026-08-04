import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/**
 * Validated environment — guardrail 7 (PLAN.md §2.1, §8.7).
 *
 * The rest of the workspace is forbidden by lint from touching `process.env`.
 * Everything arrives through this schema, so a missing or malformed variable
 * fails at BOOT with a message naming the variable, rather than surfacing as
 * `undefined` inside a request handler three weeks later — which is how a
 * misconfigured signing key becomes an authentication bypass instead of a crash.
 */

const NonEmpty = z.string().min(1);

/** 32 bytes, base64. Rejecting a short key here beats an AES error at runtime. */
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

/**
 * How far to trust `X-Forwarded-For`.
 *
 * The default is `false`, and that default is the point. Fastify's `trustProxy:
 * true` — which this app previously hardcoded — means the client address is
 * whatever the leftmost entry of a caller-supplied header says it is. Every
 * per-IP rate limit then becomes opt-out (send a fresh `X-Forwarded-For` per
 * request and each one is a new address), and every audit entry records an
 * attacker-chosen origin.
 *
 * Accepted forms:
 *   false           no proxy — `request.ip` is the socket address
 *   <n>             trust exactly n hops, counted from the right
 *   <cidr>,<cidr>   trust these proxy addresses
 *
 * `true` is rejected on purpose: there is no deployment it is correct for that a
 * hop count does not also cover, and the error is cheaper than the silent
 * disabling of a control.
 */
const TrustProxy = z
  .string()
  .default('false')
  .superRefine((value, ctx) => {
    if (value.trim() === 'true') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'API_TRUST_PROXY=true trusts an X-Forwarded-For header from anyone, which makes every ' +
          'per-IP rate limit opt-out. Use a hop count (e.g. 1) or a CIDR list instead.',
      });
    }
  })
  .transform((value): boolean | number | string => {
    const trimmed = value.trim();
    if (trimmed === '' || trimmed === 'false') return false;
    if (/^\d+$/.test(trimmed)) return Number(trimmed);
    return trimmed;
  });

export const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

    /* Two URLs, never one. taskflow_app cannot bypass RLS and has no DDL
       rights; collapsing them would hand the runtime role the ability to drop
       its own RLS policies (§8.3). */
    DATABASE_URL: NonEmpty,
    DATABASE_POOL_MAX: z.coerce.number().int().positive().max(100).default(10),

    /* A THIRD role, for the audit projection (§8.6). taskflow_audit holds
       INSERT and SELECT on audit.audit_log and no UPDATE or DELETE anywhere, so
       the compliance record cannot be rewritten even by the process that writes
       it.

       Optional, and the consequence of omitting it is deliberately loud rather
       than silent: `withAuditScope` throws instead of falling back to the
       application role, which could not write an audit entry anyway. An API
       instance that only serves requests does not need it; the one running the
       outbox relay does. */
    DATABASE_AUDIT_URL: NonEmpty.optional(),

    MASTER_KEY_ID: NonEmpty,
    MASTER_KEY_BASE64: Base64Key,
    JWT_SECRET: Base64Key,

    /* Mail (§8.1). Mailpit locally, a real provider in deployed environments.
       Verification and reset links are the credential for the flow that issues
       them, so delivery is not a "nice to have" that can be stubbed out — an
       unset MAIL_HOST must fail at boot, not at the first signup. */
    MAIL_HOST: NonEmpty,
    MAIL_PORT: z.coerce.number().int().positive().max(65_535).default(1025),
    MAIL_SECURE: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    MAIL_FROM: NonEmpty,

    /* Object storage (§5, §8.4). MinIO locally, Cloudflare R2 on the free tier,
       S3 past 10 GB — all three speak the same API, so only these values
       change.

       Required rather than optional, for the same reason as MAIL_HOST: an
       attachment upload that fails at presign time because a bucket name was
       never set is a broken feature discovered by a user, where an unset
       variable is a boot failure discovered by whoever deployed it. */
    STORAGE_ENDPOINT: NonEmpty,
    STORAGE_REGION: z.string().default('us-east-1'),
    STORAGE_ACCESS_KEY_ID: NonEmpty,
    STORAGE_SECRET_ACCESS_KEY: NonEmpty,
    STORAGE_BUCKET_ATTACHMENTS: NonEmpty,
    STORAGE_BUCKET_EXPORTS: NonEmpty,
    /* Path-style addressing. Required by MinIO, which has no per-bucket DNS;
       R2 and S3 accept either. Defaults to true because the local stack is the
       one a developer runs without setting anything. */
    STORAGE_FORCE_PATH_STYLE: z
      .enum(['true', 'false'])
      .default('true')
      .transform((value) => value === 'true'),

    /* Largest attachment accepted, in bytes. Pinned into the upload signature
       and used as the ceiling on the server-side read during scanning, so it
       bounds memory as well as storage. */
    STORAGE_MAX_UPLOAD_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .max(500 * 1024 * 1024)
      .default(25 * 1024 * 1024),

    /* Virus scanning (§8.4). An attachment is not downloadable until clamd has
       looked at it, and an unreachable scanner fails CLOSED — so these being
       wrong makes uploads stop working, which is the correct direction for a
       misconfiguration to fail in. */
    CLAMAV_HOST: z.string().default('localhost'),
    CLAMAV_PORT: z.coerce.number().int().positive().max(65_535).default(3310),

    API_PORT: z.coerce.number().int().positive().max(65_535).default(3000),
    API_HOST: z.string().default('0.0.0.0'),
    API_TRUST_PROXY: TrustProxy,
    WEB_ORIGIN: z.string().url(),
  })
  /* NOT `.strict()`, unlike every other schema in this codebase.

     `process.env` carries a few hundred variables belonging to the OS, the
     shell, and whatever launched the process. Rejecting unknown keys here means
     the API cannot start on any real machine — which is exactly what happened
     the first time this was booted, after a unit test suite that fed it a tidy
     fixture object had passed. The typo protection that `.strict()` was reaching
     for is provided by `assertNoMisspelledVariables` below, which knows which
     names are ours. */
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && env.MASTER_KEY_BASE64 === env.JWT_SECRET) {
      // Reusing one secret for two purposes means compromising either
      // compromises both, and key rotation stops being independent.
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'MASTER_KEY_BASE64 and JWT_SECRET must be different values.',
      });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

/**
 * Every TaskFlow environment variable, across ALL services — not just the ones
 * this app reads.
 *
 * Kept in sync with .env.example. The API does not consume the storage or mail
 * settings, but they are legitimately present in a developer's environment, so
 * the misspelling check has to know about them or it would reject a correct
 * setup.
 */
const KNOWN_VARIABLES = new Set([
  'NODE_ENV',
  'LOG_LEVEL',
  'DATABASE_URL',
  'DATABASE_MIGRATION_URL',
  'DATABASE_AUDIT_URL',
  'DATABASE_POOL_MAX',
  'STORAGE_ENDPOINT',
  'STORAGE_REGION',
  'STORAGE_ACCESS_KEY_ID',
  'STORAGE_SECRET_ACCESS_KEY',
  'STORAGE_BUCKET_ATTACHMENTS',
  'STORAGE_BUCKET_EXPORTS',
  'STORAGE_FORCE_PATH_STYLE',
  'STORAGE_MAX_UPLOAD_BYTES',
  'CLAMAV_HOST',
  'CLAMAV_PORT',
  'MAIL_HOST',
  'MAIL_PORT',
  'MAIL_SECURE',
  'MAIL_FROM',
  'MASTER_KEY_ID',
  'MASTER_KEY_BASE64',
  'JWT_SECRET',
  'API_PORT',
  'API_HOST',
  'API_TRUST_PROXY',
  'WEB_ORIGIN',
]);

/**
 * Prefixes that mark a variable as ours.
 *
 * Deliberately excludes `NODE_` and `LOG_`, which collide with tooling that has
 * nothing to do with this project.
 */
const TASKFLOW_PREFIXES = [
  'DATABASE_',
  'STORAGE_',
  'MAIL_',
  'MASTER_KEY',
  'JWT_',
  'API_',
  'WEB_',
  'CLAMAV_',
];

/**
 * Rejects a variable that looks like ours but is not one of ours.
 *
 * The failure being prevented: `MASTER_KEY_BASE_64` set instead of
 * `MASTER_KEY_BASE64`. Zod would report the real name as missing, which is
 * already a decent error, but naming the near-miss turns a five-minute stare
 * into a one-line fix.
 *
 * Scoped to our own prefixes rather than to everything, because "everything"
 * includes the operating system.
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

/**
 * Parses an environment source. Takes the source as an argument so tests do not
 * have to mutate the real `process.env` and leak state between files.
 */
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

/**
 * Reads the real environment, loading a repo-root `.env` first if one exists.
 *
 * Lives here rather than in `main.ts` because this module is the one place
 * permitted to touch `process.env` — the guardrail that enforces that is the
 * reason a validated config exists at all, and routing the process entry point
 * around it would be the first crack.
 *
 * `loadEnvFile` follows `--env-file` semantics and does NOT overwrite variables
 * that are already set, so injected production secrets always beat a file that
 * happens to be on disk.
 */
export function loadEnv(): Env {
  const here = dirname(fileURLToPath(import.meta.url));
  const envFile = resolve(here, '..', '..', '..', '..', '.env');

  if (existsSync(envFile)) {
    process.loadEnvFile(envFile);
  }
  return parseEnv(process.env);
}
