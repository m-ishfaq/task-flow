import { describe, expect, it } from 'vitest';
import { slugify } from './org-picker.js';

describe('slugify', () => {
  it('lowercases and hyphenates spaces', () => {
    expect(slugify('Acme Corp')).toBe('acme-corp');
  });

  it('collapses runs of non-alphanumeric characters into one hyphen', () => {
    expect(slugify('Acme  &  Co.!!')).toBe('acme-co');
  });

  it('trims leading and trailing hyphens', () => {
    expect(slugify('  -Acme-  ')).toBe('acme');
  });

  it('truncates to 40 characters', () => {
    const long = 'a'.repeat(60);
    expect(slugify(long)).toHaveLength(40);
  });

  it('returns an empty string for input with no alphanumeric characters', () => {
    expect(slugify('!!!')).toBe('');
  });
});
