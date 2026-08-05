/**
 * Rate limiting for connections and room joins (§6.5, §7.5).
 *
 * ## Why this exists when `can()` already refuses
 *
 * `can()` correctly refusing every attempt in an enumeration loop is not the
 * same as that loop being free. One valid token is enough to attempt joining
 * every board id in the system as fast as the event loop will carry it: each
 * attempt is a `loadTuples` query and a membership read, so an unbounded refusal
 * path is both a resource-exhaustion vector and the reconnaissance phase of an
 * attack, whether or not any individual attempt succeeds.
 *
 * ## Why its own numbers, not the login limiter's
 *
 * `apps/api/src/middleware/rate-limit.ts` was tuned for login and password-reset
 * abuse — bursts against one account. Traffic here has a different shape
 * entirely: one connection per browser tab, then a handful of joins, then hours
 * of silence. A limiter calibrated for the first shape is either useless or
 * hostile against the second.
 *
 * ## In-process, and that is a real limitation
 *
 * A fixed window in a `Map`, per gateway instance. Two instances behind a load
 * balancer each enforce their own budget, so the effective limit is N times the
 * configured one. Accepted for Wave 1 because the control is a brake on
 * automated volume rather than a precise quota, and because the alternative —
 * Redis, or a Postgres round-trip per join — adds a dependency and a failure
 * mode to a path that must stay cheap. If a shared counter is ever needed, this
 * module is the only thing that changes.
 *
 * The counters are keyed by address only for connections; join limits are per
 * SOCKET, which needs no shared state to be correct because a socket lives on
 * exactly one instance by definition.
 */

const WINDOW_MS = 60_000;

interface Window {
  count: number;
  /** Epoch ms at which this window resets. */
  resetAt: number;
}

/**
 * A fixed-window counter.
 *
 * Fixed rather than sliding: a sliding window needs per-event timestamps, which
 * is a list per key rather than two numbers, and the burst a fixed window allows
 * at a boundary (up to 2x the limit across two adjacent windows) is not
 * interesting for a control whose job is to stop sustained automated volume.
 */
export class FixedWindowLimiter {
  private readonly windows = new Map<string, Window>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number = WINDOW_MS,
  ) {}

  /**
   * Records one attempt and reports whether it is within budget.
   *
   * Counts the REFUSED attempt too. A limiter that only counted successes would
   * let the enumeration loop this exists to stop run forever, since every one of
   * its attempts fails by design.
   */
  hit(key: string): boolean {
    const now = Date.now();
    const existing = this.windows.get(key);

    if (existing === undefined || now >= existing.resetAt) {
      this.windows.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }

    existing.count += 1;
    return existing.count <= this.limit;
  }

  /**
   * Drops windows that have expired.
   *
   * Without this the map is an unbounded memory leak keyed by remote address —
   * a slow one, which is why it would be found in production rather than in a
   * test. Called on a timer by the gateway, not on every hit: sweeping inside
   * `hit` would make one caller pay for every other key's garbage.
   */
  sweep(now = Date.now()): void {
    for (const [key, window] of this.windows) {
      if (now >= window.resetAt) this.windows.delete(key);
    }
  }

  /** Forgets one key. Called when a socket disconnects, for per-socket keys. */
  forget(key: string): void {
    this.windows.delete(key);
  }

  /** Live key count, for the gateway's diagnostics. */
  get size(): number {
    return this.windows.size;
  }
}
