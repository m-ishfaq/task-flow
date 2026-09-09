import { and, eq, schema, withOrgScope, outboxWriter } from '@taskflow/db';
import { errors, type OrgId } from '@taskflow/contracts';
import { createEvent } from '@taskflow/events';
import { newId } from '@taskflow/security';
import { isGrantable, isPermission, isRole, type Role } from '@taskflow/policy';
import { roleDefaultGrantRemoved, roleDefaultGrantSet } from './events.js';
import type { Actor } from './org.service.js';

/**
 * Role default grants (Phase 15 §8 checklist item 3) — one org's
 * configuration of which individually-grantable permissions a role gets
 * automatically, applied by the `member_grant.apply_role_defaults`
 * automation action rather than by this service itself.
 *
 * A THIRD mechanism from `member-grant.service.ts`'s own `grant`/`revoke`,
 * not a thin wrapper over it: this table is CONFIGURATION ("what does a
 * new Member get by default"), never itself consulted by `can()` — see
 * migration 0103's own header for why it is not `member_grants` with a null
 * `membershipId`. Real DELETE, not a `revoked_at` column: there is no
 * history to preserve here, only current config, the same shape
 * `platform.flag_overrides` already has.
 */

export interface RoleDefaultGrantInput {
  readonly role: string;
  readonly permission: string;
}

export interface RoleDefaultGrantSummary {
  readonly grantId: string;
  readonly role: string;
  readonly permission: string;
  readonly createdBy: string | null;
  readonly createdAt: Date;
}

/**
 * Adds `permission` to `input.role`'s default bundle.
 *
 * Idempotent on the real unique index (`org_id, role, permission`): setting
 * something already set returns the existing row, the same idempotency
 * `member-grant.service.ts`'s own `grant()` gives individual grants — so a
 * retried batch from the settings UI's matrix editor (select several
 * permissions for a role, save once) cannot fail on a pair it already wrote.
 */
export async function set(
  orgId: OrgId,
  input: RoleDefaultGrantInput,
  actor: Actor,
): Promise<{ readonly grantId: string }> {
  if (!isRole(input.role)) {
    throw errors.validation({ role: 'Not a recognized role.' });
  }
  if (!isPermission(input.permission) || !isGrantable(input.permission)) {
    throw errors.validation({ permission: 'This permission cannot be granted individually.' });
  }

  return withOrgScope(orgId, async (tx) => {
    const existing = await tx
      .select({ id: schema.roleDefaultGrants.id })
      .from(schema.roleDefaultGrants)
      .where(
        and(
          eq(schema.roleDefaultGrants.role, input.role),
          eq(schema.roleDefaultGrants.permission, input.permission),
        ),
      )
      .limit(1);

    const found = existing[0];
    if (found) return { grantId: found.id };

    const grantId = newId<'RoleDefaultGrantId'>();
    await tx.insert(schema.roleDefaultGrants).values({
      id: grantId,
      orgId,
      role: input.role,
      permission: input.permission,
      createdBy: actor.userId,
    });

    await outboxWriter.append(tx, [
      createEvent(
        roleDefaultGrantSet,
        { grantId, orgId, role: input.role, permission: input.permission },
        { orgId, actorId: actor.userId, requestId: actor.requestId },
      ),
    ]);

    return { grantId };
  });
}

/**
 * Removes `permission` from `input.role`'s default bundle.
 *
 * Idempotent on "no row to remove" — mirroring `member-grant.service.ts`'s
 * `revoke()`, for the identical reason: a batch "Remove selected" retried
 * after an interruption must not fail on a pair the first attempt already
 * removed.
 */
export async function remove(
  orgId: OrgId,
  input: RoleDefaultGrantInput,
  actor: Actor,
): Promise<{ readonly removed: true }> {
  return withOrgScope(orgId, async (tx) => {
    const rows = await tx
      .select({ id: schema.roleDefaultGrants.id })
      .from(schema.roleDefaultGrants)
      .where(
        and(
          eq(schema.roleDefaultGrants.role, input.role),
          eq(schema.roleDefaultGrants.permission, input.permission),
        ),
      )
      .limit(1);

    const row = rows[0];
    if (!row) return { removed: true as const };

    await tx.delete(schema.roleDefaultGrants).where(eq(schema.roleDefaultGrants.id, row.id));

    await outboxWriter.append(tx, [
      createEvent(
        roleDefaultGrantRemoved,
        { grantId: row.id, orgId, role: input.role, permission: input.permission },
        { orgId, actorId: actor.userId, requestId: actor.requestId },
      ),
    ]);

    return { removed: true as const };
  });
}

/** Every role's default bundle in the org — the admin settings matrix editor. */
export async function list(orgId: OrgId): Promise<readonly RoleDefaultGrantSummary[]> {
  return withOrgScope(orgId, async (tx) =>
    tx
      .select({
        grantId: schema.roleDefaultGrants.id,
        role: schema.roleDefaultGrants.role,
        permission: schema.roleDefaultGrants.permission,
        createdBy: schema.roleDefaultGrants.createdBy,
        createdAt: schema.roleDefaultGrants.createdAt,
      })
      .from(schema.roleDefaultGrants),
  );
}

/**
 * The permissions one role gets by default in this org — what
 * `member_grant.apply_role_defaults` reads on every execution to decide
 * which real `authz.member_grants` rows to stamp for the member the
 * trigger named. A plain string array, not the full summary shape: the
 * executor has no use for `grantId`/`createdBy`/`createdAt`, only the set
 * of permissions to apply.
 */
export async function permissionsForRole(orgId: OrgId, role: Role): Promise<readonly string[]> {
  return withOrgScope(orgId, async (tx) => {
    const rows = await tx
      .select({ permission: schema.roleDefaultGrants.permission })
      .from(schema.roleDefaultGrants)
      .where(eq(schema.roleDefaultGrants.role, role));
    return rows.map((row) => row.permission);
  });
}
