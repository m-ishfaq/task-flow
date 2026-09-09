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
 *
 * Idempotent on "no active grant to revoke" — mirroring `grant()`'s own
 * idempotency above, for the identical reason: `settings-page.tsx`'s bulk
 * revoke sheet (Phase 15 §1, Wave 2) calls this route once per selected
 * pair in sequence and, on a step-up interruption, retries the WHOLE
 * remaining selection from the start rather than tracking which pairs
 * already succeeded. Before this, a retry that reached an
 * already-revoked pair (one revoked earlier in the same batch, before the
 * interruption) would throw NOT_FOUND and abort the rest of the batch —
 * a real behavior change from a caller's error into "nothing to do",
 * exactly the shape `grant()`'s idempotency already gives the equivalent
 * bulk-GRANT sheet. A missing MEMBERSHIP still throws: that is a genuinely
 * different failure (the person left the org), not "already revoked".
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
    if (!row) return { revoked: true as const };

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

/**
 * Revokes every active individual grant a member holds — offboarding
 * automation's `member_grant.revoke_all` (ai/phase-15-ai-copilot-and-
 * permissions.md §8, offboarding item 3).
 *
 * A loop of the same conditional UPDATE `revoke()` already makes, not a
 * single bulk statement: each permission is its own `memberGrantRevoked`
 * event (guardrail 6), and an admin auditing "what could this person still
 * do the day they left" wants the list, not a count. Idempotent on "nothing
 * left to revoke" for the identical reason `revoke()` is — a membership
 * with zero active grants is not an error, it is the common case for most
 * members, who hold none at all.
 */
export async function revokeAll(
  orgId: OrgId,
  userId: UserId,
  actor: Actor,
): Promise<{ readonly revoked: readonly string[] }> {
  return withOrgScope(orgId, async (tx) => {
    const membership = await findActiveMembership(tx, orgId, userId);
    if (!membership) throw errors.notFound();

    const rows = await tx
      .select({ id: schema.memberGrants.id, permission: schema.memberGrants.permission })
      .from(schema.memberGrants)
      .where(
        and(
          eq(schema.memberGrants.membershipId, membership.id),
          isNull(schema.memberGrants.revokedAt),
        ),
      );

    if (rows.length === 0) return { revoked: [] };

    await tx
      .update(schema.memberGrants)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(schema.memberGrants.membershipId, membership.id),
          isNull(schema.memberGrants.revokedAt),
        ),
      );

    await outboxWriter.append(
      tx,
      rows.map((row) =>
        createEvent(
          memberGrantRevoked,
          { grantId: row.id, membershipId: membership.id, userId, permission: row.permission },
          { orgId, actorId: actor.userId, requestId: actor.requestId },
        ),
      ),
    );

    return { revoked: rows.map((row) => row.permission) };
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
