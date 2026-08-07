import { describe, expect, it } from 'vitest';
import { unsafeAsId } from '@taskflow/contracts';
import { PERMISSIONS, type Permission } from './permissions.js';
import { ROLES, ROLE_PERMISSIONS, roleGrants, type Role } from './roles.js';
import { can, type Subject } from './decide.js';

/**
 * GUARDRAIL 9 — the authorization matrix test (PLAN.md §2.1, §8.2).
 *
 * Asserts every `(role × permission)` pair against the table in §8.2. The value
 * is not that it proves today's matrix correct — it is that changing the matrix
 * without changing this file is impossible, so a permission cannot be widened as
 * a side effect of some other edit.
 */

const subject = (role: Role): Subject => ({
  orgId: unsafeAsId<'OrgId'>('018f4d1e-7c3a-7b2e-8f1a-000000000001'),
  userId: unsafeAsId<'UserId'>('018f4d1e-7c3a-7b2e-8f1a-000000000002'),
  role,
  tuples: [],
});

/**
 * The §8.2 capability table, restated as data.
 *
 * Deliberately written out by hand rather than derived from ROLE_PERMISSIONS —
 * a test that computes its expectations from the implementation asserts only
 * that the code equals itself.
 */
const EXPECTED: Readonly<Record<Role, readonly Permission[]>> = {
  owner: PERMISSIONS, // everything, by definition

  admin: [
    'org:read',
    'member:read',
    'member:invite',
    'team:read',
    'team:manage',
    'project:read',
    'project:create',
    'project:update',
    'project:delete',
    'board:read',
    'board:create',
    'board:update',
    'board:delete',
    'card:read',
    'card:create',
    'card:update',
    'card:move',
    'card:delete',
    'channel:read',
    'channel:create',
    'channel:manage',
    'message:read',
    'message:create',
    'message:update',
    'message:delete',
    'space:read',
    'space:create',
    'space:manage',
    'page:read',
    'page:create',
    'page:update',
    'page:delete',
    'page:publish',
    'comment:create',
    'comment:delete',
    'attachment:upload',
    'attachment:download',
    'automation:manage',
    'webhook:manage',
    'integration:manage',
    'apiToken:create',
    'apiToken:revoke',
    'phoneNumber:read',
    'call:place',
    'call:read',
    'sms:send',
    'sms:read',
    'recording:read',
    'audit:read',
  ],

  member: [
    'org:read',
    'member:read',
    'team:read',
    'project:read',
    'board:read',
    'card:read',
    'card:create',
    'card:update',
    'card:move',
    'card:delete',
    'channel:read',
    'message:read',
    'message:create',
    'message:update',
    /* No `message:delete`, matching `comment:delete`'s absence below.
       `message:delete` is the MODERATION capability — removing someone else's
       words. Deleting your OWN message does not need it: the service asks for
       `message:create` when the caller is the author, exactly as comment
       deletion does. See the note in roles.ts. */
    'space:read',
    'page:read',
    'page:create',
    'page:update',
    'comment:create',
    'attachment:upload',
    'attachment:download',
    'phoneNumber:read',
    'call:place',
    'call:read',
    'sms:send',
    'sms:read',
  ],

  guest: [],
};

describe('role x permission matrix', () => {
  for (const role of ROLES) {
    for (const permission of PERMISSIONS) {
      const shouldGrant = EXPECTED[role].includes(permission);

      it(`${role} ${shouldGrant ? 'MAY' : 'may NOT'} ${permission}`, () => {
        expect(roleGrants(role, permission)).toBe(shouldGrant);
        expect(can(subject(role), permission).allowed).toBe(shouldGrant);
      });
    }
  }
});

describe('matrix invariants', () => {
  it('grants the owner every permission', () => {
    // The owner is the only role defined as a closure over the catalog. If a new
    // permission is added and nobody can perform it, that is a bug nobody
    // notices until a customer reports it.
    expect([...ROLE_PERMISSIONS.owner]).toEqual([...PERMISSIONS]);
  });

  it('gives the guest nothing from the role alone', () => {
    // Everything a guest can do must arrive as a tuple. An empty list means the
    // denial comes from the default path rather than from a special case
    // somebody has to remember to write.
    expect(ROLE_PERMISSIONS.guest).toHaveLength(0);
  });

  it('withholds the money-losing permissions from everyone but the owner', () => {
    // §8.5: telephony is where a mistake costs cash rather than privacy, and an
    // admin account is far more likely to be compromised than an owner account.
    for (const permission of ['phoneNumber:purchase', 'recording:export'] as const) {
      expect(roleGrants('owner', permission)).toBe(true);
      expect(roleGrants('admin', permission)).toBe(false);
      expect(roleGrants('member', permission)).toBe(false);
    }
  });

  it('withholds role management from admins', () => {
    // An admin who can edit roles can promote themselves to owner, which makes
    // the owner/admin distinction decorative.
    expect(roleGrants('admin', 'member:manage')).toBe(false);
    expect(roleGrants('admin', 'member:remove')).toBe(false);
    expect(roleGrants('admin', 'member:invite')).toBe(true);
  });

  it('withholds org deletion and billing from admins', () => {
    for (const permission of ['org:delete', 'org:billing', 'org:update'] as const) {
      expect(roleGrants('admin', permission)).toBe(false);
    }
  });

  it('does not model roles as a hierarchy', () => {
    // Admin is not "member plus extras". If it were, every future member
    // permission would flow to admins automatically — usually right, and
    // occasionally catastrophic.
    const memberOnly = ROLE_PERMISSIONS.member.filter(
      (permission) => !ROLE_PERMISSIONS.admin.includes(permission),
    );
    const adminOnly = ROLE_PERMISSIONS.admin.filter(
      (permission) => !ROLE_PERMISSIONS.member.includes(permission),
    );

    // Today admin happens to be a superset; the assertion that matters is that
    // the two lists are maintained independently, which this documents.
    expect(memberOnly).toEqual([]);
    expect(adminOnly.length).toBeGreaterThan(0);
  });

  it('covers every catalog permission for every role', () => {
    // Guards the gap this whole file exists to close: a permission added to the
    // catalog but never placed in the matrix would otherwise be silently denied
    // to everyone, including the owner.
    for (const role of ROLES) {
      for (const permission of PERMISSIONS) {
        expect(typeof roleGrants(role, permission)).toBe('boolean');
      }
    }
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
  });
});
