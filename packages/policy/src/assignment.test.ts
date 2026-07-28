import { describe, expect, it } from 'vitest';
import { ROLES } from './roles.js';
import {
  DIRECTLY_ASSIGNABLE_ROLES,
  isDirectlyAssignable,
  isIndispensableRole,
  sameRole,
} from './assignment.js';

/**
 * Rules about assigning roles (PLAN.md §8.2).
 *
 * These predicates exist because guardrail 7 makes `role === 'owner'` a lint
 * error outside this package, and the reason it does is drift: a comparison
 * written inline in a membership service is invisible to the matrix test, so it
 * keeps enforcing what the matrix has since changed. Moving them here is only
 * worth anything if they are actually asserted, which is what this file is.
 */

describe('the indispensable role', () => {
  it('is owner, and only owner', () => {
    /* The consequence of getting this wrong is not a permission bug but a dead
       tenant: an org with no owner cannot be administered, recovered, or
       deleted by anyone, and the only fix is a database console. */
    const indispensable = ROLES.filter(isIndispensableRole);
    expect(indispensable).toEqual(['owner']);
  });

  it('does not include admin', () => {
    // Admin deliberately cannot manage members (§8.2) — an admin who could edit
    // roles could promote themselves, which makes the split decorative. So an
    // org full of admins and no owner is still an orphaned org.
    expect(isIndispensableRole('admin')).toBe(false);
  });
});

describe('direct assignment', () => {
  it('excludes owner', () => {
    // Owner is reached only by promoting an existing member, which is a
    // separate step-up-protected operation. Otherwise one call would both
    // create a membership and grant everything, leaving the audit entry with no
    // prior role to record a change from.
    expect(isDirectlyAssignable('owner')).toBe(false);
  });

  it('includes every other role', () => {
    expect([...DIRECTLY_ASSIGNABLE_ROLES].sort()).toEqual(['admin', 'guest', 'member']);
  });

  it('covers the whole catalog between the two predicates', () => {
    // A role added to ROLES without a decision here would silently become
    // directly assignable, which is the wrong default for anything privileged.
    for (const role of ROLES) {
      expect(isDirectlyAssignable(role) || isIndispensableRole(role)).toBe(true);
    }
  });
});

describe('role identity', () => {
  it('is reflexive across the catalog', () => {
    for (const role of ROLES) {
      expect(sameRole(role, role)).toBe(true);
    }
  });

  it('distinguishes every distinct pair', () => {
    for (const left of ROLES) {
      for (const right of ROLES) {
        expect(sameRole(left, right)).toBe(left === right);
      }
    }
  });
});
