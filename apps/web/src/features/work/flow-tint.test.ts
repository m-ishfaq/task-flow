import { describe, expect, it } from 'vitest';
import { flowTintGradient } from './flow-tint.js';

/**
 * `flowTintGradient`'s own mix-percentage math — see `list-column.tsx`'s
 * header for why this reads a column's rank-order position rather than its
 * name. Asserted on the mix percentage embedded in the returned CSS value,
 * not the whole string, so a change to the neutral gradient's own recipe
 * (kept in sync with `styles.css`'s `.column-container` by hand) does not
 * break every case here for an unrelated reason.
 */

const list = (listId: string) => ({ listId });

function mixPercentOf(gradient: string): string {
  const match = /--color-accent\) (\d+)%/.exec(gradient);
  if (match?.[1] === undefined) {
    throw new Error(`no accent mix percentage found in: ${gradient}`);
  }
  return match[1];
}

describe('flowTintGradient', () => {
  it('is 0% at the first column', () => {
    const siblings = [list('a'), list('b'), list('c')];
    expect(mixPercentOf(flowTintGradient(list('a'), siblings))).toBe('0');
  });

  it('is at its strongest (9%) at the last column', () => {
    const siblings = [list('a'), list('b'), list('c')];
    expect(mixPercentOf(flowTintGradient(list('c'), siblings))).toBe('9');
  });

  it('is somewhere between the two at a middle column', () => {
    const siblings = [list('a'), list('b'), list('c')];
    const percent = Number(mixPercentOf(flowTintGradient(list('b'), siblings)));
    expect(percent).toBeGreaterThan(0);
    expect(percent).toBeLessThan(9);
  });

  it('does not divide by zero for a single-column board', () => {
    const siblings = [list('only')];
    expect(mixPercentOf(flowTintGradient(list('only'), siblings))).toBe('0');
  });

  it('falls back to 0% rather than throwing if the list is somehow not in siblings', () => {
    const siblings = [list('a'), list('b')];
    expect(mixPercentOf(flowTintGradient(list('missing'), siblings))).toBe('0');
  });

  it('always layers the same neutral surface-sunken gradient underneath', () => {
    const siblings = [list('a'), list('b')];
    const gradient = flowTintGradient(list('b'), siblings);
    expect(gradient).toContain('var(--color-surface-sunken)');
  });
});
