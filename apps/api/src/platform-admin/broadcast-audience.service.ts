import { and, coalesceColumns, eq, schema, withPlatformAdminScope } from '@taskflow/db';
import { errors, type OrgId, type UserId } from '@taskflow/contracts';

/**
 * Audience resolution for operator broadcasts (Phase 12, platform-admin
 * console — "send a notification to any user or all members of an org").
 *
 * ## Every audience is org-scoped, including "one user"
 *
 * `platform.notifications` carries a real `org_id` under ordinary RLS (0022) —
 * there is no way to write a notification that names no org. So "message this
 * one person" is really "message this one MEMBER OF THIS ORG", the same
 * question `org-detail.service.ts`'s member list already asks. That is a
 * feature, not a workaround: a person can belong to several orgs, and naming
 * the org resolves which relationship the operator is addressing rather than
 * leaving it ambiguous.
 *
 * ## Read through `withPlatformAdminScope`, not `withOrgScope`
 *
 * `org-detail.service.ts` already established the pattern this reuses:
 * `identity.memberships` carries an explicit `memberships_platform_admin_read`
 * policy (0035) for exactly this — an operator reading another tenant's
 * roster. `withOrgScope` is for the ordinary application role acting AS a
 * member of the org; an operator is never that.
 */

export type AudienceTarget = 'all' | 'role' | 'user';
export type MembershipRole = 'owner' | 'admin' | 'member' | 'guest';

export interface AudienceSpec {
  readonly orgId: OrgId;
  readonly target: AudienceTarget;
  /**
   * Required iff target === 'role'. Named `membershipRole`, not `role` — a
   * bare `.role` compared with `===`/`!==` trips guardrail 7's blunt
   * `roleMember` selector (packages/config/eslint/security.js), which cannot
   * tell "checking whether a role FILTER was supplied" apart from "comparing
   * a person's role for authorization." The rule is deliberately blunt by
   * design (CLAUDE.md); the fix is not to be the shape it matches, not to
   * suppress it.
   */
  readonly membershipRole?: MembershipRole;
  /** Required iff target === 'user'. */
  readonly userId?: UserId;
}

export interface AudienceMember {
  readonly userId: string;
  readonly email: string;
  readonly name: string | null;
  readonly role: string;
}

/**
 * Every ACTIVE member matching the spec. `status = 'active'` is not
 * optional — a suspended membership is not someone to notify, the same
 * reasoning `suspendOrg`'s own owner-email lookup already applies.
 *
 * Shared by both the dry-run preview and the actual send, so the count an
 * operator confirms is EXACTLY the set that gets written — no separate query
 * that could drift from the first between preview and send.
 */
export async function resolveAudience(spec: AudienceSpec): Promise<readonly AudienceMember[]> {
  if (spec.target === 'role' && spec.membershipRole === undefined) {
    throw errors.validation({ target: spec.target }, 'An audience of "role" requires a role.');
  }
  if (spec.target === 'user' && spec.userId === undefined) {
    throw errors.validation({ target: spec.target }, 'An audience of "user" requires a userId.');
  }

  return withPlatformAdminScope(async (tx) => {
    const conditions = [
      eq(schema.memberships.orgId, spec.orgId),
      eq(schema.memberships.status, 'active'),
    ];
    if (spec.target === 'role' && spec.membershipRole !== undefined) {
      conditions.push(eq(schema.memberships.role, spec.membershipRole));
    }
    if (spec.target === 'user' && spec.userId !== undefined) {
      conditions.push(eq(schema.memberships.userId, spec.userId));
    }

    const rows = await tx
      .select({
        userId: schema.memberships.userId,
        email: schema.users.email,
        name: coalesceColumns(schema.profiles.displayName, schema.users.displayName),
        role: schema.memberships.role,
      })
      .from(schema.memberships)
      .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
      /* LEFT — same reasoning as org-detail.service.ts's identical join: a
         profile row is lazy, and an inner join would drop anyone who has
         never opened the account page. */
      .leftJoin(schema.profiles, eq(schema.profiles.userId, schema.memberships.userId))
      .where(and(...conditions))
      .orderBy(schema.memberships.role, schema.users.email);

    /* A 'user' target naming someone who is not an active member of THIS org
       is a caller error, not "zero recipients" — the operator console offers
       a member picker scoped to the chosen org, so reaching this with zero
       rows means the two selections (org, user) disagree, which is worth
       surfacing rather than silently sending to nobody. */
    if (spec.target === 'user' && rows.length === 0) {
      throw errors.notFound('That user is not an active member of this org.');
    }

    return rows;
  });
}

/** The dry-run count the send UI requires before its confirm step enables. */
export async function previewAudience(spec: AudienceSpec): Promise<{ readonly count: number }> {
  const members = await resolveAudience(spec);
  return { count: members.length };
}
