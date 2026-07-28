import { randomBytes, randomInt, timingSafeEqual, createHash } from 'node:crypto';

/**
 * Randomness and comparison primitives — guardrail 7 (PLAN.md §2.1, §8.4).
 *
 * `Math.random()` is banned workspace-wide by lint precisely so that every
 * security-relevant random value has to come through this file. V8's PRNG is
 * xorshift128+: fast, well-distributed, and fully predictable from a handful of
 * outputs. A session token drawn from it is not a secret.
 *
 * Everything here delegates to the platform CSPRNG. The value of the module is
 * not the algorithms — it is that there is exactly one place to audit.
 */

/** Cryptographically secure random bytes. */
export function secureBytes(length: number): Uint8Array {
  if (!Number.isInteger(length) || length < 1) {
    throw new RangeError(`secureBytes: length must be a positive integer, got ${String(length)}`);
  }
  return new Uint8Array(randomBytes(length));
}

/**
 * Uniform random integer in `[min, max)`.
 *
 * Uses `crypto.randomInt`, which rejection-samples. The naive `bytes % range`
 * is biased whenever `range` is not a power of two, and for a small range —
 * picking a shard, a backoff slot, a shuffle position — that bias is measurable.
 */
export function secureInt(min: number, max: number): number {
  return randomInt(min, max);
}

/**
 * URL-safe random string, 6 bits of entropy per character.
 *
 * base64url rather than hex: same entropy in two-thirds the characters, and no
 * `+` / `/` / `=` to be mangled by a URL, a shell, or a copy-paste.
 */
export function secureToken(byteLength = 32): string {
  return Buffer.from(secureBytes(byteLength)).toString('base64url');
}

/** Lowercase hex encoding of `byteLength` random bytes. */
export function secureHex(byteLength = 32): string {
  return Buffer.from(secureBytes(byteLength)).toString('hex');
}

/**
 * Random string from an explicit alphabet — for human-readable codes
 * (invite codes, recovery codes) where base64url's case-sensitivity and
 * lookalike characters are a support burden.
 *
 * Rejection sampling, not modulo, for the reason described on `secureInt`.
 */
export function secureCode(length: number, alphabet: string): string {
  if (alphabet.length < 2 || alphabet.length > 256) {
    throw new RangeError('secureCode: alphabet must have between 2 and 256 characters');
  }

  // Largest multiple of the alphabet size that fits in a byte. Bytes at or above
  // this are discarded rather than folded, which is what keeps the draw uniform.
  const limit = Math.floor(256 / alphabet.length) * alphabet.length;

  let out = '';
  while (out.length < length) {
    // Over-draw so the common case is a single syscall even with rejections.
    const buf = secureBytes((length - out.length) * 2);
    for (const byte of buf) {
      if (byte >= limit) continue;
      out += alphabet.charAt(byte % alphabet.length);
      if (out.length === length) break;
    }
  }
  return out;
}

/**
 * Unambiguous alphabet for codes a human reads aloud or retypes.
 * Excludes I, L, O, U, 0, 1 — the pairs that generate support tickets.
 */
export const HUMAN_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Constant-time equality.
 *
 * A `===` on a secret leaks its prefix: the comparison exits at the first
 * differing byte, so an attacker who can measure response time can recover the
 * value one character at a time. That attack is impractical over the open
 * internet and entirely practical from a co-located process.
 *
 * Inputs are hashed first so that unequal lengths are handled without an early
 * return — `timingSafeEqual` throws on a length mismatch, and branching on that
 * would leak the length of the secret.
 */
export function secureEqual(a: string | Uint8Array, b: string | Uint8Array): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Best-effort overwrite of key material.
 *
 * Honest about its limits: in a garbage-collected runtime the value may already
 * have been copied by the allocator, and this cannot reach those copies. It
 * narrows the window in which a heap dump or core file yields a live key. It
 * does not close it. Real guarantees need the key never to enter this process,
 * which is what `KmsKeyProvider` buys (§8.4).
 */
export function wipe(secret: Uint8Array): void {
  secret.fill(0);
}
