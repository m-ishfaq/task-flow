/**
 * Log redaction paths (PLAN.md §8.7 — "Secrets in logs").
 *
 * This list is a security control, not hygiene. A leaked bearer token or refresh
 * cookie in an aggregated log store is a credential compromise with a long tail:
 * logs get shipped to third parties, retained for months, and are readable by
 * people who would never be granted database access.
 *
 * Rules for editing this file:
 *   - Adding a path is always safe. Do it liberally.
 *   - REMOVING a path requires the same scrutiny as any other change to a
 *     security-critical surface (§2.2).
 *   - Redaction is a backstop, not permission to log sensitive values. Never
 *     deliberately log a secret and rely on this catching it — pino only redacts
 *     paths it can see, so a token embedded in a message STRING passes straight
 *     through.
 */

export const REDACTION_CENSOR = '[redacted]';

/**
 * Pino redaction paths. Supports `*` for a single level and `[*]` for arrays.
 *
 * Both bare and nested forms are listed for each field: pino matches literal
 * paths, so `password` and `*.password` are genuinely different patterns and
 * omitting either leaves a hole.
 */
export const REDACTION_PATHS: readonly string[] = [
  /* --- Transport-level credentials -------------------------------------- */
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'req.headers["x-twilio-signature"]',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',

  /* --- Authentication (§8.1) --------------------------------------------- */
  'password',
  '*.password',
  '*.newPassword',
  '*.currentPassword',
  'passwordHash',
  '*.passwordHash',
  'token',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.idToken',
  '*.sessionToken',
  '*.apiToken',
  '*.tokenHash',
  '*.secret',
  '*.clientSecret',
  '*.totpSecret',
  '*.recoveryCodes',
  '*.credential',

  /* --- Cryptography (§8.4) ------------------------------------------------ */
  '*.masterKey',
  '*.dataKey',
  '*.wrappedKey',
  '*.privateKey',
  '*.signingKey',

  /* --- Telephony PII (§8.5) ----------------------------------------------- */
  // Phone numbers are field-encrypted at rest; logging them in plaintext would
  // defeat that entirely.
  '*.phoneNumber',
  '*.to',
  '*.from',
  '*.recordingUrl',
  '*.transcript',
  '*.transcriptText',
  '*.twilioAuthToken',

  /* --- Object storage ------------------------------------------------------ */
  // Presigned URLs carry their own authorization in the query string.
  '*.presignedUrl',
  '*.signedUrl',
  '*.downloadUrl',

  /* --- Invitations and verification ---------------------------------------- */
  '*.inviteToken',
  '*.verificationToken',
  '*.resetToken',
];

/**
 * Environment variable names whose values must never be printed — used when
 * dumping resolved config at boot.
 */
// Deliberately a substring match, not end-anchored: real names put the telling
// word in the middle (MASTER_KEY_BASE64, STORAGE_SECRET_ACCESS_KEY). Erring
// toward over-matching is correct here — the cost of redacting a non-secret in a
// boot-time config dump is nil.
export const SECRET_ENV_PATTERN =
  /(SECRET|TOKEN|PASSWORD|CREDENTIAL|_KEY|KEY_|AUTH|DSN|_URL|CONNECTION_STRING)/i;

/** True when an env var name looks like it holds a secret. */
export function isSecretEnvVar(name: string): boolean {
  return SECRET_ENV_PATTERN.test(name);
}
