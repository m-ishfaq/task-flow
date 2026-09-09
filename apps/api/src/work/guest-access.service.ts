import { and, eq, schema, withOrgScope } from '@taskflow/db';
import { errors, unsafeAsId, type ProjectId, type UserId } from '@taskflow/contracts';
import { isGuestRole, type Relation } from '@taskflow/policy';
import { grant, revoke, type GrantInput } from '../tenancy/grant.service.js';
import { createInvitation, type InvitationServiceDeps } from '../tenancy/invitation.service.js';
import type { Actor } from '../tenancy/org.service.js';
import { requireProject } from './project.service.js';
import { orgOf, userOf, type WorkActor } from './shared.js';

/**
 * Guest access into Work (ai-driven product brainstorm, "guest access into
 * Work" — Chat already solved this exact problem for channels via
 * `chat/compliance.service.ts`'s `setGuestAccess`/`listChannelGuests`, and
 * this is the Work-module equivalent, one level up: PROJECT-scoped rather
 * than channel-scoped).
 *
 * ## A guest is a tuple, not a role — same as chat's version
 *
 * `GUEST` grants nothing from the role alone (`packages/policy/src/roles.ts`
 * has it as an empty list, deliberately). Guest access to a project IS a
 * relationship tuple naming that project, marked `is_guest` for review, and
 * nothing else changes about how `can()` reads it — the same `viewer` tuple
 * a Member could hold from the generic Share dialog admits a Guest exactly
 * the same way. There is no `if (isGuest)` branch anywhere in this file.
 *
 * ## A dedicated flow, not the generic Share dialog — reusing its engine
 *
 * `share-board.tsx` already calls the generic `tenancy.grants.grant`/
 * `.revoke`/`.list` directly (gated `member:manage` + step-up) for sharing a
 * BOARD with anyone. This is a deliberately SEPARATE, narrower door onto the
 * same underlying tuple engine (`grant()`/`revoke()` in
 * `tenancy/grant.service.ts`, reused rather than duplicated — the identical
 * idempotency, subject-validation and event-emission logic would otherwise
 * drift between the two granting surfaces) — chosen by the project owner
 * specifically so inviting an external guest reads as its own action, not a
 * board-sharing checkbox: gated `project:update` rather than the org-wide
 * `member:manage` + step-up the generic dialog requires, restricted to
 * `viewer`/`commenter`/`editor` (never `owner`, never `member` — `member`'s
 * extra grants, `message:create`/`attachment:upload`, are chat-shaped and
 * meaningless on a project), and refuses any target whose membership role is
 * not already `'guest'` (an admin reaching for THIS door for an ordinary
 * Member would get a validation error naming the generic Share dialog
 * instead, so this can never become a second, redundant way to grant a
 * Member access).
 *
 * ## Project-scoped only — the ancestor chain does the rest for free
 *
 * A tuple at the project level already flows down to every board and card
 * beneath it via `ancestorsOfBoard`/`ancestorsOfCard`. Scoping guest grants
 * to the project only gives a guest everything under it in one grant (the
 * actual use case — "loop in a contractor on this project") and sidesteps a
 * real asymmetry a per-board grant would hit: `board.service.ts`'s
 * `listBoards` requires `project:read` as a hard PRECONDITION before
 * returning anything, so a board-only guest (no project-level access) could
 * open a board via a direct link but never discover it through
 * `boards.list`. With project-scoped-only grants that asymmetry never
 * arises — a guest here always holds `project:read` on the one project
 * they were invited to, which is exactly what `listBoards` already
 * requires.
 *
 * ## Two transactions, not one nested inside the other
 *
 * `grant()`/`revoke()` each open their OWN `withOrgScope`, same as every
 * other tenancy write. Calling them from inside an already-open
 * `withOrgScope` here would nest `requireDb().transaction()` calls — a
 * second, independent transaction grabbed from the pool while the first is
 * still open, not a savepoint within it, which is not the "one atomic
 * transaction" guardrail 6 assumes. So `inviteGuestToProject`/
 * `revokeGuestAccess` read and validate in ONE transaction (mirroring
 * `card_create`'s own "chain several real service calls, each under its own
 * `can()` check" composition at the tool-execute layer, per
 * `ai/tools/card.ts`), then call `grant()`/`revoke()` — already
 * idempotent, already emitting their own events — sequentially afterward.
 *
 * ## One door, not two — `inviteGuestByEmail`
 *
 * The original shape of this feature required an admin to do two separate
 * things: add someone as a Guest-role member of the ORG first (via the
 * generic Members section — itself needing an existing account or a
 * separate mailed invitation), then come back HERE to grant project access.
 * Someone with no TaskFlow account at all had no path through this from the
 * project side. Found from a direct report, not assumed — the fix is one
 * email box: `inviteGuestByEmail` decides, server-side, which of the two
 * real cases applies —
 *
 *   - The address already belongs to a Guest-role member of THIS org: grants
 *     immediately, calling `inviteGuestToProject` exactly as before.
 *   - Anything else (no account yet, an account that has never joined this
 *     org, ...): sends a real org invitation with `role: 'guest'` via
 *     `tenancy/invitation.service.ts`'s `createInvitation`, carrying a
 *     `pendingGrant` for this exact project — see that file's own header
 *     for how the grant applies itself the instant the invite is accepted,
 *     with no second admin step.
 *
 * An address belonging to an existing member with a role OTHER than Guest
 * still refuses, naming the Share dialog — this door has never been, and
 * still is not, a way to hand a Member or Admin project access; it exists
 * only to loop in someone external.
 */

const GUEST_RELATIONS: readonly Relation[] = ['viewer', 'commenter', 'editor'];

function isGuestRelation(value: string): value is (typeof GUEST_RELATIONS)[number] {
  return (GUEST_RELATIONS as readonly string[]).includes(value);
}

function actorOf(actor: WorkActor): Actor {
  return { userId: userOf(actor), requestId: actor.requestId };
}

export interface ProjectGuestRow {
  readonly tupleId: string;
  readonly userId: string;
  readonly email: string;
  readonly displayName: string | null;
  readonly relation: string;
  readonly expiresAt: Date | null;
}

/**
 * Everyone currently holding GUEST access to this project — mirrors
 * `listChannelGuests`'s exact shape and reasoning: a roster of `is_guest`
 * tuples is a different question from "who can read this project", which
 * would also be true of every ordinary Member and tell the admin nothing
 * about who is external.
 */
export async function listProjectGuests(
  actor: WorkActor,
  input: { readonly projectId: ProjectId },
): Promise<readonly ProjectGuestRow[]> {
  return withOrgScope(orgOf(actor), async (tx) => {
    await requireProject(tx, actor, input.projectId, 'project:update');

    return tx
      .select({
        tupleId: schema.relationshipTuples.id,
        userId: schema.relationshipTuples.subjectId,
        email: schema.users.email,
        displayName: schema.profiles.displayName,
        relation: schema.relationshipTuples.relation,
        expiresAt: schema.relationshipTuples.expiresAt,
      })
      .from(schema.relationshipTuples)
      .innerJoin(schema.users, eq(schema.users.id, schema.relationshipTuples.subjectId))
      .leftJoin(schema.profiles, eq(schema.profiles.userId, schema.users.id))
      .where(
        and(
          eq(schema.relationshipTuples.subjectType, 'user'),
          eq(schema.relationshipTuples.objectType, 'project'),
          eq(schema.relationshipTuples.objectId, input.projectId),
          eq(schema.relationshipTuples.isGuest, true),
        ),
      );
  });
}

/**
 * Invites (or re-invites, at a different relation) one guest-role member
 * into one project.
 *
 * Any EXISTING guest tuple this user already holds on this project is
 * revoked first, so a project holds at most one active guest relation per
 * person at a time — "change this guest's access" is therefore just
 * inviting them again at a different relation, with no separate "update"
 * method needed.
 */
export async function inviteGuestToProject(
  actor: WorkActor,
  input: {
    readonly projectId: ProjectId;
    readonly userId: UserId;
    readonly relation: string;
    /** ISO timestamp, or null for a grant that does not lapse. */
    readonly expiresAt: string | null;
  },
): Promise<{ readonly tupleId: string }> {
  if (!isGuestRelation(input.relation)) {
    throw errors.validation({
      relation: 'Guest access is limited to viewer, commenter, or editor.',
    });
  }

  const orgId = orgOf(actor);

  const existingTupleIds = await withOrgScope(orgId, async (tx) => {
    await requireProject(tx, actor, input.projectId, 'project:update');

    const membership = await tx
      .select({ role: schema.memberships.role })
      .from(schema.memberships)
      .where(eq(schema.memberships.userId, input.userId))
      .limit(1);

    const target = membership[0];
    if (!target) throw errors.notFound();
    if (!isGuestRole(target.role)) {
      throw errors.validation({
        userId:
          'This person is not a Guest. Use the Share dialog to give an existing member access.',
      });
    }

    const existing = await tx
      .select({ id: schema.relationshipTuples.id })
      .from(schema.relationshipTuples)
      .where(
        and(
          eq(schema.relationshipTuples.subjectType, 'user'),
          eq(schema.relationshipTuples.subjectId, input.userId),
          eq(schema.relationshipTuples.objectType, 'project'),
          eq(schema.relationshipTuples.objectId, input.projectId),
          eq(schema.relationshipTuples.isGuest, true),
        ),
      );

    return existing.map((row) => row.id);
  });

  for (const tupleId of existingTupleIds) {
    await revoke(orgId, { tupleId }, actorOf(actor));
  }

  const grantInput: GrantInput = {
    subjectType: 'user',
    subjectId: input.userId,
    relation: input.relation,
    objectType: 'project',
    objectId: input.projectId,
    expiresAt: input.expiresAt,
    isGuest: true,
  };

  return grant(orgId, grantInput, actorOf(actor));
}

/**
 * The one door this feature offers a project admin — see this file's own
 * "One door, not two" header. Grants immediately for an address that is
 * already a Guest-role member of this org; otherwise sends a real mailed
 * invitation carrying a pending grant for this exact project, applied the
 * instant it is accepted.
 */
export async function inviteGuestByEmail(
  actor: WorkActor,
  input: {
    readonly projectId: ProjectId;
    readonly email: string;
    readonly relation: string;
    /** ISO timestamp, or null for a grant that does not lapse. */
    readonly expiresAt: string | null;
  },
  deps: { readonly invitations: InvitationServiceDeps },
): Promise<{ readonly status: 'granted' | 'invited' }> {
  if (!isGuestRelation(input.relation)) {
    throw errors.validation({
      relation: 'Guest access is limited to viewer, commenter, or editor.',
    });
  }

  const orgId = orgOf(actor);
  const normalized = input.email.trim().toLowerCase();

  const existingGuestUserId = await withOrgScope(orgId, async (tx) => {
    await requireProject(tx, actor, input.projectId, 'project:update');

    // identity.users carries no RLS — readable from any scope, the same
    // reasoning `invitation.service.ts`'s own lookup gives.
    const user = await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.emailNormalized, normalized))
      .limit(1);
    if (!user[0]) return undefined;

    const membership = await tx
      .select({ role: schema.memberships.role })
      .from(schema.memberships)
      .where(and(eq(schema.memberships.orgId, orgId), eq(schema.memberships.userId, user[0].id)))
      .limit(1);
    // No membership in THIS org yet — even if the address has an account
    // elsewhere, this is the "send an invitation" case, not the "grant now"
    // one, so fall through to the invite path below.
    if (!membership[0]) return undefined;

    if (!isGuestRole(membership[0].role)) {
      throw errors.validation({
        email:
          'This person is already a member with a non-Guest role. Use the Share dialog to give them access.',
      });
    }

    return user[0].id;
  });

  if (existingGuestUserId !== undefined) {
    await inviteGuestToProject(actor, {
      projectId: input.projectId,
      userId: unsafeAsId<'UserId'>(existingGuestUserId),
      relation: input.relation,
      expiresAt: input.expiresAt,
    });
    return { status: 'granted' as const };
  }

  await createInvitation(
    orgId,
    {
      email: normalized,
      role: 'guest',
      pendingGrant: {
        objectType: 'project',
        objectId: input.projectId,
        relation: input.relation,
        isGuest: true,
      },
    },
    actorOf(actor),
    deps.invitations,
  );

  return { status: 'invited' as const };
}

/** Revokes every guest tuple this user holds on this project. */
export async function revokeGuestAccess(
  actor: WorkActor,
  input: { readonly projectId: ProjectId; readonly userId: UserId },
): Promise<{ readonly revoked: true }> {
  const orgId = orgOf(actor);

  const existingTupleIds = await withOrgScope(orgId, async (tx) => {
    await requireProject(tx, actor, input.projectId, 'project:update');

    const existing = await tx
      .select({ id: schema.relationshipTuples.id })
      .from(schema.relationshipTuples)
      .where(
        and(
          eq(schema.relationshipTuples.subjectType, 'user'),
          eq(schema.relationshipTuples.subjectId, input.userId),
          eq(schema.relationshipTuples.objectType, 'project'),
          eq(schema.relationshipTuples.objectId, input.projectId),
          eq(schema.relationshipTuples.isGuest, true),
        ),
      );

    if (existing.length === 0) throw errors.notFound();

    return existing.map((row) => row.id);
  });

  for (const tupleId of existingTupleIds) {
    await revoke(orgId, { tupleId }, actorOf(actor));
  }

  return { revoked: true as const };
}
