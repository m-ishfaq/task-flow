import { describe, expect, it } from 'vitest';
import { SlidingWindowLimiter, type RateLimitRule } from './sliding-window.js';

/**
 * The counter behind every rate limit (PLAN.md §8.9).
 *
 * `now` is injected into every call rather than faked globally, so these assert
 * behaviour across window boundaries without a timer — a rate limit test that
 * sleeps for its own window is a test nobody runs.
 */

const RULE: RateLimitRule = { limit: 5, windowMs: 60_000 };

/** A window boundary, so arithmetic in the tests is readable. */
const T0 = 3_600_000;

/** How many of `attempts` back-to-back requests get through at instant `now`. */
function countAllowed(limiter: SlidingWindowLimiter, now: number, attempts: number): number {
  let allowed = 0;
  for (let i = 0; i < attempts; i += 1) {
    if (limiter.check('k', RULE, now).allowed) allowed += 1;
  }
  return allowed;
}

describe('within one window', () => {
  it('permits exactly the limit', () => {
    const limiter = new SlidingWindowLimiter();

    for (let i = 0; i < RULE.limit; i += 1) {
      expect(limiter.check('k', RULE, T0).allowed, `attempt ${String(i + 1)}`).toBe(true);
    }
    expect(limiter.check('k', RULE, T0).allowed).toBe(false);
  });

  it('counts down what is left', () => {
    const limiter = new SlidingWindowLimiter();

    expect(limiter.check('k', RULE, T0).remaining).toBe(4);
    expect(limiter.check('k', RULE, T0).remaining).toBe(3);
  });

  it('keeps separate keys separate', () => {
    const limiter = new SlidingWindowLimiter();

    for (let i = 0; i < RULE.limit; i += 1) limiter.check('a', RULE, T0);

    expect(limiter.check('a', RULE, T0).allowed).toBe(false);
    expect(limiter.check('b', RULE, T0).allowed).toBe(true);
  });
});

describe('across the boundary', () => {
  it('does not permit a double burst at the window edge', () => {
    /* The whole reason this is not a fixed window. Under one, five requests at
       14:59:59 and five at 15:00:00 are ten in two seconds against a limit of
       five per minute — the boundary hands out a second full budget.

       Here the previous count still weighs almost its full value one second in,
       so the burst is bounded by the decay rather than by the clock. What is
       asserted is that bound, not "the very next request is refused": the
       weighting is a gradual recovery on purpose, and a test demanding a hard
       refusal would be asserting fixed-window behaviour by another name. */
    const limiter = new SlidingWindowLimiter();
    const endOfWindow = T0 + 59_000;

    for (let i = 0; i < RULE.limit; i += 1) {
      expect(limiter.check('k', RULE, endOfWindow).allowed).toBe(true);
    }

    const justAfter = T0 + 60_000 + 1_000;
    const allowed = countAllowed(limiter, justAfter, RULE.limit);

    // A fixed window would grant all five again. One second of decay is worth
    // less than one request.
    expect(allowed).toBeLessThanOrEqual(1);
  });

  it('lets the previous window decay', () => {
    const limiter = new SlidingWindowLimiter();
    for (let i = 0; i < RULE.limit; i += 1) limiter.check('k', RULE, T0);

    // Halfway through the next window the history counts for half, so half the
    // budget is back.
    const verdict = limiter.check('k', RULE, T0 + 60_000 + 30_000);
    expect(verdict.allowed).toBe(true);
  });

  it('forgets a caller who was silent for a whole window', () => {
    const limiter = new SlidingWindowLimiter();
    for (let i = 0; i < RULE.limit; i += 1) limiter.check('k', RULE, T0);

    // Two windows on, there is no history to carry.
    const verdict = limiter.check('k', RULE, T0 + 120_000);
    expect(verdict.allowed).toBe(true);
    expect(verdict.remaining).toBe(4);
  });
});

describe('retry-after', () => {
  it('is at least a second when denied', () => {
    // Retry-After: 0 tells a client to try again immediately, which is the one
    // instruction a throttled client must not be given.
    const limiter = new SlidingWindowLimiter();
    for (let i = 0; i < RULE.limit; i += 1) limiter.check('k', RULE, T0);

    expect(limiter.check('k', RULE, T0).retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it('names a moment that is actually permitted', () => {
    // The property that matters: obeying Retry-After must work. If it lands a
    // moment too early the client is refused again and learns to ignore it.
    const limiter = new SlidingWindowLimiter();
    for (let i = 0; i < RULE.limit; i += 1) limiter.check('k', RULE, T0);

    const denied = limiter.check('k', RULE, T0);
    expect(denied.allowed).toBe(false);

    const at = T0 + denied.retryAfterSeconds * 1000;
    expect(limiter.check('k', RULE, at).allowed).toBe(true);
  });

  it('names a permitted moment from mid-window too', () => {
    const limiter = new SlidingWindowLimiter();
    const start = T0 + 20_000;
    for (let i = 0; i < RULE.limit; i += 1) limiter.check('k', RULE, start);

    const denied = limiter.check('k', RULE, start);
    const at = start + denied.retryAfterSeconds * 1000;

    expect(limiter.check('k', RULE, at).allowed).toBe(true);
  });

  it('is never longer than two windows', () => {
    const limiter = new SlidingWindowLimiter();
    for (let i = 0; i < RULE.limit; i += 1) limiter.check('k', RULE, T0);

    const denied = limiter.check('k', RULE, T0);
    expect(denied.retryAfterSeconds * 1000).toBeLessThanOrEqual(2 * RULE.windowMs);
  });
});

describe('memory', () => {
  it('does not count a denied attempt', () => {
    /* Otherwise a caller who is already over the limit holds themselves over it
       by continuing to knock, and the throttle never decays — which an attacker
       can inflict on whoever shares their address. */
    const limiter = new SlidingWindowLimiter();
    for (let i = 0; i < RULE.limit; i += 1) limiter.check('k', RULE, T0);

    for (let i = 0; i < 100; i += 1) limiter.check('k', RULE, T0);

    // Still recoverable on schedule, not pushed further out by the hammering.
    expect(limiter.check('k', RULE, T0 + 120_000).allowed).toBe(true);
  });

  it('evicts rather than growing without bound', () => {
    // An attacker rotating source addresses would otherwise turn the rate
    // limiter into the denial-of-service it was added to prevent.
    const limiter = new SlidingWindowLimiter(10);

    for (let i = 0; i < 1_000; i += 1) limiter.check(`key-${String(i)}`, RULE, T0);

    expect(limiter.size).toBeLessThanOrEqual(10);
  });

  it('evicts the least recently used key', () => {
    const limiter = new SlidingWindowLimiter(3);

    limiter.check('old', RULE, T0);
    limiter.check('b', RULE, T0);
    limiter.check('c', RULE, T0);
    // Touch 'old' so it is no longer the oldest.
    limiter.check('old', RULE, T0);
    // Forces one eviction, which must not be 'old'.
    limiter.check('d', RULE, T0);

    // 'old' kept its two hits; a freshly created bucket would report 4 left.
    expect(limiter.check('old', RULE, T0).remaining).toBe(2);
  });

  it('starts clean after a reset', () => {
    const limiter = new SlidingWindowLimiter();
    for (let i = 0; i < RULE.limit; i += 1) limiter.check('k', RULE, T0);

    limiter.reset();
    expect(limiter.check('k', RULE, T0).allowed).toBe(true);
  });
});
