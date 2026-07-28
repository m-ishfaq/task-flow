import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import type { Algorithm, Version } from '@node-rs/argon2';

/**
 * `Algorithm` and `Version` are ambient const enums, which `verbatimModuleSyntax`
 * forbids reading at runtime — the compiler would have to inline a value it is
 * not allowed to assume survives to the emitted module. The numbers are the
 * library's own member values, asserted back to the enum types so a future
 * renumbering is still a type error rather than a silently weaker hash.
 */
const ARGON2ID = 2 as Algorithm; // Algorithm.Argon2id
const ARGON2_V13 = 1 as Version; // Version.V0x13 — Argon2 version 19 (0x13)

/**
 * Password hashing — Argon2id (PLAN.md §8.1).
 *
 * Argon2id rather than bcrypt or PBKDF2 because it is memory-hard: an attacker
 * with a GPU or an ASIC has to buy 19 MiB of fast memory per parallel guess,
 * which is the cost that does not fall with fabrication advances. bcrypt's 4 KiB
 * working set fits in cache thousands of times over on commodity hardware.
 *
 * Parameters are the OWASP baseline (m=19456 KiB, t=2, p=1). They are pinned in
 * code, embedded in every stored hash, and checked on login by `needsRehash`, so
 * raising them later upgrades users transparently as they sign in.
 *
 * NOT USED HERE — deliberately:
 *
 *   - **A pepper** (a server-side secret mixed into every hash) would mean a
 *     stolen database is uncrackable without also stealing the application
 *     secret. It is omitted because rotating one requires every hash to be
 *     recomputed, and the same defence is available later through the existing
 *     rehash-on-login path. Adding cryptographic surface to a human-review
 *     module (§2.2) needs a stronger reason than "it is also good".
 *   - **A separate salt column.** Argon2's encoded output already carries a
 *     per-hash random salt. A second one adds nothing and invites mismatch.
 */

/**
 * OWASP-recommended Argon2id parameters, second configuration.
 *
 * Raising `memoryCost` is the change that buys the most; do that rather than
 * `timeCost` if login latency budget allows. Any change here must keep
 * `needsRehash` in agreement, which it does automatically because both read
 * this object.
 */
export const ARGON2_PARAMS = {
  algorithm: ARGON2ID,
  version: ARGON2_V13,
  /** KiB of memory per hash. */
  memoryCost: 19_456,
  /** Passes over memory. */
  timeCost: 2,
  /** Lanes. 1 because the API server is already concurrent per-request. */
  parallelism: 1,
  /** Digest length in bytes. */
  outputLen: 32,
} as const;

/**
 * Upper bound on password length, in UTF-16 code units.
 *
 * Not a security requirement — Argon2's cost is set by its parameters, not its
 * input — but an unbounded field that reaches a memory-hard function is a free
 * amplification factor for anyone posting megabyte passwords. There is no
 * minimum here on purpose: strength rules belong in the identity phase's
 * validation schema, next to the breach check, where they can be stated once.
 */
export const MAX_PASSWORD_LENGTH = 1024;

/**
 * Unicode-normalizes a password before it is hashed or verified.
 *
 * "é" can be one code point or two, and which one a user's keyboard produces
 * depends on their OS and input method. Without normalization the same typed
 * password fails to verify across devices, and the bug is nearly impossible to
 * diagnose from a log. NFC (per RFC 8265's OpaqueString profile) rather than
 * NFKC: compatibility folding would silently collapse distinct characters and
 * quietly reduce entropy.
 */
function normalize(password: string): string {
  return password.normalize('NFC');
}

function assertHashable(password: string): void {
  if (password.length === 0) {
    throw new RangeError('Password must not be empty.');
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new RangeError(`Password exceeds ${String(MAX_PASSWORD_LENGTH)} characters.`);
  }
}

/**
 * Hashes a password, returning the PHC-format encoded string
 * (`$argon2id$v=19$m=19456,t=2,p=1$<salt>$<digest>`).
 *
 * The salt is generated internally by Argon2 from the platform CSPRNG. Store the
 * returned string whole — the parameters travel with it, which is what makes
 * upgrading them a non-event.
 */
export async function hashPassword(password: string): Promise<string> {
  assertHashable(password);
  return argonHash(normalize(password), ARGON2_PARAMS);
}

/**
 * Verifies a password against a stored hash. Never throws on a bad password or a
 * malformed hash — a corrupt row must read as "authentication failed", not as a
 * 500 that tells the caller their guess was special.
 */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  if (password.length === 0 || password.length > MAX_PASSWORD_LENGTH) return false;
  try {
    return await argonVerify(storedHash, normalize(password));
  } catch {
    return false;
  }
}

/**
 * Burns the same work as a real verification, then fails.
 *
 * Call this when the account does not exist, is unverified, or is locked. Login
 * that skips hashing for unknown users answers in ~1 ms instead of ~50 ms, and
 * that gap is a reliable, remotely-measurable oracle for "is this email
 * registered here" — which for a B2B product leaks the customer list.
 *
 * The reference hash below is a real Argon2id hash of a random string, generated
 * with `ARGON2_PARAMS`. It is public by design and guards nothing.
 */
export async function fakeVerifyPassword(password: string): Promise<false> {
  await verifyPassword(password, DUMMY_HASH);
  return false;
}

const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$MrDSHeygF+bIgWsWcGWgSA$X7g5oWEExSiGGx73kS0n4b20IHW7868/NAKl+VLnPQc';

/**
 * True when a stored hash was produced with weaker parameters than the current
 * ones, or with a different algorithm.
 *
 * The intended call site is immediately after a SUCCESSFUL login, which is the
 * only moment the plaintext is available to rehash with. This is what makes the
 * parameters in `ARGON2_PARAMS` a live setting rather than a historical one.
 */
export function needsRehash(storedHash: string): boolean {
  const parsed = parsePhc(storedHash);
  if (!parsed) return true; // unparseable, or from another library — replace it

  return (
    parsed.algorithm !== 'argon2id' ||
    parsed.version !== 19 ||
    parsed.memoryCost < ARGON2_PARAMS.memoryCost ||
    parsed.timeCost < ARGON2_PARAMS.timeCost ||
    parsed.parallelism !== ARGON2_PARAMS.parallelism
  );
}

interface PhcParams {
  algorithm: string;
  version: number;
  memoryCost: number;
  timeCost: number;
  parallelism: number;
}

/**
 * Minimal PHC-string reader for the fields `needsRehash` compares.
 *
 * Hand-rolled because `@node-rs/argon2` exposes no parameter introspection, and
 * the alternative — assuming every stored hash uses today's parameters — is
 * exactly the assumption that makes a parameter upgrade silently do nothing.
 */
function parsePhc(value: string): PhcParams | undefined {
  const parts = value.split('$');
  // ['', algorithm, v=..., m=...,t=...,p=..., salt, digest]
  if (parts.length !== 6) return undefined;

  const [, algorithm, versionPart, paramPart] = parts;
  if (!algorithm || !versionPart || !paramPart) return undefined;

  const version = Number(versionPart.replace('v=', ''));
  if (!Number.isInteger(version)) return undefined;

  const params = new Map<string, number>();
  for (const pair of paramPart.split(',')) {
    const [key, raw] = pair.split('=');
    if (!key || raw === undefined) return undefined;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed)) return undefined;
    params.set(key, parsed);
  }

  const memoryCost = params.get('m');
  const timeCost = params.get('t');
  const parallelism = params.get('p');
  if (memoryCost === undefined || timeCost === undefined || parallelism === undefined) {
    return undefined;
  }

  return { algorithm, version, memoryCost, timeCost, parallelism };
}
