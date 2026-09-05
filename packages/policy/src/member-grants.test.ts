import { describe, expect, it } from 'vitest';
import { unsafeAsId } from '@taskflow/contracts';
import { GRANTABLE_PERMISSIONS, isGrantable } from './permissions.js';
import { can, couldGrant, type Subject } from './decide.js';

/**
 * Member grants (ai/phase-15-ai-copilot-and-permissions.md §1) — the
 * data-dependent extension `matrix.test.ts`'s role-alone loop cannot cover,
 * since every subject there is built with no grants at all.
 */

const orgId = unsafeAsId<'OrgId'>('018f4d1e-7c3a-7b2e-8f1a-000000000001');
const userId = unsafeAsId<'UserId'>('018f4d1e-7c3a-7b2e-8f1a-000000000002');

const subject = (overrides: Partial<Subject> = {}): Subject => ({
  orgId,
  userId,
  role: 'guest',
  tuples: [],
  ...overrides,
});

describe('member grants — decide.ts composition', () => {
  it('a guest with no grants gets nothing, same as the role matrix', () => {
    expect(can(subject(), 'call:place').allowed).toBe(false);
    expect(couldGrant(subject(), 'call:place')).toBe(false);
  });

  it('an individual grant adds a permission the role alone does not give, org-level', () => {
    const s = subject({ memberGrants: ['call:place'] });
    const decision = can(s, 'call:place');
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toContain('individual grant');
  });

  it('couldGrant lets a member-granted permission pass the route-floor pre-check', () => {
    // `call:place` is in ORG_LEVEL_PERMISSIONS, so without this a member grant
    // could never reach a route at all — couldGrant would refuse before the
    // handler ever ran, the same failure mode this function's own doc
    // comment documents for tuples.
    expect(couldGrant(subject({ memberGrants: ['call:place'] }), 'call:place')).toBe(true);
  });

  it('a grant for one permission does not leak to another', () => {
    const s = subject({ memberGrants: ['call:place'] });
    expect(can(s, 'sms:send').allowed).toBe(false);
    expect(couldGrant(s, 'sms:send')).toBe(false);
  });

  it('an absent memberGrants field behaves exactly like an empty one', () => {
    // The field is optional so a caller that has not wired up resolution
    // (a worker, the collab gateway, an older fixture) fails closed rather
    // than throwing.
    const withUndefined = subject();
    const withEmpty = subject({ memberGrants: [] });
    expect(can(withUndefined, 'call:place').allowed).toBe(can(withEmpty, 'call:place').allowed);
    expect(can(withUndefined, 'call:place').allowed).toBe(false);
  });

  it('a restrictive tuple still caps a permission added only by an individual grant', () => {
    // Composition, not a second code path: a member grant flows into the same
    // `byRole` the role does, so a viewer tuple caps it exactly the way it
    // caps a role-granted permission. Sharing a board read-only with someone
    // must narrow whatever they could otherwise do there.
    const s = subject({
      memberGrants: ['card:update'],
      tuples: [{ subject: userId, relation: 'viewer', object: { type: 'card', id: 'card-1' } }],
    });
    const decision = can(s, 'card:update', {
      orgId,
      resource: { type: 'card', id: 'card-1' },
    });
    expect(decision.allowed).toBe(false);
  });

  it('the same individual grant is honored on a resource with no capping tuple', () => {
    const s = subject({ memberGrants: ['card:update'] });
    const decision = can(s, 'card:update', {
      orgId,
      resource: { type: 'card', id: 'card-2' },
    });
    expect(decision.allowed).toBe(true);
  });
});

describe('GRANTABLE_PERMISSIONS / isGrantable', () => {
  it('accepts the telephony permissions the phase spec names as the starting set', () => {
    for (const permission of [
      'phoneNumber:read',
      'call:place',
      'call:read',
      'sms:send',
      'sms:read',
    ] as const) {
      expect(isGrantable(permission)).toBe(true);
    }
  });

  it('refuses ownership-adjacent and destructive org-wide permissions', () => {
    for (const permission of [
      'org:update',
      'org:delete',
      'org:billing',
      'member:manage',
      'member:remove',
      'apiToken:create',
    ] as const) {
      expect(isGrantable(permission)).toBe(false);
    }
  });

  it('has no duplicate entries', () => {
    expect(GRANTABLE_PERMISSIONS.size).toBe(5);
  });
});
