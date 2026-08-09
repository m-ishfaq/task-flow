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
import { OrgIdSchema, type OrgId, type UserId } from '@taskflow/contracts';
import { isRelation, type RelationshipTuple, type ResourceType } from '@taskflow/policy';
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
 * The three ways resolving a caller's membership can come out, kept apart
 * because two of them need different treatment at the HTTP layer (Phase 12
 * §3.3).
 *
 * `'suspended'` is deliberately NOT folded into `'none'` here, even though
 * `resolveOrgMembership` below folds it back in for its own callers. The
 * distinction has to survive at least one layer up so `server.ts`'s
 * `withOrgContext` can set `principal.orgSuspended` and `requireOrg` can throw
 * `ORG_SUSPENDED` instead of the generic `NOT_A_MEMBER`.
 */
export type OrgResolution =
  | { readonly kind: 'member'; readonly membership: OrgMembership }
  | { readonly kind: 'suspended' }
  | { readonly kind: 'none' };

/**
 * Loads the caller's membership in `requestedOrgId`, or null.
 *
 * Null covers every failure identically — no such org, not a member, membership
 * suspended, role unrecognized, ORG suspended or deleted — because for every
 * caller of this function except the HTTP layer's own `withOrgContext`, the
 * caller learns the same thing from all of them: refuse. `apps/realtime`'s
 * `rooms.ts` and `apps/collab`'s `authorize.ts` both call this function
 * unchanged and both already treat null as "refuse the join" — which is what
 * makes a suspended org's live sockets refuse every NEW join or connect the
 * moment this ships, with no code of theirs touched (ai/phase-12-admin.md
 * §3.9). Distinguishing WHY it is null, for the one caller that needs to, is
 * `resolveOrgMembershipDetailed` below.
 */
export async function resolveOrgMembership(
  userId: UserId,
  requestedOrgId: string,
): Promise<OrgMembership | null> {
  const resolution = await resolveOrgMembershipDetailed(userId, requestedOrgId);
  return resolution.kind === 'member' ? resolution.membership : null;
}

/**
 * `resolveOrgMembership`, but keeping `'suspended'` distinguishable from
 * every other refusal. See `OrgResolution`'s own comment for why this needs
 * to exist as a second function rather than changing the first one's return
 * type — `rooms.ts`/`authorize.ts` must keep working, unchanged, against a
 * plain `OrgMembership | null`.
 */
export async function resolveOrgMembershipDetailed(
  userId: UserId,
  requestedOrgId: string,
): Promise<OrgResolution> {
  const parsed = OrgIdSchema.safeParse(requestedOrgId);
  if (!parsed.success) return { kind: 'none' };
  const orgId = parsed.data;

  /* The join to identity.orgs needs no new grant or policy: `orgs_self_read`
     (migration 0004) already allows reading an org's row, under
     withUserScope, whenever an active membership for app.user_id exists in
     it — exactly the row this query already requires. */
  const rows = await withUserScope(userId, async (tx) =>
    tx
      .select({ role: schema.memberships.role, orgStatus: schema.orgs.status })
      .from(schema.memberships)
      .innerJoin(schema.orgs, eq(schema.orgs.id, schema.memberships.orgId))
      .where(
        and(
          eq(schema.memberships.orgId, orgId),
          eq(schema.memberships.userId, userId),
          eq(schema.memberships.status, 'active'),
        ),
      )
      .limit(1),
  );

  /* Tested on the ROW rather than on the role, which is also what is actually
     being asked — "is there a membership" — and keeps guardrail 7 from having
     to distinguish a presence check from an authorization decision. */
  const membership = rows[0];
  if (membership === undefined) return { kind: 'none' };

  /* 'deleted' collapses into 'none', deliberately (§3.3): this wave adds no
     route that can ever produce it, so it is reachable only by a future
     phase or a direct database action, and the same cross-tenant-privacy
     argument member.service.ts already makes for NOT_FOUND applies here —
     "that org used to exist" should not be confirmed by a distinct error to
     a former member. */
  if (membership.orgStatus === 'deleted') return { kind: 'none' };
  if (membership.orgStatus === 'suspended') return { kind: 'suspended' };

  const { role } = membership;

  /* A role this build has never heard of denies everything downstream (see
     decide.ts), which is safe. Refusing the membership outright is safer still:
     it turns "silently permitted nothing" into a clean NOT_A_MEMBER rather than
     a user who appears to be signed in and can do nothing. */
  if (!isRole(role)) return { kind: 'none' };

  const tuples = await loadTuples(orgId, userId);

  return { kind: 'member', membership: { orgId, role, tuples } };
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
