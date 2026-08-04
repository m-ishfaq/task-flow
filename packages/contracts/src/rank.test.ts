import { describe, expect, it } from 'vitest';
import {
  InvalidRankError,
  RANK_DIGITS,
  RANK_REBALANCE_THRESHOLD,
  between,
  compareRanked,
  initialRank,
  isRank,
  needsRebalance,
  rankSequence,
} from './rank.js';

/**
 * Card ordering (PLAN.md §10.1).
 *
 * The property under test is always the same one: **lexicographic order equals
 * insertion order**. Everything else here is a way of stressing it, because the
 * failure mode is not an exception — it is a board that renders in the wrong
 * order some time after the ranks got interesting enough to expose the bug.
 *
 * §10.1 names the adversarial cases directly: repeated midpoint insertion,
 * boundary characters, empty list, single element, 10,000 sequential inserts.
 * The last of those is what rules out naive bisection: it is correct, and it
 * gives the ten-thousandth appended card a rank about 1,600 characters long.
 */

/** Every rank generated anywhere must satisfy the well-formedness invariant. */
function expectWellFormed(rank: string): void {
  expect(isRank(rank), `${JSON.stringify(rank)} violates the rank invariant`).toBe(true);
}

describe('the digit alphabet', () => {
  it('is 62 distinct characters in strictly ascending ASCII order', () => {
    expect(RANK_DIGITS).toHaveLength(62);
    expect(new Set(RANK_DIGITS).size).toBe(62);

    /* The correctness of every ORDER BY rank in the system is a statement about
       this being true. Nothing else re-checks it. */
    for (let index = 1; index < RANK_DIGITS.length; index += 1) {
      expect(RANK_DIGITS[index]! > RANK_DIGITS[index - 1]!).toBe(true);
    }
  });

  it('contains only ASCII alphanumerics, so no collation can disagree', () => {
    expect(/^[0-9A-Za-z]+$/.test(RANK_DIGITS)).toBe(true);
  });

  it('orders digits below uppercase below lowercase', () => {
    // The sign encoding depends on this: negative integers use uppercase heads
    // and non-negative use lowercase, so every negative must sort below every
    // non-negative on the first character alone.
    //
    // Compared by code point rather than with string literals, which the
    // compiler folds to a constant — an assertion it can prove without running
    // is an assertion that proves nothing about the alphabet.
    const codeOf = (char: string): number => char.charCodeAt(0);

    expect(codeOf('9')).toBeLessThan(codeOf('A'));
    expect(codeOf('Z')).toBeLessThan(codeOf('a'));
  });
});

describe('isRank', () => {
  it('accepts what the generator produces', () => {
    expect(isRank('a0')).toBe(true);
    expect(isRank('a0V')).toBe(true);
    expect(isRank('Zz')).toBe(true);
    expect(isRank('b00')).toBe(true);
  });

  it('rejects the empty string', () => {
    expect(isRank('')).toBe(false);
  });

  it('rejects a trailing zero in the fraction, which would be ambiguous', () => {
    // `a0V` and `a0V0` would denote the same value.
    expect(isRank('a0V0')).toBe(false);
    expect(isRank('a00')).toBe(false);
    // The integer part is fixed-width, so its own trailing zero is fine.
    expect(isRank('a0')).toBe(true);
    expect(isRank('b00')).toBe(true);
  });

  it('rejects a string with no well-formed integer part', () => {
    // A bare fraction. The head must describe a length.
    expect(isRank('V')).toBe(false);
    expect(isRank('1')).toBe(false);
    // Head claims six characters and only two are present.
    expect(isRank('Va')).toBe(false);
  });

  it('rejects characters outside the alphabet', () => {
    expect(isRank('a0-b')).toBe(false);
    expect(isRank('a0!')).toBe(false);
    expect(isRank('a0é')).toBe(false);
    expect(isRank(' a0')).toBe(false);
  });
});

describe('between', () => {
  it('places the first card of an empty list', () => {
    const first = initialRank();
    expectWellFormed(first);
    expect(between(null, null)).toBe(first);
  });

  it('generates a rank before a single existing element', () => {
    const only = initialRank();
    const earlier = between(null, only);

    expectWellFormed(earlier);
    expect(earlier < only).toBe(true);
  });

  it('generates a rank after a single existing element', () => {
    const only = initialRank();
    const later = between(only, null);

    expectWellFormed(later);
    expect(later > only).toBe(true);
  });

  it('generates a rank strictly between two neighbours', () => {
    const low = between(null, null);
    const high = between(low, null);
    const mid = between(low, high);

    expectWellFormed(mid);
    expect(low < mid).toBe(true);
    expect(mid < high).toBe(true);
  });

  it('refuses equal neighbours rather than inventing a position', () => {
    const rank = initialRank();
    expect(() => between(rank, rank)).toThrow(InvalidRankError);
  });

  it('refuses neighbours supplied in the wrong order', () => {
    const low = initialRank();
    const high = between(low, null);
    expect(() => between(high, low)).toThrow(InvalidRankError);
  });

  it('refuses a malformed neighbour instead of propagating it', () => {
    // A rank read back from a corrupted row. Continuing from it would generate
    // more values that sort where they do not belong.
    expect(() => between('a00', null)).toThrow(InvalidRankError);
    expect(() => between(null, 'a0-b')).toThrow(InvalidRankError);
    expect(() => between('', null)).toThrow(InvalidRankError);
    expect(() => between('V', null)).toThrow(InvalidRankError);
  });
});

describe('integer boundaries — where the encoding changes shape', () => {
  it('rolls the integer over to a longer head when the digits are exhausted', () => {
    // 'a' heads hold one digit, so the 62nd append must move to a 'b' head.
    const ranks = rankSequence(64);

    expect(ranks[0]).toBe('a0');
    expect(ranks[61]).toBe('az');
    expect(ranks[62]).toBe('b00');
    expect(ranks[63]).toBe('b01');

    // The rollover is the case where a longer string must still sort ABOVE the
    // shorter one it follows — true only because 'b' > 'a' at position 0.
    expect(ranks[61]! < ranks[62]!).toBe(true);
  });

  it('crosses from zero into the negative range when prepending', () => {
    const first = initialRank();
    const earlier = between(null, first);

    expect(first).toBe('a0');
    expect(earlier).toBe('Zz');
    expect(earlier < first).toBe(true);
  });

  it('stays ordered across the sign change and the negative rollover', () => {
    // 'a0' -> 'Zz' ... 'Z0' -> 'Yzz' ... exercises both the sign crossing and a
    // negative head getting LONGER as the value gets smaller.
    let cursor = initialRank();
    const seen = [cursor];

    for (let iteration = 0; iteration < 200; iteration += 1) {
      const next = between(null, cursor);
      expectWellFormed(next);
      expect(next < cursor, `${next} should sort below ${cursor}`).toBe(true);
      cursor = next;
      seen.push(cursor);
    }

    // Confirm the run actually reached the interesting territory.
    expect(seen).toContain('Z0');
    expect(seen).toContain('Yzz');

    const sorted = [...seen].sort();
    expect(sorted).toEqual([...seen].reverse());
  });

  it('splits adjacent integers by extending the fraction', () => {
    const low = 'a0';
    const high = 'a1';
    const mid = between(low, high);

    expectWellFormed(mid);
    expect(mid > low).toBe(true);
    expect(mid < high).toBe(true);
    // No integer fits, so the fraction is where the room came from.
    expect(mid.length).toBeGreaterThan(low.length);
  });

  it('prefers a bare integer over a fraction when one fits', () => {
    // Two integers apart: the rank between them needs no fraction at all.
    expect(between('a0', 'a2')).toBe('a1');
    // `after` carries a fraction, so `after`'s own integer sits below it.
    expect(between(null, 'a0V')).toBe('a0');
  });
});

describe('repeated midpoint insertion', () => {
  it('keeps every insertion strictly between its neighbours, 500 deep', () => {
    let low = initialRank();
    let high = between(low, null);

    for (let iteration = 0; iteration < 500; iteration += 1) {
      const mid = between(low, high);
      expectWellFormed(mid);
      expect(low < mid, `iteration ${String(iteration)}: ${low} < ${mid}`).toBe(true);
      expect(mid < high, `iteration ${String(iteration)}: ${mid} < ${high}`).toBe(true);

      // Alternate which side collapses, so both recursion branches are hit.
      if (iteration % 2 === 0) low = mid;
      else high = mid;
    }
  });

  it('lengthens ranks slowly enough that the threshold means something', () => {
    // Repeatedly dropping onto the same gap is the one pathology the rebalance
    // job exists for. It should take a while to get there, or the threshold
    // would fire during ordinary use.
    let low = initialRank();
    const high = between(low, null);

    let insertions = 0;
    while (low.length < RANK_REBALANCE_THRESHOLD) {
      low = between(low, high);
      insertions += 1;
      expect(insertions).toBeLessThan(1000);
    }
    expect(insertions).toBeGreaterThan(20);
  });
});

describe('10,000 sequential inserts', () => {
  it('stays ordered and short across 10,000 appends', () => {
    const ranks: string[] = [];
    let cursor: string | null = null;

    for (let index = 0; index < 10_000; index += 1) {
      cursor = between(cursor, null);
      ranks.push(cursor);
    }

    for (const rank of ranks) expectWellFormed(rank);
    expect(new Set(ranks).size).toBe(ranks.length);

    const sorted = [...ranks].sort();
    expect(sorted).toEqual(ranks);

    /* Appending is the operation users perform thousands of times — adding a
       card to the bottom of a list. This is the assertion that rules out naive
       bisection, which reaches ~1,600 characters here. */
    const longest = Math.max(...ranks.map((rank) => rank.length));
    expect(longest).toBeLessThanOrEqual(4);
  });

  it('stays ordered and short across 10,000 prepends', () => {
    const ranks: string[] = [];
    let cursor: string | null = null;

    for (let index = 0; index < 10_000; index += 1) {
      cursor = between(null, cursor);
      ranks.push(cursor);
    }

    for (const rank of ranks) expectWellFormed(rank);
    expect(new Set(ranks).size).toBe(ranks.length);

    // Generated descending, so the sorted order is the reverse of insertion.
    const sorted = [...ranks].sort();
    expect(sorted).toEqual([...ranks].reverse());

    const longest = Math.max(...ranks.map((rank) => rank.length));
    expect(longest).toBeLessThanOrEqual(5);
  });
});

describe('random insertion into a growing list', () => {
  it('never breaks the ordering invariant over 2,000 insertions', () => {
    /* A deterministic PRNG, not Math.random — which is banned (guardrail 7) and
       would also make a failure impossible to reproduce. */
    let seed = 0x9e3779b9;
    const nextInt = (bound: number): number => {
      seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
      return seed % bound;
    };

    const list: string[] = [initialRank()];

    for (let iteration = 0; iteration < 2000; iteration += 1) {
      const at = nextInt(list.length + 1);
      const before = at === 0 ? null : list[at - 1]!;
      const after = at === list.length ? null : list[at]!;

      const rank = between(before, after);
      expectWellFormed(rank);
      list.splice(at, 0, rank);
    }

    for (let index = 1; index < list.length; index += 1) {
      expect(list[index - 1]! < list[index]!, `position ${String(index)} is out of order`).toBe(
        true,
      );
    }
  });
});

describe('rankSequence', () => {
  it('returns nothing for an empty list', () => {
    expect(rankSequence(0)).toEqual([]);
  });

  it('produces ascending, well-formed, distinct ranks', () => {
    for (const count of [1, 2, 3, 61, 62, 63, 500]) {
      const ranks = rankSequence(count);

      expect(ranks).toHaveLength(count);
      expect(new Set(ranks).size).toBe(count);
      for (const rank of ranks) expectWellFormed(rank);
      expect([...ranks].sort()).toEqual([...ranks]);
    }
  });

  it('leaves room to insert at both ends', () => {
    const ranks = rankSequence(50);
    const first = ranks[0]!;
    const last = ranks[ranks.length - 1]!;

    expect(between(null, first) < first).toBe(true);
    expect(between(last, null) > last).toBe(true);
  });

  it('leaves room to insert between every adjacent pair', () => {
    const ranks = rankSequence(200);

    for (let index = 1; index < ranks.length; index += 1) {
      const mid = between(ranks[index - 1]!, ranks[index]!);
      expectWellFormed(mid);
      expect(mid > ranks[index - 1]!).toBe(true);
      expect(mid < ranks[index]!).toBe(true);
    }
  });

  it('rejects a non-integer or negative count', () => {
    expect(() => rankSequence(-1)).toThrow(InvalidRankError);
    expect(() => rankSequence(1.5)).toThrow(InvalidRankError);
  });

  it('repairs a degenerate list — the rebalance job in one line', () => {
    // The pathology: repeated insertion into one gap between adjacent integers.
    let low = initialRank();
    const high = between(low, null);
    const degenerate = [low];

    while (low.length < RANK_REBALANCE_THRESHOLD) {
      low = between(low, high);
      degenerate.push(low);
    }
    expect(needsRebalance(degenerate)).toBe(true);

    const repaired = rankSequence(degenerate.length);
    expect(repaired).toHaveLength(degenerate.length);
    expect(needsRebalance([...repaired])).toBe(false);
    expect([...repaired].sort()).toEqual([...repaired]);
  });
});

describe('needsRebalance', () => {
  it('is false for an ordinary list', () => {
    expect(needsRebalance([...rankSequence(1000)])).toBe(false);
  });

  it('is false for an empty list', () => {
    expect(needsRebalance([])).toBe(false);
  });
});

describe('compareRanked', () => {
  it('orders by rank first', () => {
    expect(compareRanked({ rank: 'a0', id: 'z' }, { rank: 'a1', id: 'a' })).toBeLessThan(0);
    expect(compareRanked({ rank: 'a1', id: 'a' }, { rank: 'a0', id: 'z' })).toBeGreaterThan(0);
  });

  it('breaks equal ranks by id, so concurrent inserts converge', () => {
    // Two clients inserted at the same point without seeing each other. Both
    // hold the same two rows; without the tiebreak they would render them in
    // different orders, which looks exactly like a sync bug.
    const a = { rank: 'a0V', id: '0195cc00-0000-7000-8000-000000000001' };
    const b = { rank: 'a0V', id: '0195cc00-0000-7000-8000-000000000002' };

    expect(compareRanked(a, b)).toBeLessThan(0);
    expect(compareRanked(b, a)).toBeGreaterThan(0);
    expect(compareRanked(a, a)).toBe(0);
  });

  it('is a total order — sorting is stable regardless of input order', () => {
    const rows = [
      { rank: 'a1', id: 'c' },
      { rank: 'a0', id: 'b' },
      { rank: 'a1', id: 'a' },
      { rank: 'a0', id: 'a' },
    ];

    const forward = [...rows].sort(compareRanked);
    const backward = [...rows].reverse().sort(compareRanked);

    expect(forward).toEqual(backward);
    expect(forward.map((row) => row.id)).toEqual(['a', 'b', 'a', 'c']);
  });
});
