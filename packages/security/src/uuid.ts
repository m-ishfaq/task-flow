import { unsafeAsId, type Id } from '@taskflow/contracts';
import { secureBytes, secureInt } from './random.js';

/**
 * UUIDv7 generation (RFC 9562 §5.7) — PLAN.md §7.1.
 *
 * Every identifier in the system is a v7 UUID, for two reasons that pull in the
 * same direction:
 *
 *   - **Index locality.** The leading 48 bits are a Unix millisecond timestamp,
 *     so ids generated near each other in time sort near each other in the
 *     B-tree. A v4 primary key scatters inserts across the whole index and turns
 *     a sequential write into a random one; on a table with hundreds of millions
 *     of rows that difference is the whole performance story.
 *   - **Non-enumerability.** The remaining 74 bits are random, so there is no
 *     `/card/1234` to walk. Sequential integer keys make IDOR probing free: an
 *     attacker who finds one authorization gap can enumerate the entire table
 *     through it. RLS is still the control that stops them (§8.3) — this just
 *     removes the map.
 *
 * Generated application-side rather than by the database. PostgreSQL 17 has no
 * native `uuidv7()` (it lands in 18), and the alternative — a `pgcrypto`-based
 * SQL function — puts a security primitive somewhere no test in this repo can
 * reach. See docker/postgres/init/01-extensions.sql.
 *
 * Layout, 128 bits:
 *
 *   0                   1                   2                   3
 *   |  unix_ts_ms (48)                      | ver |  rand_a (12) |
 *   | var |            rand_b (62)                              |
 */

/** Bits available to the intra-millisecond counter (`rand_a`). */
const COUNTER_BITS = 12;
const COUNTER_MAX = (1 << COUNTER_BITS) - 1; // 4095

/**
 * Counters start somewhere in the bottom half of the range.
 *
 * RFC 9562 method 3 seeds the counter randomly so that consecutive ids do not
 * reveal how many rows were written in that millisecond. Seeding across the FULL
 * range would leave an unlucky seed with almost no headroom before overflow, so
 * the seed is confined to the lower half: at least 2048 ids per millisecond are
 * always available, and the count stays hidden.
 */
const COUNTER_SEED_MAX = 1 << (COUNTER_BITS - 1); // 2048

let lastMs = -1;
let counter = 0;

/**
 * Returns a new UUIDv7 as a lowercase hyphenated string.
 *
 * Monotonic within a process: two calls never produce ids that sort backwards,
 * even inside one millisecond and even if the system clock steps backwards. NTP
 * corrections and VM migrations both do that, and an id that sorts before its
 * predecessor breaks keyset pagination — the client asks for "everything after
 * X" and silently never sees the rows that landed behind it.
 */
export function uuidv7(): string {
  const now = Date.now();

  if (now > lastMs) {
    lastMs = now;
    counter = secureInt(0, COUNTER_SEED_MAX);
  } else if (counter < COUNTER_MAX) {
    // Same millisecond, or the clock moved backwards: keep the previous
    // timestamp and advance the counter so ordering still holds.
    counter += 1;
  } else {
    // 4096 ids inside one millisecond. Borrow from the next millisecond rather
    // than block the caller; the sequence stays monotonic and the drift is at
    // most a few milliseconds ahead of the wall clock.
    lastMs += 1;
    counter = secureInt(0, COUNTER_SEED_MAX);
  }

  const bytes = secureBytes(16);

  // unix_ts_ms — 48 bits, big-endian. Date.now() exceeds 32 bits, so the high
  // half is taken by division rather than a bitwise shift (which would coerce
  // to int32 and silently truncate in the year 1970 direction).
  const ms = lastMs;
  const high = Math.floor(ms / 0x1_0000_0000);
  const low = ms >>> 0;

  bytes[0] = (high >>> 8) & 0xff;
  bytes[1] = high & 0xff;
  bytes[2] = (low >>> 24) & 0xff;
  bytes[3] = (low >>> 16) & 0xff;
  bytes[4] = (low >>> 8) & 0xff;
  bytes[5] = low & 0xff;

  // version 7 in the high nibble, then the top 4 bits of the counter.
  bytes[6] = 0x70 | ((counter >>> 8) & 0x0f);
  bytes[7] = counter & 0xff;

  // RFC 4122 variant (0b10) in the top two bits; the remaining 62 bits stay as
  // drawn from the CSPRNG.
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);

  return format(bytes);
}

/**
 * Generates a new branded id.
 *
 * The `unsafeAsId` here is sound in a way it is not at a trust boundary: the
 * value was produced two lines above by this module, so there is nothing to
 * validate. Call sites read `newId<'CardId'>()`, which keeps the genuinely
 * unsafe cast out of everyday code.
 */
export function newId<B extends string>(): Id<B> {
  return unsafeAsId<B>(uuidv7());
}

/**
 * Recovers the embedded timestamp from a v7 UUID.
 *
 * Useful for retention sweeps and debugging. NOT a substitute for a `created_at`
 * column: the value is supplied by whichever process minted the id, so it is
 * only as trustworthy as that process's clock.
 *
 * Returns `undefined` for anything that is not a v7 UUID.
 */
export function timestampOf(uuid: string): Date | undefined {
  const hex = uuid.replace(/-/g, '');
  if (hex.length !== 32 || hex[12] !== '7') return undefined;

  const ms = Number.parseInt(hex.slice(0, 12), 16);
  return Number.isNaN(ms) ? undefined : new Date(ms);
}

function format(bytes: Uint8Array): string {
  const hex = Buffer.from(bytes).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
