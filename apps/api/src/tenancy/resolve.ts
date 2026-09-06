import {
  and,
  eq,
  gt,
  inArray,
  isNull,
  or,
  schema,
  withOrgScope,
  withUserScope,
} from '@taskflow/db';
import { errors, OrgIdSchema, type OrgId, type UserId } from '@taskflow/contracts';
import {
  isPermission,
  isRelation,
  type Permission,
  type RelationshipTuple,
  type ResourceType,
} from '@taskflow/policy';
import { isRole } from '@taskflow/policy';
import type { OrgMembership } from '../trpc/context.js';

/**
 * Resolving which organization a request is acting in (PLAN.md §8.2, §8.3).
 *
 * ⚠ Adjacent to a human-review surface: this decides the role every subsequent
 * permission check is evaluated against.
 *
 * ## The org id arrives from the client, and that is safe — but only because of
 * ## how it is used
 *
 * A request names its org in a header. That value is attacker-controlled and is
 * treated as such: it is never written to `app.org_id`, and it never becomes a
 * role. It selects a row, and the row is what is believed.
 *
 * The lookup runs in `withUserScope(verifiedUserId)`, so the SCOPE comes from
 * the token and the requested org is only a WHERE filter. A caller naming an
 * org they do not belong to matches zero rows and gets no membership, which
 * leaves `principal.org` null and every permission-bearing route answering
 * NOT_A_MEMBER.
 *
 * The alternative — opening `withOrgScope(requestedOrgId)` and reading the
 * membership there — also happens to be safe, because RLS would confine it. It
 * is not written that way on purpose: it would put an unverified value into the
 * session variable that the entire tenancy guarantee rests on, and the next
 * person to copy that pattern into a query that does more than one lookup would
 * not get the same protection.
 *
 * ## Why the role is read on every request rather than carried in the token
 *
 * The token is signed by this API and could hold a role. It does not, because a
 * demotion would then take effect only when the token expired — leaving a
 * revoked admin with admin rights for the ten minutes that matter most. The
 * cost is one indexed read per request; the benefit is that revocation is
 * immediate.
 */

/** Header naming the organization a request acts in. */
export const ORG_HEADER = 'x-taskflow-org';

/**
 * Loads the caller's membership in `requestedOrgId`, or null.
 *
 * Null covers "no such org" and "never a member" identically — a missing
 * row, for any reason — because distinguishing those two would let an
 * outsider probe which orgs exist. A row that DOES exist but is not
 * `'active'` is answered differently: it throws `errors.membershipSuspended()`
 * rather than returning null, the identical "tell a still-legitimate member
 * what happened" reasoning `org.status === 'suspended'` below already gets.
 * Splitting this out is safe for the same reason: the row is always the
 * CALLER'S OWN, so its status leaks nothing about anyone else's membership,
 * only a fact about the caller they already know (they were once let into
 * this org, or they would have no stored selection naming it at all).
 *
 * Found from a real report: a member whose row this codebase's own platform
 * console showed as `status: suspended` got a bare "you are not a member",
 * which silently dropped their org selection (`recoverFromLostOrg`,
 * `apps/web/src/lib/query.ts`) and landed them on the picker with nothing
 * explaining why — confusing in exactly the way `orgSuspended`'s own header
 * already argued against for the org-level case.
 */
export async function resolveOrgMembership(
  userId: UserId,
  requestedOrgId: string,
): Promise<OrgMembership | null> {
  const parsed = OrgIdSchema.safeParse(requestedOrgId);
  if (!parsed.success) return null;
  const orgId = parsed.data;

  const rows = await withUserScope(userId, async (tx) =>
    tx
      .select({
        id: schema.memberships.id,
        role: schema.memberships.role,
        status: schema.memberships.status,
      })
      .from(schema.memberships)
      .where(and(eq(schema.memberships.orgId, orgId), eq(schema.memberships.userId, userId)))
      .limit(1),
  );

  /* Tested on the ROW rather than on the role, which is also what is actually
     being asked — "is there a membership" — and keeps guardrail 7 from having
     to distinguish a presence check from an authorization decision. */
  const membership = rows[0];
  if (membership === undefined) return null;

  if (membership.status !== 'active') {
    throw errors.membershipSuspended();
  }

  const { id: membershipId, role } = membership;

  /* A role this build has never heard of denies everything downstream (see
     decide.ts), which is safe. Refusing the membership outright is safer still:
     it turns "silently permitted nothing" into a clean NOT_A_MEMBER rather than
     a user who appears to be signed in and can do nothing. */
  if (!isRole(role)) return null;

  /* Phase 12 Wave 1 (§3.3): identity.orgs.status was real but unenforced, and
     this is where enforcement lives — this function is what every org-scoped
     tRPC route, every realtime room join, and every collab page authorization
     run through, so one change here refuses all three for free.

     The read runs in `withUserScope(userId)`, NOT `withOrgScope(orgId)`, and
     that is correct for a subtle reason: identity.orgs has FORCE RLS with
     `orgs_tenant_isolation` keyed on app.org_id, which this scope clears — but
     the caller is an ACTIVE member (we just found the membership row), so
     `orgs_self_read` (0004) admits the row through `app.user_id`. A member of
     a suspended org still sees the org row, which is exactly what this check
     needs. An org that is somehow invisible here reads as `undefined` and
     falls through, which is the not-suspended answer — the case the spec's
     own §3.7 correction warns to verify empirically rather than assume, and
     the tenancy suite's suspension tests pin it against real Postgres. */
  const org = await withUserScope(userId, async (tx) => {
    const orgRow = await tx
      .select({ status: schema.orgs.status, billingStatus: schema.orgs.billingStatus })
      .from(schema.orgs)
      .where(eq(schema.orgs.id, orgId))
      .limit(1);
    return orgRow[0];
  });

  /* Suspended and deleted get different treatments on purpose (§3.3):

     - 'suspended' is its OWN error. NOT_A_MEMBER already means "you were
       never in this org, or you were removed", and telling a legitimately-
       still-a-member Owner that would lie about what happened and what to do
       next. This is a temporary, operator-controlled state; the membership
       is still valid.

     - 'deleted' collapses into NOT_A_MEMBER deliberately. This wave adds no
       route that can produce that state (§2), and when it happens "that org
       used to exist" is exactly the kind of fact a former member should not
       get confirmed by an error message — the same cross-tenant-privacy
       argument member.service.ts already makes for NOT_FOUND. */
  if (org?.status === 'suspended') {
    throw errors.orgSuspended();
  }
  if (org?.status === 'deleted') {
    return null;
  }

  /* NO BILLING STATE BLOCKS ACCESS ANY MORE (Phase 12 Wave 4).

     Wave 3 refused here on `billing_status = 'canceled'`, which was correct
     while a lapsed subscription meant losing the product. Wave 4 replaced
     that with the trial-to-Free design: an org whose trial or subscription
     ends lands on the DEFAULT PLAN and keeps its data, losing only the
     features that plan does not include. Enforcement moved from this one
     chokepoint to per-module entitlements, which is both gentler and more
     honest — a customer sees which capability they lost rather than a locked
     door.

     Keeping the refusal alongside that would have locked an org out for the
     length of one sweep interval: `canceled` is now the TRANSIENT state
     between the processor reporting a cancellation and the sweep moving the
     org to the default plan. A lockout whose duration is a polling interval
     is the worst of both designs.

     `status = 'suspended'` above is untouched. Wave 3's central argument
     holds: two columns, two writers, and an automated billing recovery still
     cannot undo an operator's manual suspension. */

  const tuples = await loadTuples(orgId, userId);
  const memberGrants = await loadMemberGrants(orgId, membershipId);

  return { orgId, role, tuples, memberGrants };
}

/**
 * Every relationship tuple that applies to this user, already expanded through
 * their teams.
 *
 * The expansion happens HERE rather than in the policy engine, and that split
 * is the reason `can()` is pure — no I/O, no async, no clock — which in turn is
 * what lets the API, workers, the socket gateway, Hocuspocus, and the UI all
 * ask the same engine instead of each re-deriving the rules.
 *
 * Expired grants are excluded by this query rather than swept by a job, so a
 * contractor's time-boxed access stops working at the moment it lapses instead
 * of whenever the next cleanup happens to run.
 */
export async function loadTuples(
  orgId: OrgId,
  userId: UserId,
): Promise<readonly RelationshipTuple[]> {
  return withOrgScope(orgId, async (tx) => {
    const teamIds = await tx
      .select({ teamId: schema.teamMembers.teamId })
      .from(schema.teamMembers)
      .where(eq(schema.teamMembers.userId, userId));

    const subjectMatch =
      teamIds.length === 0
        ? and(
            eq(schema.relationshipTuples.subjectType, 'user'),
            eq(schema.relationshipTuples.subjectId, userId),
          )
        : or(
            and(
              eq(schema.relationshipTuples.subjectType, 'user'),
              eq(schema.relationshipTuples.subjectId, userId),
            ),
            and(
              eq(schema.relationshipTuples.subjectType, 'team'),
              inArray(
                schema.relationshipTuples.subjectId,
                teamIds.map((row) => row.teamId),
              ),
            ),
          );

    const rows = await tx
      .select({
        relation: schema.relationshipTuples.relation,
        objectType: schema.relationshipTuples.objectType,
        objectId: schema.relationshipTuples.objectId,
      })
      .from(schema.relationshipTuples)
      .where(
        and(
          subjectMatch,
          or(
            isNull(schema.relationshipTuples.expiresAt),
            gt(schema.relationshipTuples.expiresAt, new Date()),
          ),
        ),
      );

    /* Tuples reach the engine ALREADY RESOLVED to one user: a grant made to a
       team arrives here naming the team, and leaves naming the person. The
       engine never learns teams exist. */
    return rows
      .filter((row) => isRelation(row.relation))
      .map((row): RelationshipTuple => ({
        subject: userId,
        relation: row.relation as RelationshipTuple['relation'],
        object: { type: row.objectType as ResourceType, id: row.objectId },
      }));
  });
}

/**
 * This member's active individual permission grants
 * (ai/phase-15-ai-copilot-and-permissions.md §1) — the org-level counterpart
 * to `loadTuples` above.
 *
 * Filtered to `revoked_at IS NULL` by the query rather than by a sweep, the
 * same reasoning `loadTuples` gives for `expiresAt`: a revoke stops working
 * at the moment it is written, not whenever a cleanup job next runs.
 */
export async function loadMemberGrants(
  orgId: OrgId,
  membershipId: string,
): Promise<readonly Permission[]> {
  return withOrgScope(orgId, async (tx) => {
    const rows = await tx
      .select({ permission: schema.memberGrants.permission })
      .from(schema.memberGrants)
      .where(
        and(
          eq(schema.memberGrants.membershipId, membershipId),
          isNull(schema.memberGrants.revokedAt),
        ),
      );

    return rows.map((row) => row.permission).filter(isPermission);
  });
}
