import { and, eq, ne, schema, withOrgScope, outboxWriter } from '@taskflow/db';
import { errors, type OrgId, type UserId } from '@taskflow/contracts';
import { createEvent, type DomainEvent } from '@taskflow/events';
import { newId } from '@taskflow/security';
import {
  isDirectlyAssignable,
  isIndispensableRole,
  isRole,
  sameRole,
  type Role,
} from '@taskflow/policy';
import { leaveAllActiveSessionsFor } from '../rtc/participants.js';
import { rtcSessionEnded, rtcSessionLeft } from '../rtc/events.js';
import { memberAdded, memberRemoved, memberRoleChanged, ownershipTransferred } from './events.js';
import type { Actor } from './org.service.js';

/**
 * Membership management (PLAN.md §8.1, §8.2).
 *
 * Two invariants are enforced here rather than by the schema, because neither
 * can be expressed as a constraint on a single row:
 *
 *   1. AN ORGANIZATION ALWAYS HAS AT LEAST ONE OWNER. Losing the last one
 *      produces a tenant nobody can administer, cannot recover, and cannot
 *      delete — support has to reach into the database. Both the demotion and
 *      the removal path check it.
 *   2. NOBODY CHANGES THEIR OWN ROLE. Self-promotion is the shape almost every
 *      privilege-escalation bug takes, and there is no legitimate use for it:
 *      an owner already holds everything, and anyone else doing it is the
 *      attack. `member:manage` is Owner-only in the role matrix, so this is
 *      defence in depth rather than the only control — but it is the one that
 *      still holds if the matrix is ever edited carelessly.
 *
 * Both checks run inside the same transaction as the write they guard. Read the
 * count, decide, and write in separate transactions and two concurrent
 * demotions each see two owners and both proceed.
 */

export interface MemberSummary {
  readonly userId: string;
  readonly email: string;
  /**
   * What to call this person, or null if they have not set a name.
   *
   * Sent as null rather than falling back to the email HERE, so a caller can
   * tell "has no name" from "is called the same thing as their address" — a
   * profile form has to render an empty field for the first and the text for
   * the second. The display fallback belongs at the render site.
   */
  readonly displayName: string | null;
  readonly role: string;
  readonly status: string;
  readonly joinedAt: Date;
}

export async function listMembers(orgId: OrgId): Promise<readonly MemberSummary[]> {
  return withOrgScope(orgId, async (tx) =>
    tx
      .select({
        userId: schema.memberships.userId,
        email: schema.users.email,
        /* Phase 11.5 §3.2: display names now live in people.profiles, not
           identity.users (whose column is on its way out and no longer
           written). LEFT JOIN — a member who has never set a name has no
           profile row, and that must read as null, not drop the member. */
        displayName: schema.profiles.displayName,
        role: schema.memberships.role,
        status: schema.memberships.status,
        joinedAt: schema.memberships.joinedAt,
      })
      .from(schema.memberships)
      .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
      .leftJoin(schema.profiles, eq(schema.profiles.userId, schema.memberships.userId))
      .orderBy(schema.memberships.joinedAt),
  );
}

export interface AddMemberInput {
  readonly email: string;
  readonly role: Role;
}

/**
 * Adds an existing user to the organization.
 *
 * DELIBERATE LIMIT: the person must already have a TaskFlow account. Inviting
 * an address that has never signed up needs an invitations table, a mailed
 * token, and an acceptance flow that decides what happens when the invited
 * address later registers by another route — which is the same account-linking
 * problem §8.1 defers OAuth for, and it deserves its own slice rather than
 * being improvised inside this one.
 *
 * The response does not distinguish "no such user" from any other failure, so
 * this cannot be used to test whether an address has an account here.
 */
export async function addMember(
  orgId: OrgId,
  input: AddMemberInput,
  actor: Actor,
): Promise<{ readonly userId: string; readonly role: string }> {
  if (!isRole(input.role)) throw errors.validation({ role: 'Unknown role.' });

  // Owner is not directly assignable — it is reached only by promoting an
  // existing member, which is a separate step-up-protected operation. The rule
  // itself lives in @taskflow/policy, where the matrix test can see it.
  if (!isDirectlyAssignable(input.role)) {
    throw errors.validation({ role: 'Add the member first, then transfer ownership.' });
  }

  const normalized = input.email.trim().toLowerCase();

  return withOrgScope(orgId, async (tx) => {
    /* identity.users carries no RLS — a user is not owned by an org (see
       migration 0002) — so it is readable inside any scope. The membership row
       written below IS tenant-scoped, which is what confines this operation. */
    const found = await tx
      .select({ id: schema.users.id, email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.emailNormalized, normalized))
      .limit(1);

    const user = found[0];
    if (!user) throw errors.notFound('No account with that address.');

    const existing = await tx
      .select({ id: schema.memberships.id })
      .from(schema.memberships)
      .where(eq(schema.memberships.userId, user.id))
      .limit(1);

    if (existing[0]) throw errors.conflict('That person is already a member.');

    const membershipId = newId<'MembershipId'>();
    await tx.insert(schema.memberships).values({
      id: membershipId,
      orgId,
      userId: user.id,
      role: input.role,
      invitedBy: actor.userId,
    });

    await outboxWriter.append(tx, [
      createEvent(
        memberAdded,
        {
          membershipId,
          userId: user.id,
          email: user.email,
          role: input.role,
          invitedBy: actor.userId,
        },
        { orgId, actorId: actor.userId, requestId: actor.requestId },
      ),
    ]);

    return { userId: user.id, role: input.role };
  });
}

/**
 * Changes a member's role.
 *
 * Step-up authenticated at the route (§8.1): this is the operation an attacker
 * with a stolen session reaches for first.
 */
export async function changeRole(
  orgId: OrgId,
  target: { readonly userId: UserId; readonly role: Role },
  actor: Actor,
): Promise<{ readonly from: string; readonly to: string }> {
  if (!isRole(target.role)) throw errors.validation({ role: 'Unknown role.' });

  if (target.userId === actor.userId) {
    throw errors.forbidden('You cannot change your own role.');
  }

  return withOrgScope(orgId, async (tx) => {
    const rows = await tx
      .select({ id: schema.memberships.id, role: schema.memberships.role })
      .from(schema.memberships)
      .where(eq(schema.memberships.userId, target.userId))
      .limit(1);

    const membership = rows[0];
    // NOT_FOUND rather than a message naming the user: across tenants, "that
    // person is not in this org" confirms the account exists (§8.7).
    if (!membership) throw errors.notFound();

    const currentRole = knownRole(membership.role);

    if (sameRole(currentRole, target.role)) {
      return { from: currentRole, to: target.role };
    }

    if (isIndispensableRole(currentRole)) {
      await assertAnotherOwnerRemains(tx, target.userId);
    }

    await tx
      .update(schema.memberships)
      .set({ role: target.role, updatedAt: new Date() })
      .where(eq(schema.memberships.id, membership.id));

    await outboxWriter.append(tx, [
      createEvent(
        memberRoleChanged,
        {
          membershipId: membership.id,
          userId: target.userId,
          from: currentRole,
          to: target.role,
        },
        { orgId, actorId: actor.userId, requestId: actor.requestId },
      ),
    ]);

    return { from: currentRole, to: target.role };
  });
}

export async function removeMember(
  orgId: OrgId,
  target: { readonly userId: UserId },
  actor: Actor,
): Promise<{ readonly removed: true }> {
  return withOrgScope(orgId, async (tx) => {
    const rows = await tx
      .select({ id: schema.memberships.id, role: schema.memberships.role })
      .from(schema.memberships)
      .where(eq(schema.memberships.userId, target.userId))
      .limit(1);

    const membership = rows[0];
    if (!membership) throw errors.notFound();

    const currentRole = knownRole(membership.role);
    if (isIndispensableRole(currentRole)) {
      await assertAnotherOwnerRemains(tx, target.userId);
    }

    await tx.delete(schema.memberships).where(eq(schema.memberships.id, membership.id));

    /* Relationship tuples naming this user are removed with the membership.
       Leaving them would mean re-adding the person silently restores every
       per-resource grant they had before — access nobody re-granted and no
       event records. */
    await tx
      .delete(schema.relationshipTuples)
      .where(
        and(
          eq(schema.relationshipTuples.subjectType, 'user'),
          eq(schema.relationshipTuples.subjectId, target.userId),
        ),
      );

    await tx.delete(schema.teamMembers).where(eq(schema.teamMembers.userId, target.userId));

    const envelope = { orgId, actorId: actor.userId, requestId: actor.requestId };
    const events: DomainEvent[] = [
      createEvent(
        memberRemoved,
        { membershipId: membership.id, userId: target.userId, role: currentRole },
        envelope,
      ),
    ];

    /* A person removed from the org is still `joined` on any call they were
       actually on — their own client's follow-up "I left" call is refused
       (they are no longer a member, which is the whole point of removing
       them) and its failure is silently swallowed as best-effort. Without
       this, that leaves the call open forever: see `leaveAllActiveSessionsFor`'s
       own header for the full failure mode. Same transaction as the removal
       itself, so a call is never left dangling because the removal committed
       and this half did not. */
    const leftCalls = await leaveAllActiveSessionsFor(tx, {
      orgId,
      userId: target.userId,
      now: new Date(),
    });
    for (const call of leftCalls) {
      events.push(createEvent(rtcSessionLeft, { sessionId: call.sessionId }, envelope));
      if (call.ended && call.endedDetails) {
        events.push(
          createEvent(
            rtcSessionEnded,
            {
              sessionId: call.sessionId,
              channelId: call.channelId,
              reason: call.endedDetails.reason,
              durationSeconds: call.endedDetails.durationSeconds,
              notifyUserIds: [...call.endedDetails.notifyUserIds],
              missedUserIds: [...call.endedDetails.missedUserIds],
            },
            envelope,
          ),
        );
      }
    }

    await outboxWriter.append(tx, events);

    return { removed: true as const };
  });
}

export interface TransferOwnershipInput {
  readonly toUserId: UserId;
  /** The role the OLD owner keeps after handing the org over. */
  readonly selfNewRole: 'admin' | 'member';
}

/**
 * Hands ownership to another member in ONE atomic transaction (§3.5,
 * ai/phase-12-admin.md §3.5).
 *
 * Replaces the accidental two-step workaround — promote target, demote self,
 * two calls by two people — with a single action. Both writes commit
 * together, so the org is never observably ownerless and never observably
 * has the old owner still holding the role after the call returns; no
 * `assertAnotherOwnerRemains`-style counting is needed because the two
 * writes can never leave zero owners, and a pre-existing second owner is
 * simply still there afterward (a shape this route did not create, and §3.5
 * explicitly says is not its job to detect).
 *
 * The route is `member:manage`, which the role matrix makes Owner-only — so
 * the permission check alone already guarantees the caller currently holds
 * the role they are giving away.
 */
export async function transferOwnership(
  orgId: OrgId,
  input: TransferOwnershipInput,
  actor: Actor,
): Promise<{ readonly newOwnerId: UserId }> {
  return withOrgScope(orgId, async (tx) => {
    const rows = await tx
      .select({ id: schema.memberships.id, role: schema.memberships.role })
      .from(schema.memberships)
      .where(eq(schema.memberships.userId, input.toUserId))
      .limit(1);

    const membership = rows[0];
    // NOT_FOUND rather than a message naming the user: across tenants, "that
    // person is not in this org" confirms the account exists (§8.7).
    if (!membership) throw errors.notFound();

    const currentRole = knownRole(membership.role);

    /* §3.5's first decided edge case: a guest must not jump straight to
       Owner. That would skip every intentional friction
       `isDirectlyAssignable`/`DIRECTLY_ASSIGNABLE_ROLES` builds into how
       someone reaches a real role, and "transfer ownership" must not be a
       shortcut around it. */
    if (currentRole !== 'admin' && currentRole !== 'member') {
      throw errors.validation({
        toUserId:
          'This person must be a member or admin before becoming Owner. Promote them first.',
      });
    }

    await tx
      .update(schema.memberships)
      .set({ role: 'owner', updatedAt: new Date() })
      .where(eq(schema.memberships.id, membership.id));

    await tx
      .update(schema.memberships)
      .set({ role: input.selfNewRole, updatedAt: new Date() })
      .where(and(eq(schema.memberships.orgId, orgId), eq(schema.memberships.userId, actor.userId)));

    await outboxWriter.append(tx, [
      createEvent(
        ownershipTransferred,
        {
          orgId,
          fromUserId: actor.userId,
          toUserId: input.toUserId,
          fromNewRole: input.selfNewRole,
        },
        { orgId, actorId: actor.userId, requestId: actor.requestId },
      ),
    ]);

    return { newOwnerId: input.toUserId };
  });
}

/**
 * Narrows a role read from a row to one this build knows.
 *
 * Refusing outright rather than treating an unknown role as "not an owner". A
 * role this build has never heard of is reachable during a rolling deploy, and
 * the safe reading of it is "I do not know what this person is", which must not
 * silently become "they are not the last owner" — that is the one wrong answer
 * that permanently orphans an organization.
 */
function knownRole(value: string): Role {
  if (!isRole(value)) {
    throw errors.conflict(
      'This membership holds a role this version does not recognize. Try again after the deploy completes.',
    );
  }
  return value;
}

/**
 * Refuses to leave the organization without an owner.
 *
 * Runs inside the caller's transaction on purpose. Counting owners in one
 * transaction and demoting in another lets two concurrent demotions each
 * observe two owners and both succeed, which is precisely how an org ends up
 * with none.
 */
async function assertAnotherOwnerRemains(
  tx: Parameters<Parameters<typeof withOrgScope>[1]>[0],
  excludingUserId: UserId,
): Promise<void> {
  const others = await tx
    .select({ id: schema.memberships.id })
    .from(schema.memberships)
    .where(
      and(
        eq(schema.memberships.role, 'owner'),
        eq(schema.memberships.status, 'active'),
        ne(schema.memberships.userId, excludingUserId),
      ),
    )
    .limit(1);

  if (!others[0]) {
    throw errors.conflict('An organization must always have an owner. Promote someone else first.');
  }
}
