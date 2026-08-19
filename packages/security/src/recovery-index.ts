import { createHmac } from 'node:crypto';
import { blindIndex } from './blind-index.js';

/**
 * A keyed equality index over TOTP recovery codes (Phase 12 Wave 2 §3.2).
 *
 * ## Why this exists
 *
 * Recovery codes are Argon2id-hashed, like passwords — a deliberately slow,
 * randomly-salted hash, so the SAME code hashed twice yields different bytes.
 * That makes the hash impossible to look up: to check a submitted code, the
 * verifier had to load every one of a user's ten stored hashes and run Argon2
 * against each until one matched. A wrong code exhausted all ten. Argon2 is
 * slow BY DESIGN, so that turned one login attempt into ten of the most
 * expensive operations in the system — an amplification an attacker reaches by
 * sending junk codes, with the rate limit as the only bound.
 *
 * This is the exact problem `blind-index.ts` solves for encrypted phone
 * numbers, and the solution is the same: keep the slow, unreadable Argon2 hash
 * as the authoritative verifier, and add a SEPARATE keyed one-way index that
 * supports equality. A login computes the index of the submitted code, finds
 * the single row that shares it, and runs Argon2 exactly ONCE — or, for a code
 * that matches nothing, not at all.
 *
 * ## Why keyed, and why not the raw data key
 *
 * The index must be a keyed HMAC, not a plain hash: recovery codes are short
 * (12 chars over a 32-symbol alphabet), so a plain hash of the column would be
 * brute-forceable offline if the database leaked. The key keeps a stolen index
 * column inert — it yields only "these two rows hold the same code", never the
 * codes.
 *
 * The key is DERIVED from the identity data key rather than being it. The data
 * key is an AES-GCM key that encrypts TOTP secrets; using the same bytes as an
 * HMAC key is the cross-purpose reuse `blind-index.ts`' own header warns
 * against. A one-line HMAC derivation with a fixed domain label gives the index
 * its own independent key for free, and adds no new secret to provision — the
 * identity data key is already threaded into the TOTP service.
 */

/** Domain-separation label for the derived index key. Versioned so a future rotation is expressible. */
const SUBKEY_LABEL = 'taskflow/totp-recovery-index/v1';

/**
 * The equality index for one recovery code.
 *
 * `userId` is the blind-index namespace, so the same code enrolled by two users
 * produces unrelated indexes — the lookup still filters on `user_id` in SQL,
 * but namespacing means the index column alone never reveals a shared code
 * across accounts.
 */
export function recoveryCodeIndex(
  identityDataKey: Uint8Array,
  userId: string,
  code: string,
): Buffer {
  const subKey = createHmac('sha256', identityDataKey).update(SUBKEY_LABEL, 'utf8').digest();
  return blindIndex(subKey, userId, code);
}
