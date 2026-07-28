import { createHash } from 'node:crypto';
import { HUMAN_ALPHABET, secureCode, secureEqual, secureToken } from './random.js';

/**
 * Opaque bearer tokens — refresh tokens, API tokens, invitations, email
 * verification and password-reset links (PLAN.md §8.1).
 *
 * One rule holds the module together: **the database stores a hash, never the
 * token.** A leaked backup, a verbose log line, or a SQL-injection read then
 * yields nothing usable. The token exists in plaintext exactly once, in the
 * response that issues it.
 */

/**
 * Token entropy, in bytes.
 *
 * 256 bits. The number is chosen so that guessing is not a threat model at all
 * rather than merely expensive, which lets the storage hash be a fast one — see
 * `hashToken`.
 */
const TOKEN_BYTES = 32;

/**
 * Prefixes make a leaked token identifiable on sight.
 *
 * The practical payoff is secret scanning: GitHub, gitleaks, and our own CI rule
 * match on a distinctive prefix. An undifferentiated base64 blob in a commit is
 * invisible to all of them, and "we found out from the access log" is not an
 * incident-response plan.
 */
export const TOKEN_PREFIX = {
  /** Long-lived programmatic access. Shown once at creation. */
  apiToken: 'tf_pat',
  /** Rotated on every use, with reuse detection (§8.1). */
  refresh: 'tf_rt',
  /** Single-use, short-lived, delivered by email. */
  emailVerify: 'tf_ev',
  passwordReset: 'tf_pr',
  invitation: 'tf_inv',
  /** Anonymous document/board share links. */
  shareLink: 'tf_sl',
  /** Signs an outbound webhook body so the receiver can verify us. */
  webhookSigning: 'tf_whs',
} as const;

export type TokenKind = keyof typeof TOKEN_PREFIX;

export interface IssuedToken {
  /**
   * The full token. Return it to the caller, then forget it — this value must
   * never be logged, persisted, or included in an audit entry.
   */
  readonly token: string;
  /** The value to store. Safe at rest. */
  readonly hash: string;
}

/**
 * Issues a token and its storage hash.
 *
 * Callers store `hash` and hand back `token`. The pairing is returned from a
 * single call so there is no path where a token is minted and the wrong thing
 * gets written to the row.
 */
export function issueToken(kind: TokenKind): IssuedToken {
  const token = `${TOKEN_PREFIX[kind]}_${secureToken(TOKEN_BYTES)}`;
  return { token, hash: hashToken(token) };
}

/**
 * Hashes a token for storage. Unsalted SHA-256, and that is correct here.
 *
 * Passwords need Argon2 because they are low-entropy and human-chosen, so an
 * attacker guesses from a dictionary of a few billion candidates. A token is 256
 * bits of CSPRNG output: there is no dictionary, no rainbow table can span the
 * space, and a per-value salt would protect against a precomputation attack that
 * is already impossible. Meanwhile every authenticated API request verifies one
 * of these, and Argon2 there would put ~50 ms of memory-hard work on the hot
 * path of every call — an availability problem traded for no confidentiality
 * gain.
 *
 * The reasoning depends entirely on the input being high-entropy. Do not reach
 * for this to store anything a human picked; see `hashPassword`.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Compares a presented token against a stored hash, in constant time.
 *
 * The lookup itself should be by hash — `WHERE token_hash = $1` — so this is the
 * belt to that braces, used where a row has already been fetched by some other
 * key (a session id, a user id) and the token still has to be checked.
 */
export function verifyToken(presented: string, storedHash: string): boolean {
  return secureEqual(hashToken(presented), storedHash);
}

/** True when a token carries the prefix for `kind`. */
export function isTokenKind(token: string, kind: TokenKind): boolean {
  return token.startsWith(`${TOKEN_PREFIX[kind]}_`);
}

/**
 * Short numeric code for SMS or email delivery (TOTP fallback, step-up
 * challenges).
 *
 * A six-digit code has ~20 bits of entropy, so unlike `issueToken` the secret is
 * NOT what stops an attacker. Three things have to be true wherever this is
 * used, and none of them live in this function:
 *
 *   1. a hard attempt limit per code (5, then invalidate — not per-request rate
 *      limiting, which an attacker parallelizes),
 *   2. a short expiry, ten minutes at most,
 *   3. single use, deleted on success.
 *
 * Without those, a million guesses is an afternoon.
 */
export function issueNumericCode(digits = 6): IssuedToken {
  const token = secureCode(digits, '0123456789');
  return { token, hash: hashToken(token) };
}

/**
 * Human-transcribable code for invitations and recovery codes — no ambiguous
 * characters, grouped for readability (`H7K2-9PQX-M4TR`).
 */
export function issueHumanCode(groups = 3, groupSize = 4): IssuedToken {
  const token = Array.from({ length: groups }, () => secureCode(groupSize, HUMAN_ALPHABET)).join(
    '-',
  );
  return { token, hash: hashToken(token) };
}
