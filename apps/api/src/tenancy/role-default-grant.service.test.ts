import { describe, expect, it } from 'vitest';
import { unsafeAsId, type OrgId } from '@taskflow/contracts';
import { set } from './role-default-grant.service.js';
import type { Actor } from './org.service.js';

/**
 * `set()`'s validation runs BEFORE `withOrgScope` is ever called — the same
 * shape `member-grant.service.ts`'s own `grant()` has — so these three
 * refusals are provable with no database at all. Everything past validation
 * (the idempotent insert, the emitted event, `remove()`, `list()`,
 * `permissionsForRole()`) needs real Postgres and RLS to mean anything, and
 * is exercised through the tRPC route / worker integration suites instead,
 * per this codebase's own "a mocked RLS test only proves the test agrees
 * with itself" position.
 */

const ORG: OrgId = unsafeAsId('0195ee20-0000-7000-8000-00000000000a');
const actor: Actor = {
  userId: unsafeAsId<'UserId'>('0195ee20-0000-7000-8000-000000000001'),
  requestId: unsafeAsId<'RequestId'>('0195ee20-0000-7000-8000-000000000002'),
};

describe('role-default-grant.service — set() validates before touching the database', () => {
  it('refuses a role that is not one of ROLES', async () => {
    await expect(
      set(ORG, { role: 'superadmin', permission: 'call:place' }, actor),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('refuses a permission that is real but not individually grantable', async () => {
    /* card:create is a real entry in PERMISSIONS — the refusal has to be
       about GRANTABILITY, not merely "unrecognized string". */
    await expect(
      set(ORG, { role: 'member', permission: 'card:create' }, actor),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('refuses a permission this build has never heard of', async () => {
    await expect(
      set(ORG, { role: 'member', permission: 'not.a.real.permission' }, actor),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
