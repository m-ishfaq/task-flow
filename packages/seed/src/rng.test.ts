import { describe, expect, it } from 'vitest';
import { createRng } from './rng.js';

describe('createRng', () => {
  it('is deterministic: the same seed produces the same sequence', () => {
    const a = createRng('taskflow-42');
    const b = createRng('taskflow-42');

    const drawn = () => [a.next(), a.int(0, 1000), a.pick([1, 2, 3, 4, 5]), a.chance(0.5)];
    const expected = [b.next(), b.int(0, 1000), b.pick([1, 2, 3, 4, 5]), b.chance(0.5)];

    expect(drawn()).toEqual(expected);
  });

  it('produces a different sequence for a different seed', () => {
    const a = createRng('seed-a');
    const b = createRng('seed-b');

    const sequenceOf = (rng: ReturnType<typeof createRng>) =>
      Array.from({ length: 20 }, () => rng.next());

    expect(sequenceOf(a)).not.toEqual(sequenceOf(b));
  });

  it('next() stays within [0, 1)', () => {
    const rng = createRng('bounds');
    for (let i = 0; i < 2000; i += 1) {
      const value = rng.next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('int() is inclusive on both ends and never out of range', () => {
    const rng = createRng('int-bounds');
    const seen = new Set<number>();
    for (let i = 0; i < 500; i += 1) {
      const value = rng.int(3, 7);
      expect(value).toBeGreaterThanOrEqual(3);
      expect(value).toBeLessThanOrEqual(7);
      seen.add(value);
    }
    // With 500 draws over a 5-value range, every value should appear at least once.
    expect(seen).toEqual(new Set([3, 4, 5, 6, 7]));
  });

  it('int() rejects an empty range', () => {
    const rng = createRng('int-empty');
    expect(() => rng.int(5, 4)).toThrow();
  });

  it('pick() throws on an empty list rather than returning undefined', () => {
    const rng = createRng('pick-empty');
    expect(() => rng.pick([])).toThrow();
  });

  it('sample() returns distinct elements and caps at the list length', () => {
    const rng = createRng('sample');
    const items = [1, 2, 3, 4, 5];

    const three = rng.sample(items, 3);
    expect(three).toHaveLength(3);
    expect(new Set(three).size).toBe(3);
    for (const value of three) expect(items).toContain(value);

    const overCount = rng.sample(items, 10);
    expect(overCount).toHaveLength(items.length);
    expect(new Set(overCount)).toEqual(new Set(items));
  });

  it('chance(0) is never true and chance(1) is always true', () => {
    const rng = createRng('chance-bounds');
    for (let i = 0; i < 200; i += 1) {
      expect(rng.chance(0)).toBe(false);
      expect(rng.chance(1)).toBe(true);
    }
  });

  it('weighted() only ever returns a listed value, biased toward the heavier weight', () => {
    const rng = createRng('weighted');
    const counts = { a: 0, b: 0 };
    for (let i = 0; i < 1000; i += 1) {
      const value = rng.weighted([
        ['a', 9],
        ['b', 1],
      ] as const);
      counts[value] += 1;
    }
    expect(counts.a + counts.b).toBe(1000);
    expect(counts.a).toBeGreaterThan(counts.b);
  });

  it('shuffle() does not mutate its input and preserves the multiset', () => {
    const rng = createRng('shuffle');
    const items = [1, 2, 3, 4, 5];
    const copy = [...items];

    const shuffled = rng.shuffle(items);

    expect(items).toEqual(copy);
    expect([...shuffled].sort()).toEqual([...items].sort());
  });

  it('uuid() produces a well-formed, deterministic UUIDv7', () => {
    const rng = createRng('uuid-shape');
    const at = new Date('2026-01-15T10:00:00.000Z');
    const id = rng.uuid(at);

    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    const again = createRng('uuid-shape').uuid(at);
    expect(again).toBe(id);
  });

  it('uuid() encodes the given timestamp in its first 48 bits', () => {
    const rng = createRng('uuid-timestamp');
    const at = new Date('2026-06-01T00:00:00.000Z');
    const id = rng.uuid(at);
    const ms = id.slice(0, 8) + id.slice(9, 13);
    expect(parseInt(ms, 16)).toBe(at.getTime());
  });

  it('fork() produces an independent, deterministic stream per label', () => {
    const root = createRng('fork-root');
    const a1 = root.fork('a');
    const a2 = createRng('fork-root').fork('a');
    const b = root.fork('b');

    expect(a1.next()).toBe(a2.next());
    expect(a1.next()).not.toBe(b.next());
  });

  it("drawing from a fork does not disturb the parent's own sequence", () => {
    const rng = createRng('fork-isolation');
    const parentUntouched = createRng('fork-isolation');

    rng.fork('child').next();
    rng.fork('child').int(0, 100);

    expect(rng.next()).toBe(parentUntouched.next());
  });
});
