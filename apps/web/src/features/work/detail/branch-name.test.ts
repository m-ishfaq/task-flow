import { describe, expect, it } from 'vitest';
import { defaultBranchName, normalizedBranchName, slugify } from './branch-name.js';

/**
 * The pure half of the branch-name preview (`branch-name.ts`'s own header) —
 * tested directly, the same "test the pure half" split `diff-view.test.ts`/
 * `markdown-lite.test.ts` already establish for this feature, since this is
 * a client-side MIRROR of `automation/branch.service.ts`'s real
 * normalization and has to actually agree with it to be worth showing.
 */

describe('slugify', () => {
  it('lowercases and replaces runs of non-alphanumeric characters with a single hyphen', () => {
    expect(slugify('Fix Login Redirect!!')).toBe('fix-login-redirect');
  });

  it('trims leading and trailing hyphens', () => {
    expect(slugify('  --weird--  ')).toBe('weird');
  });

  it('caps at 50 characters, then trims a trailing hyphen the cut may have introduced', () => {
    const long = 'a'.repeat(60);
    expect(slugify(long)).toHaveLength(50);

    const cutsMidWord = `${'a'.repeat(49)} b`;
    expect(slugify(cutsMidWord)).toBe('a'.repeat(49));
  });
});

describe('defaultBranchName', () => {
  it('joins the slugified reference and title with a hyphen', () => {
    expect(defaultBranchName('WEB-142', 'Fix login redirect')).toBe('web-142-fix-login-redirect');
  });
});

describe('normalizedBranchName', () => {
  it('normalizes an edited name the same way the server will', () => {
    expect(normalizedBranchName('Add Retry Logic', 'WEB-1', 'Fix x')).toBe('add-retry-logic');
  });

  it('falls back to the deterministic default when the edit slugifies to nothing', () => {
    expect(normalizedBranchName('   ', 'WEB-1', 'Fix login redirect')).toBe(
      'web-1-fix-login-redirect',
    );
    expect(normalizedBranchName('!!!', 'WEB-1', 'Fix login redirect')).toBe(
      'web-1-fix-login-redirect',
    );
  });
});
