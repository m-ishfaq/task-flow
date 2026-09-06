import { beforeEach, describe, expect, it } from 'vitest';
import { consumeBootstrapFlag, markOrgForBootstrap } from './bootstrap-flag.js';

/**
 * The §6 bootstrap offer's own trigger (ai/phase-15-ai-copilot-and-
 * permissions.md §6) — a `sessionStorage` flag, not a server column, per this
 * file's own header. The property under test: a read IS a consume, and one
 * org's flag never leaks into another's.
 */

beforeEach(() => {
  window.sessionStorage.clear();
});

describe('markOrgForBootstrap / consumeBootstrapFlag', () => {
  it('reports true exactly once for a marked org', () => {
    markOrgForBootstrap('org-1');

    expect(consumeBootstrapFlag('org-1')).toBe(true);
    expect(consumeBootstrapFlag('org-1')).toBe(false);
  });

  it('reports false for an org that was never marked', () => {
    expect(consumeBootstrapFlag('never-marked')).toBe(false);
  });

  it('keeps two orgs independent', () => {
    markOrgForBootstrap('org-a');

    expect(consumeBootstrapFlag('org-b')).toBe(false);
    // org-a's flag is untouched by the org-b read above.
    expect(consumeBootstrapFlag('org-a')).toBe(true);
  });
});
