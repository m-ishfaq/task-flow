/**
 * A sliding-window rate limit counter (PLAN.md §8.9).
 *
 * ## Why not fixed windows
 *
 * A fixed window resets on a boundary, so a caller limited to 5 per 15 minutes
 * can send 5 at 14:59 and 5 more at 15:00 — 10 in two seconds, which is exactly
 * the burst the limit exists to stop. This keeps the previous window's count and
 * weights it by how far into the current window we are, which costs one extra
 * integer per key and removes the boundary entirely.
 *
 * ## Why not a sliding log
 *
 * Exact, and stores a timestamp per request. That is an attacker-controlled
 * allocation: the memory cost of hitting a rate limit should not scale with how
 * hard someone hits it.
 *
 * ## What this does NOT do
 *
 * Counters live in this process. Two API instances mean a caller gets roughly
 * twice the quota, and a restart forgives everyone. That is the documented
 * free-tier position (§12) — adequate at single-instance scale, and the reason
 * the account lockout in identity.service.ts is a SEPARATE, database-backed
 * control rather than a second use of this one. Per-account guessing is stopped
 * by something that survives a restart.
 */

export interface RateLimitRule {
  /** Requests permitted per window. */
  readonly limit: number;
  readonly windowMs: number;
}

export interface RateLimitVerdict {
  readonly allowed: boolean;
  /** Whole requests still available in this window, floored at 0. */
  readonly remaining: number;
  /** Only meaningful when denied. Always at least 1 — a `Retry-After: 0` invites an immediate retry. */
  readonly retryAfterSeconds: number;
}

interface Bucket {
  windowStart: number;
  count: number;
  previousCount: number;
}

/**
 * Upper bound on tracked keys.
 *
 * Without one, an attacker rotating source addresses turns the rate limiter into
 * the denial-of-service it was added to prevent — every new key allocates and
 * nothing ever frees it. At the cap the least-recently-used key is evicted,
 * which forgives whoever has been quiet longest rather than whoever is loudest.
 */
const MAX_KEYS = 50_000;

export class SlidingWindowLimiter {
  /**
   * Insertion order is the LRU order: a hit deletes and re-inserts, so the
   * oldest entry is always first. `Map` guarantees that ordering, which is why
   * this is not a plain object.
   */
  readonly #buckets = new Map<string, Bucket>();
  readonly #maxKeys: number;

  constructor(maxKeys: number = MAX_KEYS) {
    this.#maxKeys = maxKeys;
  }

  /** Tracked key count. For tests and the health surface, not for decisions. */
  get size(): number {
    return this.#buckets.size;
  }

  /**
   * Records an attempt against `key` and says whether it is permitted.
   *
   * A DENIED attempt is not counted. Counting it would let a caller who is
   * already over the limit hold themselves over it indefinitely by continuing to
   * retry — the limit would never decay while they kept knocking, which turns a
   * temporary throttle into a permanent lockout an attacker can inflict on
   * someone else's shared IP.
   */
  check(key: string, rule: RateLimitRule, now: number = Date.now()): RateLimitVerdict {
    const windowStart = Math.floor(now / rule.windowMs) * rule.windowMs;
    const bucket = this.#bucketFor(key, windowStart, rule.windowMs);

    const elapsed = (now - windowStart) / rule.windowMs;
    const estimate = bucket.previousCount * (1 - elapsed) + bucket.count;

    if (estimate >= rule.limit) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: retryAfter(bucket, rule, now, windowStart),
      };
    }

    bucket.count += 1;
    return {
      allowed: true,
      remaining: Math.max(0, Math.floor(rule.limit - estimate - 1)),
      retryAfterSeconds: 0,
    };
  }

  /** Drops every key. For test isolation — counters must not leak between cases. */
  reset(): void {
    this.#buckets.clear();
  }

  #bucketFor(key: string, windowStart: number, windowMs: number): Bucket {
    const existing = this.#buckets.get(key);

    if (existing !== undefined) {
      // Re-insert to mark it most-recently-used.
      this.#buckets.delete(key);
      this.#buckets.set(key, existing);

      if (existing.windowStart !== windowStart) {
        const gap = (windowStart - existing.windowStart) / windowMs;
        /* One window on means the count we just left becomes the weighted
           history. More than one means the caller was silent for a whole window,
           so there is no history worth carrying. */
        existing.previousCount = gap === 1 ? existing.count : 0;
        existing.count = 0;
        existing.windowStart = windowStart;
      }
      return existing;
    }

    this.#evictIfFull();
    const fresh: Bucket = { windowStart, count: 0, previousCount: 0 };
    this.#buckets.set(key, fresh);
    return fresh;
  }

  #evictIfFull(): void {
    if (this.#buckets.size < this.#maxKeys) return;

    // One eviction per insertion keeps this O(1); a full sweep here would make
    // the cost of being at capacity fall on a single unlucky request.
    const oldest = this.#buckets.keys().next();
    if (!oldest.done) this.#buckets.delete(oldest.value);
  }
}

/**
 * How long until this key would be permitted again.
 *
 * Worth computing properly rather than returning the window length: a
 * `Retry-After` that overstates makes a well-behaved client wait far longer than
 * it must, and one that understates makes it retry into another denial — which
 * is indistinguishable, from the server's side, from the abuse being limited.
 */
function retryAfter(bucket: Bucket, rule: RateLimitRule, now: number, windowStart: number): number {
  const remainingWindowMs = windowStart + rule.windowMs - now;

  /* The current window can still save us only if the count accrued INSIDE it is
     already under the limit — the weighted history decays to nothing by the
     window's end, but `count` does not decay at all. */
  if (bucket.count < rule.limit && bucket.previousCount > 0) {
    // Solve prev * (1 - e) + count < limit for the window fraction e.
    const neededFraction = 1 - (rule.limit - bucket.count) / bucket.previousCount;
    const targetMs = windowStart + neededFraction * rule.windowMs;
    if (targetMs > now) return Math.max(1, Math.ceil((targetMs - now) / 1000));
  }

  /* Otherwise the wait runs past this window: at the next boundary `count`
     becomes the history and only then starts to decay. The extra second matters
     — landing exactly on the boundary means the weighted estimate still equals
     `count`, so a client that obeyed Retry-After to the millisecond would be
     refused again and learn to ignore it. */
  return Math.max(1, Math.ceil(remainingWindowMs / 1000) + 1);
}
