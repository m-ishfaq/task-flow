import { describe, expect, it } from 'vitest';
import { buildDuplicateQuery, MIN_DUPLICATE_QUERY_LENGTH } from './duplicate-detect.js';

describe('buildDuplicateQuery', () => {
  it('returns null below the minimum length', () => {
    expect(buildDuplicateQuery('')).toBeNull();
    expect(buildDuplicateQuery('a')).toBeNull();
    expect(buildDuplicateQuery('ab')).toBeNull();
  });

  it('trims before measuring length, so padding does not count', () => {
    expect(buildDuplicateQuery('  ab  ')).toBeNull();
    expect(buildDuplicateQuery(`  ${'a'.repeat(MIN_DUPLICATE_QUERY_LENGTH)}  `)).not.toBeNull();
  });

  it('builds a type:card query once the title is long enough', () => {
    expect(buildDuplicateQuery('Fix login redirect')).toBe('type:card Fix login redirect');
  });

  it('embeds the trimmed title verbatim, not the raw one', () => {
    expect(buildDuplicateQuery('  Fix login redirect  ')).toBe('type:card Fix login redirect');
  });
});
