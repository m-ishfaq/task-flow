import { eq } from 'drizzle-orm';
import { withGlobalScope } from './client.js';
import type { OrgId } from './client.js';
import { invitationLookup } from './schema/tenancy.js';

/**
 * The invitation-token → org lookup `acceptInvitation` needs before it has a
 * scope (migration 0107's own header) — the identical shape and reasoning as
 * `resolveOrgBySubaccountSid`/`resolveOrgByStripeCustomerId`. Lives here
 * rather than in `apps/api/src/tenancy` because `withGlobalScope` is
 * lint-restricted to `packages/db` and the identity module.
 *
 * `identity.invitation_lookup` carries a token hash and an org id and
 * nothing else, with no RLS by design — which is why a global-scope read of
 * it works, and why it is safe that it does.
 *
 * Unlike its webhook siblings, the caller here already proved possession of
 * the credential (the raw token, hashed before it ever reaches this
 * function) — there is no signature left to verify afterward. What the
 * caller has NOT yet proven is that the invitation is still pending and
 * addressed to them; `invitation.service.ts`'s `acceptInvitation` checks
 * both, inside the scope this resolves, before doing anything else.
 */
export async function resolveOrgByInvitationToken(tokenHash: string): Promise<OrgId | undefined> {
  if (tokenHash.length === 0) return undefined;

  return withGlobalScope(async (tx) => {
    const rows = await tx
      .select({ orgId: invitationLookup.orgId })
      .from(invitationLookup)
      .where(eq(invitationLookup.tokenHash, tokenHash))
      .limit(1);

    const row = rows[0];
    return row === undefined ? undefined : (row.orgId as OrgId);
  });
}
