import { and, eq, isNull } from 'drizzle-orm';
import { withApiTokenAuthScope } from './client.js';
import { apiTokens } from './schema/platform.js';

/**
 * The presented-`tf_pat` → (org, user, scopes) lookup the authentication path
 * needs before it has any scope (ai/phase-10-automation.md §6.2, §6.4;
 * migration 0050).
 *
 * ## Why this lives in packages/db rather than in apps/api
 *
 * It is the same reason `comms-directory.ts` and the outbox claims live here:
 * a query with no org yet is a cross-tenant read, and the narrow role that may
 * perform it is only ever reached through a named function in the data layer,
 * where it can be read in one sitting. Unlike `comms-directory`'s table — a
 * no-RLS sidecar carrying a SID and an org id and nothing else — the token
 * table CANNOT drop RLS: scopes and revocation ARE the security state, and a
 * copy that bypasses RLS would drift the instant anything else touched it. So
 * this lookup runs as `taskflow_api_token_auth`, the role whose only grant is
 * a column-level SELECT on the lookup columns with a `USING (true)` policy.
 *
 * ## What the caller still has to do
 *
 * The lookup answers WHO the token names. It does not say whether that person
 * may still act: the caller resolves the membership against the returned org
 * on every request (§6.4), so a demotion or removal takes effect on the next
 * call, and a suspended org refuses before any token is consulted.
 */
export interface ResolvedApiToken {
  /** The token's org — the org the request will act in, never the header's. */
  readonly orgId: string;
  /** The user who minted the token — the membership that must still hold. */
  readonly createdBy: string;
  /** The token's scope set, intersected with the live `can()` at the route. */
  readonly scopes: readonly string[];
  /**
   * The token's row id — becomes the principal's `sessionId` so audit entries
   * have something joinable to the token row (§6.4 step 5).
   */
  readonly tokenId: string;
  /**
   * When the token was minted — becomes the principal's `authenticatedAt`:
   * the token IS the credential, so this is when it was proved.
   */
  readonly createdAt: Date;
}

/**
 * Resolves a presented token by its hash, or undefined when it is unknown or
 * revoked.
 *
 * `revoked_at IS NULL` is in the WHERE, not filtered afterward — a revoked
 * token is refused by the lookup itself, so revocation takes effect on the
 * next request with no cache to outlive it.
 *
 * Revoked and never-minted are deliberately INDISTINGUISHABLE — both return
 * undefined, and the authentication path must not be able to tell them apart
 * (distinguishing them would turn the lookup into a token-existence oracle).
 */
export async function resolveApiToken(tokenHash: string): Promise<ResolvedApiToken | undefined> {
  if (tokenHash.length === 0) return undefined;

  return withApiTokenAuthScope(async (tx) => {
    const rows = await tx
      .select({
        orgId: apiTokens.orgId,
        createdBy: apiTokens.createdBy,
        scopes: apiTokens.scopes,
        tokenId: apiTokens.id,
        createdAt: apiTokens.createdAt,
      })
      .from(apiTokens)
      .where(and(eq(apiTokens.tokenHash, tokenHash), isNull(apiTokens.revokedAt)))
      .limit(1);

    const row = rows[0];
    if (row === undefined) return undefined;

    return {
      orgId: row.orgId,
      createdBy: row.createdBy,
      scopes: row.scopes,
      tokenId: row.tokenId,
      createdAt: row.createdAt,
    };
  });
}
