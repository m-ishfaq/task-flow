import { describe, expect, it } from 'vitest';
import { describeOutcome, runBulk } from './work-bulk.js';

describe('running a bulk action', () => {
  it('applies to every card', async () => {
    const seen: string[] = [];
    const outcome = await runBulk(['a', 'b', 'c'], async (cardId) => {
      seen.push(cardId);
      return Promise.resolve();
    });

    expect(seen.sort()).toEqual(['a', 'b', 'c']);
    expect([...outcome.succeeded].sort()).toEqual(['a', 'b', 'c']);
    expect(outcome.failed).toEqual([]);
  });

  it('keeps the successes when some cards are refused', async () => {
    /* The case the whole module exists for. Per-card authorization means a
       selection spanning two boards SHOULD partly succeed, and `Promise.all`
       would discard the rows it had already changed and report total failure. */
    const outcome = await runBulk(['a', 'b', 'c', 'd'], async (cardId) => {
      if (cardId === 'b' || cardId === 'd') throw new Error('FORBIDDEN');
      return Promise.resolve();
    });

    expect([...outcome.succeeded].sort()).toEqual(['a', 'c']);
    expect(outcome.failed.map((entry) => entry.cardId).sort()).toEqual(['b', 'd']);
  });

  it('never rejects, however many fail', async () => {
    const outcome = await runBulk(['a', 'b'], () => Promise.reject(new Error('nope')));
    expect(outcome.succeeded).toEqual([]);
    expect(outcome.failed).toHaveLength(2);
  });

  it('does not exceed its concurrency limit', async () => {
    let running = 0;
    let peak = 0;

    await runBulk(
      Array.from({ length: 20 }, (_, index) => String(index)),
      async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 1));
        running -= 1;
      },
      4,
    );

    expect(peak).toBeLessThanOrEqual(4);
  });

  it('handles an empty selection without hanging', async () => {
    // `Math.min(concurrency, 0)` would spawn zero workers and never settle if
    // the worker count were not floored at one.
    await expect(runBulk([], () => Promise.resolve())).resolves.toEqual({
      succeeded: [],
      failed: [],
    });
  });
});

describe('describing the outcome', () => {
  it('reports a clean run', () => {
    expect(describeOutcome({ succeeded: ['a', 'b'], failed: [] }, 'updated')).toBe(
      '2 cards updated.',
    );
  });

  it('singularizes one card', () => {
    expect(describeOutcome({ succeeded: ['a'], failed: [] }, 'archived')).toBe('1 card archived.');
  });

  it('says so when some were refused, rather than reporting only the successes', () => {
    /* "8 cards updated" after selecting ten reads like success and hides that
       two were refused. Both numbers or the message is misleading. */
    expect(
      describeOutcome({ succeeded: ['a', 'b'], failed: [{ cardId: 'c', error: null }] }, 'updated'),
    ).toBe('2 cards updated. 1 card could not be changed.');
  });

  it('does not claim a partial success when nothing succeeded', () => {
    expect(
      describeOutcome({ succeeded: [], failed: [{ cardId: 'c', error: null }] }, 'updated'),
    ).toBe('No cards updated — 1 card could not be changed.');
  });
});
