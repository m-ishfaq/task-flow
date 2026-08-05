import { describe, expect, it } from 'vitest';
import { FixedWindowLimiter } from './rate-limit.js';

/**
 * The fixed-window limiter behind §6.5 and §7.5's connection, join, and
 * refused-join budgets.
 */

describe('FixedWindowLimiter', () => {
  it('allows up to the limit within a window', () => {
    const limiter = new FixedWindowLimiter(3);

    expect(limiter.hit('a')).toBe(true);
    expect(limiter.hit('a')).toBe(true);
    expect(limiter.hit('a')).toBe(true);
    expect(limiter.hit('a')).toBe(false);
  });

  it('counts the refused attempt too, not just successes', () => {
    // §7.5: a limiter that only counted successes would let the enumeration
    // loop it exists to stop run forever, since every one of its attempts
    // fails by design.
    const limiter = new FixedWindowLimiter(1);

    expect(limiter.hit('a')).toBe(true);
    expect(limiter.hit('a')).toBe(false);
    expect(limiter.hit('a')).toBe(false);
    expect(limiter.hit('a')).toBe(false);
  });

  it('keeps separate budgets per key', () => {
    const limiter = new FixedWindowLimiter(1);

    expect(limiter.hit('a')).toBe(true);
    expect(limiter.hit('b')).toBe(true);
    expect(limiter.hit('a')).toBe(false);
    expect(limiter.hit('b')).toBe(false);
  });

  it('resets the budget once the window has elapsed', async () => {
    // hit() reads Date.now() internally with no injectable clock, so proving
    // a window resets means waiting out a real, short one rather than faking
    // time — adding a clock seam only for this test would be a change to the
    // module under test for a property a 30ms wait demonstrates directly.
    const WINDOW_MS = 30;
    const limiter = new FixedWindowLimiter(1, WINDOW_MS);

    expect(limiter.hit('a')).toBe(true);
    expect(limiter.hit('a')).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, WINDOW_MS + 10));

    expect(limiter.hit('a')).toBe(true);
  });

  it('sweep drops expired windows, forget drops one key', () => {
    const limiter = new FixedWindowLimiter(1, 0);

    limiter.hit('a');
    limiter.hit('b');
    expect(limiter.size).toBe(2);

    // windowMs = 0 means every window is already expired at the moment it is
    // checked against `Date.now()` a tick later.
    limiter.sweep(Date.now() + 1);
    expect(limiter.size).toBe(0);

    limiter.hit('c');
    expect(limiter.size).toBe(1);
    limiter.forget('c');
    expect(limiter.size).toBe(0);
  });
});
