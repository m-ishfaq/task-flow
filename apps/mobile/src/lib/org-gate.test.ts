import { describe, it, expect } from 'vitest';
import type { OrgId } from '@taskflow/contracts';
import { resolveRememberedOrg } from './org-gate.js';

const org = (id: string): OrgId => id as OrgId;

describe('resolveRememberedOrg', () => {
  const memberships = [{ id: org('org_a') }, { id: org('org_b') }];

  it('keeps a remembered id that is still a real membership', () => {
    expect(resolveRememberedOrg('org_b', memberships)).toBe('org_b');
  });

  it('drops a stale id that names no current membership', () => {
    // The bug this guards against: the stale id sails through to the first
    // org-scoped query and every request answers NOT_A_MEMBER.
    expect(resolveRememberedOrg('org_gone', memberships)).toBeNull();
  });

  it('returns null when nothing is remembered', () => {
    expect(resolveRememberedOrg(null, memberships)).toBeNull();
    expect(resolveRememberedOrg('', memberships)).toBeNull();
  });

  it('drops any selection when the user has no memberships', () => {
    expect(resolveRememberedOrg('org_a', [])).toBeNull();
  });
});
