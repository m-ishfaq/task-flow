import {
  and,
  desc,
  eq,
  schema,
  withOrgScope,
  outboxWriter,
  resolveOrgByInvitationToken,
} from '@taskflow/db';
import { errors, type InvitationId, type OrgId, type UserId } from '@taskflow/contracts';
import { createEvent, type DomainEvent } from '@taskflow/events';
import { hashToken, issueToken, newId } from '@taskflow/security';
import { isDirectlyAssignable, isRole, type Role } from '@taskflow/policy';
import { invitationAccepted, invitationRevoked, invitationSent, memberAdded } from './events.js';
import { sendInvitationMail, type InvitationMailDeps } from './invitation-mail.js';
import type { Actor } from './org.service.js';

/**
 * Email invitations (migration 0107) — the slice `member.service.ts`'s
 * `addMember` doc comment named and deferred: inviting an address with no
 * TaskFlow account yet.
 *
 * ## Why this is a SEPARATE flow from `addMember`, not a replacement for it
 *
 * `addMember` stays exactly as it is: an instant add for an address that
 * already has an account, answering `NOT_FOUND` for one that doesn't. This
 * module adds a second door for the case that route was never built to
 * handle — an invitation that works identically whether the address already
 * has an account or not, always by mailed token, never instant. Two doors
 * rather than widening `addMember`'s contract, which existing tests and the
 * `members.add` route already depend on staying instant for a known account.
 *
 * ## The pre-tenant lookup
 *
 * `acceptInvitation` is called by someone who holds nothing but an opaque
 * token and is, by definition, not yet a member of the target org — there is
 * no scope to open until the org is known. `resolveOrgByInvitationToken`
 * (`@taskflow/db`) is the one read that can answer that, over
 * `identity.invitation_lookup`, the narrow no-RLS table migration 0107 built
 * for exactly this — see that migration's header before touching either
 * table.
 *
 * ## One row, rotated on resend
 *
 * Re-inviting an address that already has a pending invitation does not
 * create a second row — `invitations_org_email_pending_key` (a partial
 * unique index) could not allow it anyway. It ROTATES the existing row's
 * token, so a stale earlier email's link stops working the moment a newer
 * one is sent, and the pending list never shows the same person twice.
 */

/** How long an invitation stays acceptable before `status` reads `pending` but the link no longer works. */
const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface InvitationServiceDeps {
  readonly mail?: InvitationMailDeps | undefined;
}

export interface PendingInvitation {
  readonly invitationId: string;
  readonly email: string;
  readonly role: string;
  readonly invitedBy: string | null;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

export async function listInvitations(orgId: OrgId): Promise<readonly PendingInvitation[]> {
  return withOrgScope(orgId, async (tx) =>
    tx
      .select({
        invitationId: schema.invitations.id,
        email: schema.invitations.email,
        role: schema.invitations.role,
        invitedBy: schema.invitations.invitedBy,
        createdAt: schema.invitations.createdAt,
        expiresAt: schema.invitations.expiresAt,
      })
      .from(schema.invitations)
      .where(and(eq(schema.invitations.orgId, orgId), eq(schema.invitations.status, 'pending')))
      .orderBy(desc(schema.invitations.createdAt)),
  );
}

export interface CreateInvitationInput {
  readonly email: string;
  readonly role: Role;
}

/**
 * Sends (or resends) an invitation.
 *
 * Deliberately answers the same `{ status: 'invited' }` whether or not the
 * address already has an account and whether this is a new invitation or a
 * resend — an admin cannot use this to learn anything about the address
 * beyond what `members.list` already tells them about their own org.
 */
export async function createInvitation(
  orgId: OrgId,
  input: CreateInvitationInput,
  actor: Actor,
  deps: InvitationServiceDeps,
): Promise<{ readonly status: 'invited' }> {
  if (!isRole(input.role)) throw errors.validation({ role: 'Unknown role.' });
  if (!isDirectlyAssignable(input.role)) {
    throw errors.validation({
      role: 'Owner is reached by transferring ownership, not by invitation.',
    });
  }

  const normalized = input.email.trim().toLowerCase();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + INVITATION_TTL_MS);
  const issued = issueToken('invitation');

  const result = await withOrgScope(orgId, async (tx) => {
    /* identity.users carries no RLS (a user is not owned by an org) — the
       identical reasoning addMember's own comment gives for the same read. */
    const existingUser = await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.emailNormalized, normalized))
      .limit(1);

    if (existingUser[0]) {
      const membership = await tx
        .select({ id: schema.memberships.id })
        .from(schema.memberships)
        .where(
          and(
            eq(schema.memberships.orgId, orgId),
            eq(schema.memberships.userId, existingUser[0].id),
          ),
        )
        .limit(1);

      if (membership[0]) throw errors.conflict('That person is already a member.');
    }

    const pending = await tx
      .select({ id: schema.invitations.id, tokenHash: schema.invitations.tokenHash })
      .from(schema.invitations)
      .where(
        and(
          eq(schema.invitations.orgId, orgId),
          eq(schema.invitations.status, 'pending'),
          eq(schema.invitations.email, normalized),
        ),
      )
      .limit(1);

    const org = await tx
      .select({ name: schema.orgs.name })
      .from(schema.orgs)
      .where(eq(schema.orgs.id, orgId))
      .limit(1);
    const orgName = org[0]?.name ?? 'your organization';

    let invitationId: string;

    if (pending[0]) {
      invitationId = pending[0].id;
      await tx
        .update(schema.invitations)
        .set({ role: input.role, tokenHash: issued.hash, expiresAt, updatedAt: now })
        .where(eq(schema.invitations.id, invitationId));

      // The old token must stop resolving an org the instant a new one is
      // minted — otherwise a stale earlier email keeps working.
      await tx
        .delete(schema.invitationLookup)
        .where(eq(schema.invitationLookup.tokenHash, pending[0].tokenHash));
    } else {
      invitationId = newId<'InvitationId'>();
      await tx.insert(schema.invitations).values({
        id: invitationId,
        orgId,
        email: normalized,
        role: input.role,
        tokenHash: issued.hash,
        invitedBy: actor.userId,
        expiresAt,
      });
    }

    await tx.insert(schema.invitationLookup).values({ tokenHash: issued.hash, orgId });

    await outboxWriter.append(tx, [
      createEvent(
        invitationSent,
        { invitationId, orgId, email: normalized, role: input.role, invitedBy: actor.userId },
        { orgId, actorId: actor.userId, requestId: actor.requestId },
      ),
    ]);

    return { orgName };
  });

  if (deps.mail !== undefined) {
    sendInvitationMail(deps.mail, {
      to: normalized,
      orgName: result.orgName,
      role: input.role,
      token: issued.token,
      expiresAt,
    });
  }

  return { status: 'invited' as const };
}

export interface InvitationPreview {
  readonly orgName: string;
  readonly email: string;
  readonly role: string;
}

/**
 * What an invitation link SAYS before anyone is signed in — no session
 * required, the token itself is the proof, the identical trust model
 * `verifyEmail`/`resetPassword` already use for a mailed, single-use token.
 *
 * Exists for exactly one onboarding gap: someone with no TaskFlow account
 * yet, landing on an invite link, used to be bounced straight to a bare
 * `/login` with nothing to go on — no org name, no hint about which address
 * to sign up with. `AcceptInvitePage`/`LoginPage`/`RegisterPage` call this to
 * show "You're invited to join {orgName}" and pre-fill (and lock) the
 * register form's email to the address the invitation actually names, so a
 * new person cannot accidentally create an account under the wrong address
 * and hit `acceptInvitation`'s email-mismatch refusal after already doing
 * the work of registering and verifying.
 *
 * Revealing the invited email back to whoever holds the token is not a new
 * disclosure: it is the address that already received this exact link in
 * its own inbox. Same generic `errors.notFound()` as `acceptInvitation`
 * itself for an invalid, revoked, or expired token — this cannot be used to
 * probe which of those a given link is, or to enumerate valid tokens (the
 * token is a high-entropy secret, not a guessable id).
 */
export async function previewInvitation(input: {
  readonly token: string;
}): Promise<InvitationPreview> {
  const tokenHash = hashToken(input.token);
  const orgId = await resolveOrgByInvitationToken(tokenHash);
  if (orgId === undefined) throw errors.notFound('That invitation link is invalid or has expired.');

  return withOrgScope(orgId, async (tx) => {
    const rows = await tx
      .select({
        email: schema.invitations.email,
        role: schema.invitations.role,
        expiresAt: schema.invitations.expiresAt,
      })
      .from(schema.invitations)
      .where(
        and(
          eq(schema.invitations.orgId, orgId),
          eq(schema.invitations.tokenHash, tokenHash),
          eq(schema.invitations.status, 'pending'),
        ),
      )
      .limit(1);

    const invitation = rows[0];
    if (!invitation) throw errors.notFound('That invitation link is invalid or has expired.');

    /* Read-only — an expired row is left for `acceptInvitation` to flip to
       `'expired'` when someone actually tries to redeem it. A page load
       (or a mail-scanner prefetch) must not have a mutating side effect. */
    if (invitation.expiresAt <= new Date()) {
      throw errors.notFound('That invitation link is invalid or has expired.');
    }

    const org = await tx
      .select({ name: schema.orgs.name })
      .from(schema.orgs)
      .where(eq(schema.orgs.id, orgId))
      .limit(1);

    return {
      orgName: org[0]?.name ?? 'your organization',
      email: invitation.email,
      role: invitation.role,
    };
  });
}

export async function revokeInvitation(
  orgId: OrgId,
  input: { readonly invitationId: InvitationId },
  actor: Actor,
): Promise<{ readonly revoked: true }> {
  return withOrgScope(orgId, async (tx) => {
    const rows = await tx
      .select({
        id: schema.invitations.id,
        email: schema.invitations.email,
        tokenHash: schema.invitations.tokenHash,
      })
      .from(schema.invitations)
      .where(
        and(
          eq(schema.invitations.id, input.invitationId),
          eq(schema.invitations.orgId, orgId),
          eq(schema.invitations.status, 'pending'),
        ),
      )
      .limit(1);

    const invitation = rows[0];
    if (!invitation) throw errors.notFound();

    await tx
      .update(schema.invitations)
      .set({ status: 'revoked', updatedAt: new Date() })
      .where(eq(schema.invitations.id, invitation.id));

    await tx
      .delete(schema.invitationLookup)
      .where(eq(schema.invitationLookup.tokenHash, invitation.tokenHash));

    await outboxWriter.append(tx, [
      createEvent(
        invitationRevoked,
        { invitationId: invitation.id, orgId, email: invitation.email },
        { orgId, actorId: actor.userId, requestId: actor.requestId },
      ),
    ]);

    return { revoked: true as const };
  });
}

export interface AcceptInvitationResult {
  readonly orgId: string;
  readonly orgName: string;
  readonly role: string;
  readonly alreadyMember: boolean;
}

/**
 * Redeems an invitation token for the CURRENTLY AUTHENTICATED user.
 *
 * Called from a `selfRoute` — the caller has proven who they are (a real
 * session) but is not, by definition, yet a member of the org the token
 * names. Two things are checked beyond "does this token resolve to an org
 * and a pending row": the invitation must not have expired, and it must have
 * been addressed to the SAME email the caller's own account holds — a
 * logged-in session for a different address than the one invited must not
 * be able to redeem it, which is what stops a forwarded invitation email
 * from handing away access to whoever happens to click it while signed in
 * as someone else.
 *
 * One generic `errors.notFound()` covers "no such token", "already used",
 * "revoked", and "expired" — the identical one-answer-for-all-failure-modes
 * shape `verifyEmail`'s own comment states for its link, so this cannot be
 * used to probe which of those a given token is.
 */
export async function acceptInvitation(
  actor: { readonly userId: UserId; readonly requestId: Actor['requestId'] },
  input: { readonly token: string },
): Promise<AcceptInvitationResult> {
  const tokenHash = hashToken(input.token);
  const orgId = await resolveOrgByInvitationToken(tokenHash);
  if (orgId === undefined) throw errors.notFound('That invitation link is invalid or has expired.');

  return withOrgScope(orgId, async (tx) => {
    const now = new Date();

    const rows = await tx
      .select({
        id: schema.invitations.id,
        email: schema.invitations.email,
        role: schema.invitations.role,
        invitedBy: schema.invitations.invitedBy,
        expiresAt: schema.invitations.expiresAt,
      })
      .from(schema.invitations)
      .where(
        and(
          eq(schema.invitations.orgId, orgId),
          eq(schema.invitations.tokenHash, tokenHash),
          eq(schema.invitations.status, 'pending'),
        ),
      )
      .limit(1);

    const invitation = rows[0];
    if (!invitation) throw errors.notFound('That invitation link is invalid or has expired.');

    if (invitation.expiresAt <= now) {
      await tx
        .update(schema.invitations)
        .set({ status: 'expired', updatedAt: now })
        .where(eq(schema.invitations.id, invitation.id));
      await tx
        .delete(schema.invitationLookup)
        .where(eq(schema.invitationLookup.tokenHash, tokenHash));
      throw errors.notFound('That invitation link is invalid or has expired.');
    }

    // identity.users carries no RLS — readable from any scope, the same
    // reasoning addMember's own comment gives.
    const caller = await tx
      .select({ emailNormalized: schema.users.emailNormalized, email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, actor.userId))
      .limit(1);
    const callerEmail = caller[0];
    if (!callerEmail) throw errors.notFound();

    if (callerEmail.emailNormalized !== invitation.email) {
      throw errors.forbidden(
        'This invitation was sent to a different email address. Sign in with that address to accept it.',
      );
    }

    const org = await tx
      .select({ name: schema.orgs.name })
      .from(schema.orgs)
      .where(eq(schema.orgs.id, orgId))
      .limit(1);
    const orgName = org[0]?.name ?? 'your organization';

    const existingMembership = await tx
      .select({ id: schema.memberships.id })
      .from(schema.memberships)
      .where(and(eq(schema.memberships.orgId, orgId), eq(schema.memberships.userId, actor.userId)))
      .limit(1);

    const alreadyMember = existingMembership[0] !== undefined;

    const envelope = { orgId, actorId: actor.userId, requestId: actor.requestId };
    const events: DomainEvent[] = [
      createEvent(
        invitationAccepted,
        {
          invitationId: invitation.id,
          orgId,
          userId: actor.userId,
          email: invitation.email,
          role: invitation.role,
        },
        envelope,
      ),
    ];

    if (!alreadyMember) {
      const membershipId = newId<'MembershipId'>();
      await tx.insert(schema.memberships).values({
        id: membershipId,
        orgId,
        userId: actor.userId,
        role: invitation.role,
        invitedBy: invitation.invitedBy,
      });

      events.push(
        createEvent(
          memberAdded,
          {
            membershipId,
            userId: actor.userId,
            email: callerEmail.email,
            role: invitation.role,
            invitedBy: invitation.invitedBy,
          },
          envelope,
        ),
      );
    }

    await tx
      .update(schema.invitations)
      .set({ status: 'accepted', acceptedAt: now, acceptedUserId: actor.userId, updatedAt: now })
      .where(eq(schema.invitations.id, invitation.id));

    await tx
      .delete(schema.invitationLookup)
      .where(eq(schema.invitationLookup.tokenHash, tokenHash));

    await outboxWriter.append(tx, events);

    return { orgId, orgName, role: invitation.role, alreadyMember };
  });
}
