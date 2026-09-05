import { and, eq, isNull, schema, withOrgScope, outboxWriter } from '@taskflow/db';
import { errors, type OrgId, type UserId } from '@taskflow/contracts';
import { createEvent } from '@taskflow/events';
import { newId } from '@taskflow/security';
import { isGrantable, isPermission } from '@taskflow/policy';
import { memberGrantCreated, memberGrantRevoked } from './events.js';
import type { Actor } from './org.service.js';

/**
 * Individual, org-level permission grants — the mechanism
 * `ai/phase-15-ai-copilot-and-permissions.md` §1 adds on top of the four
 * fixed roles: one specific member gets one specific permission (e.g.
 * `call:place`) without their role changing.
 *
 * Deliberately its own service rather than folded into `grant.service.ts`.
 * That file writes relationship TUPLES — a subject and a relation on one
 * RESOURCE. There is no resource here at all, which is the entire point
 * (see `packages/policy`'s `ORG_LEVEL_PERMISSIONS`), and conflating the two
 * would mean one function silently branching on whether an object was
 * supplied instead of two functions each doing one thing.
 */

export interface MemberGrantInput {
  readonly userId: UserId;
  readonly permission: string;
}

export interface MemberGrantSummary {
  readonly grantId: string;
  readonly userId: string;
  readonly permission: string;
  readonly grantedBy: string | null;
  readonly grantedAt: Date;
}

type Tx = Parameters<Parameters<typeof withOrgScope>[1]>[0];

/**
 * The active membership a grant attaches to, or undefined if `userId` is not
 * a current member of `orgId` — mirrors `assertSubjectBelongsHere` in
 * `grant.service.ts`, which refuses a tuple naming a subject outside the org
 * for the identical reason: a grant nobody can see because its subject
 * belongs to no visible membership is not merely useless, it would become
 * live access the moment that person was ever (re-)added here.
 */
async function findActiveMembership(
  tx: Tx,
  orgId: OrgId,
  userId: UserId,
): Promise<{ readonly id: string } | undefined> {
  const rows = await tx
    .select({ id: schema.memberships.id })
    .from(schema.memberships)
    .where(
      and(
        eq(schema.memberships.orgId, orgId),
        eq(schema.memberships.userId, userId),
        eq(schema.memberships.status, 'active'),
      ),
    )
    .limit(1);
  return rows[0];
}

/**
 * Grants `permission` to `input.userId`.
 *
 * Idempotent on the active partial unique index (`membership_id, permission`
 * WHERE `revoked_at IS NULL`): granting something already granted returns the
 * existing row rather than a duplicate, the same idempotency
 * `grant.service.ts`'s `grant()` gives tuples.
 */
export async function grant(
  orgId: OrgId,
  input: MemberGrantInput,
  actor: Actor,
): Promise<{ readonly grantId: string }> {
  if (!isPermission(input.permission) || !isGrantable(input.permission)) {
    throw errors.validation({ permission: 'This permission cannot be granted individually.' });
  }

  return withOrgScope(orgId, async (tx) => {
    const membership = await findActiveMembership(tx, orgId, input.userId);
    if (!membership) throw errors.notFound();

    const existing = await tx
      .select({ id: schema.memberGrants.id })
      .from(schema.memberGrants)
      .where(
        and(
          eq(schema.memberGrants.membershipId, membership.id),
          eq(schema.memberGrants.permission, input.permission),
          isNull(schema.memberGrants.revokedAt),
        ),
      )
      .limit(1);

    const found = existing[0];
    if (found) return { grantId: found.id };

    const grantId = newId<'MemberGrantId'>();
    await tx.insert(schema.memberGrants).values({
      id: grantId,
      orgId,
      membershipId: membership.id,
      permission: input.permission,
      grantedBy: actor.userId,
    });

    await outboxWriter.append(tx, [
      createEvent(
        memberGrantCreated,
        {
          grantId,
          membershipId: membership.id,
          userId: input.userId,
          permission: input.permission,
        },
        { orgId, actorId: actor.userId, requestId: actor.requestId },
      ),
    ]);

    return { grantId };
  });
}

/**
 * Revokes `permission` from `input.userId`, by SETTING `revoked_at` rather
 * than deleting the row — the grant stays visible in history, mirroring
 * `identity.sessions` and `comms.suppressions` (see migration 0097's own
 * comment).
 */
export async function revoke(
  orgId: OrgId,
  input: MemberGrantInput,
  actor: Actor,
): Promise<{ readonly revoked: true }> {
  return withOrgScope(orgId, async (tx) => {
    const membership = await findActiveMembership(tx, orgId, input.userId);
    if (!membership) throw errors.notFound();

    const rows = await tx
      .select({ id: schema.memberGrants.id })
      .from(schema.memberGrants)
      .where(
        and(
          eq(schema.memberGrants.membershipId, membership.id),
          eq(schema.memberGrants.permission, input.permission),
          isNull(schema.memberGrants.revokedAt),
        ),
      )
      .limit(1);

    const row = rows[0];
    if (!row) throw errors.notFound();

    await tx
      .update(schema.memberGrants)
      .set({ revokedAt: new Date() })
      .where(eq(schema.memberGrants.id, row.id));

    await outboxWriter.append(tx, [
      createEvent(
        memberGrantRevoked,
        {
          grantId: row.id,
          membershipId: membership.id,
          userId: input.userId,
          permission: input.permission,
        },
        { orgId, actorId: actor.userId, requestId: actor.requestId },
      ),
    ]);

    return { revoked: true as const };
  });
}

/** Every active individual grant in the org — the admin "Permissions" screen. */
export async function listGrants(orgId: OrgId): Promise<readonly MemberGrantSummary[]> {
  return withOrgScope(orgId, async (tx) =>
    tx
      .select({
        grantId: schema.memberGrants.id,
        userId: schema.memberships.userId,
        permission: schema.memberGrants.permission,
        grantedBy: schema.memberGrants.grantedBy,
        grantedAt: schema.memberGrants.grantedAt,
      })
      .from(schema.memberGrants)
      .innerJoin(schema.memberships, eq(schema.memberships.id, schema.memberGrants.membershipId))
      .where(isNull(schema.memberGrants.revokedAt)),
  );
}
