import { escapeHtml } from '@taskflow/mail';
import type { MailQueue } from '@taskflow/mail';
import { DEFAULT_PRODUCT_NAME } from '../platform-admin/branding-cache.js';

/**
 * Invitation email — sent by `invitation.service.ts`, the same
 * queue-and-forget shape `billing-mail.ts` already established for a mail
 * class that lives outside `apps/api/src/identity`'s own `DeliverableLink`
 * union.
 *
 * ## Why this is not a `DeliverableLink` kind
 *
 * `identity.service.ts`'s `DeliverableLink` union is a ⚠ human-review
 * surface (identity), and every kind on it is about ONE account's own
 * credential — a password reset, a verification link, a security notice sent
 * to the account holder. An invitation is different in a way that matters: it
 * is addressed to someone who may not have an account at all, sent by an ORG
 * ADMIN about the ORG, not by the recipient about themselves. Routing it
 * through identity's `deliver` would mean widening a human-review surface for
 * a message that has nothing to do with what that surface protects.
 *
 * ## The link is a real credential, unlike `renderNotificationEmail`'s
 *
 * `packages/mail/src/templates.ts`'s own header draws this line: a
 * verification/reset link IS the whole proof, single-use and time-boxed; an
 * ordinary notification link is not. An invitation link is the FIRST kind —
 * possession of it is what lets someone join an org they were never a member
 * of — so it gets the identical treatment: escaped org name (user-supplied,
 * the same `<img onerror=...>` risk `billing-mail.ts`'s own header names for
 * an org name reaching a template), one link, and a stated expiry.
 */

export interface InvitationMailDeps {
  readonly queue: MailQueue;
  readonly webOrigin: string;
  readonly productName?: string;
}

const ROLE_LABEL: Record<string, string> = {
  admin: 'an Admin',
  member: 'a Member',
  guest: 'a Guest',
};

/**
 * Sends (or re-sends) the invitation email.
 *
 * Takes the raw token, never a hash — the one place in this whole flow a
 * plaintext token exists outside the moment it was minted, matching
 * `IdentityConfig`'s own `DeliverableLink.token` shape for the identical
 * reason: the database holds only the hash (migration 0107), so the token
 * exists in memory exactly long enough to reach this call.
 */
export function sendInvitationMail(
  deps: InvitationMailDeps,
  input: {
    readonly to: string;
    readonly orgName: string;
    readonly role: string;
    readonly token: string;
    readonly expiresAt: Date;
  },
): void {
  const acceptUrl = `${deps.webOrigin}/invite/accept?token=${encodeURIComponent(input.token)}`;
  const roleLabel = ROLE_LABEL[input.role] ?? input.role;
  const org = escapeHtml(input.orgName);
  const orgText = input.orgName;
  const days = Math.max(1, Math.round((input.expiresAt.getTime() - Date.now()) / 86_400_000));
  const daysText = `${days.toString()} day${days === 1 ? '' : 's'}`;

  const product = deps.productName ?? DEFAULT_PRODUCT_NAME;
  const subject = `You're invited to join ${orgText} on ${product}`;
  const text =
    `You have been invited to join ${orgText} on ${product} as ${roleLabel}.\n\n` +
    `Accept the invitation: ${acceptUrl}\n\n` +
    `This link expires in ${daysText}. If you were not expecting ` +
    'this invitation, you can ignore this email.';

  const html =
    `<p>You have been invited to join <strong>${org}</strong> on ${escapeHtml(product)} as ${roleLabel}.</p>` +
    `<p><a href="${escapeHtml(acceptUrl)}">Accept the invitation</a></p>` +
    `<p>This link expires in ${daysText}. If you were not expecting ` +
    'this invitation, you can ignore this email.</p>';

  deps.queue.enqueue({ to: input.to, subject, text, html });
}
