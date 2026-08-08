import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Blind indexes — equality lookup over an encrypted column (PLAN.md §8.4,
 * §8.5; ai/phase-7-voice.md Wave 2).
 *
 * ## The problem this exists for
 *
 * `REDACTION_PATHS` says of phone numbers: "field-encrypted at rest; logging
 * them in plaintext would defeat that entirely." Encrypting them is
 * straightforward — AES-GCM with the org's data key, as
 * `comms.subaccounts.auth_token_ciphertext` already does. **Finding a row by
 * one is not.** AES-GCM is randomized: the same number encrypted twice produces
 * different ciphertexts, so `WHERE counterparty_ciphertext = $1` matches
 * nothing, ever. Inbound SMS threading needs exactly that lookup.
 *
 * The wrong fixes are worth naming, because both are common:
 *
 *   - **Store it in plaintext "just for the index."** Then it is in plaintext,
 *     and the encryption is decoration.
 *   - **Encrypt deterministically** (a fixed IV, or ECB). Every equal value now
 *     has an equal ciphertext, which is what the index needs — and the same
 *     property leaks across the whole column, forever, to anyone who reads it,
 *     with the value still recoverable by whoever holds the key.
 *
 * A blind index separates the two jobs: the ciphertext stays randomized and
 * unreadable, and a SEPARATE keyed hash provides equality. The hash is one-way,
 * so a stolen index column yields no numbers — only the knowledge that two rows
 * hold the same one.
 *
 * ## What it deliberately leaks
 *
 * Equality, and only equality. Two rows with the same index hold the same
 * value. That is the entire point and it cannot be avoided while supporting
 * lookup; it is accepted here because the alternative is plaintext.
 *
 * It does NOT leak across tenants: `namespace` is mixed into the input, and
 * every caller passes the org id. The same phone number in two orgs produces two
 * unrelated indexes, so an attacker reading the whole column cannot tell that
 * two customers of two tenants are the same person.
 *
 * ## The key is not the encryption key
 *
 * Separate key material, from `TELEPHONY_INDEX_KEY`. Reusing the master or a
 * data key would mean a single compromise both decrypts the column and lets an
 * attacker generate indexes to confirm guesses; keeping them apart means
 * compromising the index key alone buys only the ability to test a candidate
 * number for presence, which is why the key length is enforced below.
 */

/** HMAC-SHA256 output, truncated. */
const INDEX_BYTES = 16;

/** Minimum key length. 32 bytes, matching every other key in this package. */
const MIN_KEY_BYTES = 32;

/**
 * Computes a blind index.
 *
 * `namespace` scopes the index — always the org id here. `value` must already
 * be in its CANONICAL form (E.164 for a phone number): the index is an exact
 * equality over bytes, so `+14155550100` and `(415) 555-0100` produce unrelated
 * indexes and the lookup silently finds nothing. Callers parse before they
 * index, which is why `PhoneNumberSchema` exists and why nothing here accepts a
 * loose string it could normalize itself — a normalizer in two places is two
 * normalizers that can disagree.
 */
export function blindIndex(key: Uint8Array, namespace: string, value: string): Buffer {
  if (key.length < MIN_KEY_BYTES) {
    // A short key here is a weak index, and the failure is completely silent:
    // lookups keep working, so nothing ever reveals it.
    throw new RangeError(
      `Blind index key must be at least ${String(MIN_KEY_BYTES)} bytes, got ${String(key.length)}.`,
    );
  }

  /* Length-prefixed, not concatenated.
   *
   * `namespace + ':' + value` is ambiguous: namespace "a:b" with value "c"
   * hashes identically to namespace "a" with value "b:c". For an org id and an
   * E.164 number that collision is not reachable today — neither contains a
   * colon — but the property should hold because of how the input is built, not
   * because of what the inputs happen to look like. This is the same reasoning
   * `audit-chain.ts` gives for length-prefixing its own digest input. */
  const hmac = createHmac('sha256', key);
  hmac.update(`${String(namespace.length)}:${namespace}|${String(value.length)}:${value}`, 'utf8');

  return hmac.digest().subarray(0, INDEX_BYTES);
}

/**
 * Constant-time comparison of two indexes.
 *
 * An index is not a secret in the way a token is, but it is a keyed value an
 * attacker would like to confirm guesses against — and a `Buffer.equals` here
 * would leak how far a candidate matched.
 */
export function blindIndexEquals(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
