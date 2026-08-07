import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { TrustProxy } from '@taskflow/api/config/trust-proxy';
import { ACCESS_TOKEN_TTL_SECONDS } from '@taskflow/security';

/**
 * Validated environment for the socket gateway — guardrail 3.
 *
 * Same contract as `apps/api/src/config/env.ts`: this module is the one place in
 * this app permitted to touch `process.env`, everything else receives parsed
 * values, and a misconfiguration fails at BOOT with the variable named rather
 * than surfacing as `undefined` inside a connection handler.
 *
 * Deliberately its OWN schema rather than importing the API's. The two apps need
 * overlapping but different variables — the gateway has no mail, no storage, no
 * ClamAV — and a shared schema would mean the gateway refusing to start over an
 * unset `STORAGE_BUCKET_EXPORTS` it will never read. What IS shared is the one
 * piece where a divergence would be a security defect: `TrustProxy`, imported
 * from the API rather than re-derived, because a gateway that trusted
 * `X-Forwarded-For` differently from the API would make the per-IP limits in
 * §6.5 opt-out in a way the API's own tests would never catch.
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

/**
 * The floor under `REALTIME_REAUTH_LEAD_SECONDS` (spec §7.1).
 *
 * Below this, a refresh on a slow connection does not reliably finish before the
 * token it is replacing expires — so proactive reauth degrades into the reactive
 * behaviour it exists to avoid, silently, and only for the users least able to
 * absorb it.
 */
export const MIN_REAUTH_LEAD_SECONDS = 30;

export const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

    /* The ORDINARY application role. The gateway resolves membership and tuples
       through it, under RLS, using the same functions the API calls — see §6.2
       on why there is no privileged authorization path here. */
    DATABASE_URL: NonEmpty,
    DATABASE_POOL_MAX: z.coerce.number().int().positive().max(100).default(10),

    /* The consumer role, `taskflow_realtime` (§3.5, migration 0016). Required
       rather than optional, unlike the API's DATABASE_AUDIT_URL: an API
       instance that does not drain the outbox still serves requests, whereas a
       gateway that does not drain the outbox has nothing to broadcast and is a
       process doing nothing while appearing healthy. */
    DATABASE_REALTIME_URL: NonEmpty,

    /* Verified with the same secret, issuer and audience the API signs with.
       The token IS an API credential; the gateway is a second verifier of it,
       which is the trade `packages/security/src/jwt.ts` names as the point
       where HS256 would become RS256 if the verifier were ever a third party.
       It is not — both processes are ours and share the secret. */
    JWT_SECRET: Base64Key,

    REALTIME_PORT: z.coerce.number().int().positive().max(65_535).default(3001),
    REALTIME_HOST: z.string().default('0.0.0.0'),
    REALTIME_TRUST_PROXY: TrustProxy,

    /* The allowed browser origin(s), checked at the handshake (§3.2). A page
       loaded from anywhere else must never get far enough to present a token.
       Comma-separated so a deployment with an apex and a www host does not need
       a second variable. */
    WEB_ORIGIN: NonEmpty,

    /**
     * How long before expiry the client proactively refreshes and reconnects
     * (§7.1). Bounded at both ends below; see the superRefine for the ceiling.
     */
    REALTIME_REAUTH_LEAD_SECONDS: z.coerce.number().int().min(MIN_REAUTH_LEAD_SECONDS).default(60),

    /* The relay's poll interval — the CORRECTNESS floor, not the delivery
       mechanism (§7.3). LISTEN/NOTIFY makes the common case fast; this is what
       makes a missed notification cost latency rather than an event. Free to
       stay lazy for exactly that reason. */
    REALTIME_POLL_INTERVAL_MS: z.coerce.number().int().positive().max(300_000).default(5_000),

    /* Rate limits (§6.5, §7.5). Their own numbers, not the login middleware's —
       legitimate traffic here is one connection per tab and a handful of joins,
       which looks nothing like either login abuse or an enumeration loop. */
    REALTIME_MAX_CONNECTIONS_PER_IP_PER_MINUTE: z.coerce.number().int().positive().default(30),
    REALTIME_MAX_JOINS_PER_MINUTE: z.coerce.number().int().positive().default(60),
    REALTIME_MAX_REFUSED_JOINS_PER_MINUTE: z.coerce.number().int().positive().default(10),
  })
  /* NOT `.strict()`, for the identical reason apps/api's schema is not:
     `process.env` carries a few hundred variables belonging to the OS and the
     shell, and rejecting unknown keys means the process cannot start on any real
     machine. `assertNoMisspelledVariables` provides the typo protection. */
  .superRefine((env, ctx) => {
    if (env.REALTIME_REAUTH_LEAD_SECONDS >= ACCESS_TOKEN_TTL_SECONDS) {
      /* A lead time at or above the token's whole lifetime means the token is
         ALWAYS "about to expire", so the client reconnects continuously — a
         self-inflicted denial of service configured in one line. Caught at boot
         rather than at 3am. */
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['REALTIME_REAUTH_LEAD_SECONDS'],
        message:
          `must be less than the access token TTL (${String(ACCESS_TOKEN_TTL_SECONDS)}s). ` +
          'At or above it, every token is always within its own reauth window and clients ' +
          'reconnect in a loop.',
      });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

/**
 * Every TaskFlow variable across ALL services, mirroring the set in
 * `apps/api/src/config/env.ts` — a developer's environment legitimately carries
 * variables this process does not read, so the misspelling check has to know
 * about them or it would reject a correct setup.
 */
const KNOWN_VARIABLES = new Set([
  'NODE_ENV',
  'LOG_LEVEL',
  'DATABASE_URL',
  'DATABASE_MIGRATION_URL',
  'DATABASE_AUDIT_URL',
  'DATABASE_REALTIME_URL',
  /* apps/collab's write-exception role (Phase 6 Wave 2, migration 0024) and
     the backlinks relay's claim role (Wave 3, migration 0025) — both in
     .env.example, neither read here, both claimed by the `DATABASE_` prefix.
     Same failure as the API's own set: an unlisted one refuses to boot over
     a correctly-spelled variable the moment it lands in a developer's .env. */
  'DATABASE_COLLAB_URL',
  'DATABASE_BACKLINKS_URL',
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
  /* apps/web's vite.config.ts reads these; no server does. They still have to
     be listed, because the `WEB_` prefix makes the misspelling check claim them
     — and an unlisted one stops this process booting over a variable that is
     not misspelled at all. */
  'WEB_API_ORIGIN',
  'WEB_REALTIME_ORIGIN',
  /* apps/web's vite.config.ts /collab proxy target — same class as the two
     above: `WEB_` prefix, no server reads it, must be listed or it is
     rejected. */
  'WEB_COLLAB_ORIGIN',
  'REALTIME_PORT',
  'REALTIME_HOST',
  'REALTIME_TRUST_PROXY',
  'REALTIME_REAUTH_LEAD_SECONDS',
  'REALTIME_POLL_INTERVAL_MS',
  'REALTIME_MAX_CONNECTIONS_PER_IP_PER_MINUTE',
  'REALTIME_MAX_JOINS_PER_MINUTE',
  'REALTIME_MAX_REFUSED_JOINS_PER_MINUTE',
]);

const TASKFLOW_PREFIXES = [
  'DATABASE_',
  'STORAGE_',
  'MAIL_',
  'MASTER_KEY',
  'JWT_',
  'API_',
  'WEB_',
  'CLAMAV_',
  'REALTIME_',
];

/**
 * Rejects a variable that looks like ours but is not one of ours.
 *
 * The failure being prevented: `REALTIME_REAUTH_LEAD_SECS` set instead of
 * `REALTIME_REAUTH_LEAD_SECONDS`. Zod reports the real name as defaulted rather
 * than missing, so without this the process starts happily on 60 seconds while
 * the operator believes they changed it.
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

/**
 * The origins a handshake may come from.
 *
 * Split here rather than at the call site so the parsing rule — comma separated,
 * trimmed, empties dropped — has one definition and the allow-list can be
 * asserted directly in a test.
 */
export function allowedOrigins(env: Env): readonly string[] {
  return env.WEB_ORIGIN.split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}
