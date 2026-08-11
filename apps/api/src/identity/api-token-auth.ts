import { unsafeAsId, OrgIdSchema } from '@taskflow/contracts';
import { resolveApiToken } from '@taskflow/db';
import { hashToken, isTokenKind } from '@taskflow/security';
import type { AuthenticatedPrincipal, OrgMembership } from '../trpc/context.js';
import { resolveOrgMembership } from '../tenancy/resolve.js';
import { bearerToken } from './authenticate.js';

/**
 * API-token authentication (ai/phase-10-automation.md §6.4, Wave 3 slice 3).
 *
 * ⚠ HUMAN REVIEW SURFACE (§2.2) — the second function that decides who a
 * request is, and it gets the same read-every-line treatment as `authenticate`.
 *
 * ## The order is the argument
 *
 * Every step below refuses before the next one runs, and the sequence exists
 * in this exact shape for a reason:
 *
 *   1. **The kind is part of the contract.** `tf_pat` is checked BEFORE the
 *      hash lookup, so a refresh token or a session JWT cannot be fed to the
 *      token store. `isTokenKind` on a parsed bearer, never a substring test
 *      on the raw header — `bearerToken` is reused from `authenticate` so the
 *      two paths parse identically.
 *   2. **The lookup answers WHO, not WHETHER THEY MAY ACT.** `resolveApiToken`
 *      refuses revoked/unknown tokens by the lookup itself (the WHERE carries
 *      `revoked_at IS NULL`). A token either resolves or it does not — there is
 *      no courtesy window for a stale credential.
 *   3. **The org comes from the TOKEN, never from the `x-taskflow-org`
 *      header.** That header is attacker-controlled, and a token minted for
 *      org A must not be steerable at org B by sending a header. A token
 *      request whose header DISAGREES with the token's org is REFUSED rather
 *      than ignored (§9 decision 11): a script that copied a browser's header
 *      fails loudly instead of quietly doing nothing. The header is therefore
 *      not a WHERE filter here — it is either absent (fine: the token names
 *      its org) or equal to the token's org (fine) or a REFUSAL.   *   4. **The membership is re-resolved on every request.** `resolveOrgMembership`
 *      reads role + tuples live — exactly the JWT path — so a demotion or a
 *      removal takes effect on the next call, and a suspended org refuses here
 *      too. **A token does not outlive its holder's membership.**
 *   5. **The principal carries `tokenScopes`.** The builder (trpc/builder.ts)
 *      intersects this set with the route's permission and refuses token
 *      principals on self/step-up routes — see §6.4's two gate paragraphs.
 */
export async function authenticateWithApiToken(
  authorization: string | undefined,
  orgHeader: string | string[] | undefined,
): Promise<AuthenticatedPrincipal | null> {
  const token = bearerToken(authorization);
  if (token === null) return null;

  /* Step 1 — the kind is part of the contract. Anything that is not a `tf_pat`
     is not this path's business: it might be a JWT (the other path) or garbage
     (no path). */
  if (!isTokenKind(token, 'apiToken')) return null;

  /* Step 2 — the hash lookup. The plaintext token is hashed here and never
     leaves this function; the lookup runs as `taskflow_api_token_auth` (the
     narrow role whose column-level grant this read is exactly shaped for). */
  const resolved = await resolveApiToken(hashToken(token));
  if (resolved === undefined) return null;

  /* Step 3 — the org is the token's org, and a disagreeing header is a
     refusal. Absent header: fine. Non-string (a repeated header): not an org
     id, treated as absent. Present and a valid org id different from the
     token's: REFUSED — returning null makes every fail-closed route answer
     UNAUTHENTICATED, which is the loud failure decision 11 wants. Present and
     EQUAL: fine, and the equality is asserted rather than trusted because the
     header is attacker-controlled. */
  const requested = Array.isArray(orgHeader) ? undefined : orgHeader;
  if (requested !== undefined && requested.length > 0) {
    const parsed = OrgIdSchema.safeParse(requested);
    if (!parsed.success || parsed.data !== resolved.orgId) {
      return null;
    }
  }

  /* Step 4 — live membership, exactly as the JWT path resolves it. `createdBy`
     is the minting user: the membership that must still hold is theirs.
     `resolveOrgMembership` collapses a deleted member into null, and throws
     ORG_SUSPENDED for a suspended org.

     The throw is caught here rather than propagated, and that is the
     HTTP-boundary analysis, not laziness: an AppError escaping `createContext`
     is converted by the tRPC adapter's `getTRPCErrorFromUnknown` into a 500 —
     the `mapErrors` middleware that turns AppErrors into their proper codes
     only wraps procedures, never the context builder. The JWT path swallows
     the same throw inside `withOrgContext` and lets the route answer
     NOT_A_MEMBER; a null principal here makes every fail-closed route answer
     UNAUTHENTICATED. Both are refusals. Only the propagated version is a
     server error. */
  let membership: OrgMembership | null;
  try {
    membership = await resolveOrgMembership(
      unsafeAsId<'UserId'>(resolved.createdBy),
      resolved.orgId,
    );
  } catch {
    return null;
  }
  if (membership === null) return null;

  return {
    userId: unsafeAsId<'UserId'>(resolved.createdBy),
    sessionId: unsafeAsId<'SessionId'>(resolved.tokenId),
    authenticatedAt: resolved.createdAt,
    org: membership,
    /* Step 5 — the scope set the builder intersects with the route's
       permission. Read-only: never re-derived here, only enforced. */
    tokenScopes: resolved.scopes,
  };
}
