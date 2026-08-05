/**
 * The seeder's pseudo-random source.
 *
 * ## Why this is not @taskflow/security
 *
 * Guardrail 7 bans `Math.random()` everywhere and concentrates every real random
 * primitive in @taskflow/security, and nothing here weakens that: `secureInt`
 * remains the only way to pick a token, a nonce, or an id that anyone's security
 * depends on.
 *
 * What this package needs is the opposite property. A seeder whose output
 * changes on every run cannot be used to reproduce anything — "the card detail
 * panel breaks on the third card of the Review column" is not a bug report if
 * the third card is different tomorrow. `--seed 42` is only a meaningful flag if
 * the same seed produces the same database, and a CSPRNG cannot promise that by
 * construction.
 *
 * So this is a small, explicit, deterministic PRNG (sfc32), used for demo
 * CONTENT and demo IDs only, in a package the CLI refuses to run outside
 * development. It is not exported from the package's public surface for any
 * other purpose, and it must never be reached for by anything that ships.
 */

/**
 * Hashes a seed string into the four 32-bit words sfc32 needs.
 *
 * cyrb128. The mixing matters more than it looks: seeded with four
 * near-identical words, sfc32's first dozen outputs are correlated, so
 * `--seed 1` and `--seed 2` would produce visibly similar data and the flag
 * would look broken.
 */
function seedWords(seed: string): [number, number, number, number] {
  let h1 = 1_779_033_703;
  let h2 = 3_144_134_277;
  let h3 = 1_013_904_242;
  let h4 = 2_773_480_762;

  for (let i = 0; i < seed.length; i += 1) {
    const k = seed.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597_399_067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2_869_860_233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951_274_213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2_716_044_179);
  }

  return [
    (Math.imul(h3 ^ (h1 >>> 18), 597_399_067) ^ Math.imul(h2 ^ (h4 >>> 22), 2_869_860_233)) >>> 0,
    (Math.imul(h4 ^ (h2 >>> 18), 951_274_213) ^ Math.imul(h3 ^ (h1 >>> 22), 2_716_044_179)) >>> 0,
    (Math.imul(h1 ^ (h3 >>> 18), 597_399_067) ^ Math.imul(h4 ^ (h2 >>> 22), 2_869_860_233)) >>> 0,
    (Math.imul(h2 ^ (h4 >>> 18), 951_274_213) ^ Math.imul(h1 ^ (h3 >>> 22), 2_716_044_179)) >>> 0,
  ];
}

export interface Rng {
  /** A float in [0, 1). */
  next(): number;
  /** An integer in [min, max], both inclusive. */
  int(min: number, max: number): number;
  /** One element. Throws on an empty list rather than returning undefined. */
  pick<T>(items: readonly T[]): T;
  /** `count` distinct elements, or all of them when the list is shorter. */
  sample<T>(items: readonly T[], count: number): T[];
  /** True with the given probability. `chance(0)` is never, `chance(1)` is always. */
  chance(probability: number): boolean;
  /** One element, with relative weights. Weights need not sum to anything. */
  weighted<T>(entries: readonly (readonly [T, number])[]): T;
  /** A new array in a shuffled order. Does not mutate the input. */
  shuffle<T>(items: readonly T[]): T[];
  /**
   * A UUIDv7-SHAPED identifier, derived from this stream.
   *
   * Deterministic on purpose — see the module header. Time-ordered like the real
   * thing, so rows sort by creation the way `newId()` output does and the
   * `cards_list_rank_idx` tie-breaks behave realistically.
   */
  uuid(at: Date): string;
  /**
   * An independent stream, named.
   *
   * The reason this exists: if one shared stream feeds every module, adding a
   * single `chance()` call to the boards module shifts every subsequent draw and
   * changes every card in the database. Per-module streams keep a change local
   * to the module that made it, which is what makes the determinism useful
   * rather than merely technically true.
   */
  fork(label: string): Rng;
}

export function createRng(seed: string): Rng {
  const [w0, w1, w2, w3] = seedWords(seed);
  let a = w0;
  let b = w1;
  let c = w2;
  let d = w3;

  const next = (): number => {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4_294_967_296;
  };

  // sfc32's first outputs reflect the seed too directly; the reference
  // implementation discards a dozen rounds and so does this one.
  for (let i = 0; i < 12; i += 1) next();

  const rng: Rng = {
    next,

    int: (min, max) => {
      if (max < min) throw new Error(`Empty range: int(${String(min)}, ${String(max)})`);
      return min + Math.floor(next() * (max - min + 1));
    },

    pick: <T>(items: readonly T[]): T => {
      const item = items[Math.floor(next() * items.length)];
      if (item === undefined) {
        throw new Error('pick() on an empty list — the caller has nothing to choose from.');
      }
      return item;
    },

    sample: <T>(items: readonly T[], count: number): T[] => rng.shuffle(items).slice(0, count),

    chance: (probability) => next() < probability,

    weighted: <T>(entries: readonly (readonly [T, number])[]): T => {
      const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
      if (total <= 0) throw new Error('weighted() needs at least one positive weight.');

      let target = next() * total;
      for (const [value, weight] of entries) {
        target -= weight;
        if (target < 0) return value;
      }
      // Only reachable through floating-point drift on the last entry.
      const last = entries[entries.length - 1];
      if (!last) throw new Error('weighted() on an empty list.');
      return last[0];
    },

    shuffle: <T>(items: readonly T[]): T[] => {
      const copy = [...items];
      for (let i = copy.length - 1; i > 0; i -= 1) {
        const j = Math.floor(next() * (i + 1));
        const left = copy[i];
        const right = copy[j];
        // Present by construction; the guard is what satisfies
        // noUncheckedIndexedAccess without a non-null assertion.
        if (left !== undefined && right !== undefined) {
          copy[i] = right;
          copy[j] = left;
        }
      }
      return copy;
    },

    uuid: (at) => {
      const ms = at.getTime();
      const bytes = new Uint8Array(16);

      // 48-bit big-endian millisecond timestamp, exactly as UUIDv7 specifies.
      bytes[0] = Math.floor(ms / 2 ** 40) & 0xff;
      bytes[1] = Math.floor(ms / 2 ** 32) & 0xff;
      bytes[2] = Math.floor(ms / 2 ** 24) & 0xff;
      bytes[3] = Math.floor(ms / 2 ** 16) & 0xff;
      bytes[4] = Math.floor(ms / 2 ** 8) & 0xff;
      bytes[5] = ms & 0xff;

      for (let i = 6; i < 16; i += 1) bytes[i] = Math.floor(next() * 256);

      // Version 7 and the RFC 4122 variant. Without these the string is a
      // well-formed uuid that no parser would call a v7, and `timestampOf` in
      // @taskflow/security would decline to read it.
      bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
      bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

      const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
      return [
        hex.slice(0, 8),
        hex.slice(8, 12),
        hex.slice(12, 16),
        hex.slice(16, 20),
        hex.slice(20, 32),
      ].join('-');
    },

    fork: (label) => createRng(`${seed}:${label}`),
  };

  return rng;
}
