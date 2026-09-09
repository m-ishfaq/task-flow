import { and, eq, isNotNull, schema, withOrgScope } from '@taskflow/db';
import type { DataKey, OrgId } from '@taskflow/contracts';
import { encryptString } from '@taskflow/security';
import { integrationTokenAad } from './connector-aad.js';

/* Structural, not imported from `integration.service.ts` — that module
   imports FUNCTIONS from this one (`refreshGithubToken` et al.), and
   `import-x/no-cycle` (packages/config/eslint/base.js) refuses the reverse
   edge even for a type-only import. Both shapes are exactly
   `ConnectorProviderCredentials`/`Pick<IntegrationDeps, 'fetchImpl'>` there;
   TypeScript's structural typing means neither side needs to import the
   other's name for a call to type-check. */
interface GithubOAuthCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
}

/**
 * GitHub OAuth token refresh (migration 0109) — deliberately NOT a
 * `*.service.ts` file, the `rebalance.ts`/`counters.ts` precedent: the one
 * function here that mutates (`persistRefreshedGithubToken`) is repository-
 * shaped bookkeeping underneath an already-authorized read, not a product
 * action of its own, so it has no domain event to emit — guardrail 11's
 * `**\/*.service.ts` scope is what makes that a legitimate omission rather
 * than a silent one; see `packages/config/eslint/security.js`'s own comment
 * on why repositories mutate without emitting by design. The event belongs
 * to whatever the CALLER was actually doing (posting a comment, reading a
 * diff) — this file only keeps the credential that made it possible alive.
 */

/**
 * The shape of GitHub's `POST /login/oauth/access_token` response, used by
 * both a fresh code exchange (`integration.service.ts`'s own
 * `exchangeGithubCode`) and a refresh below — the same endpoint answers
 * both, differing only in the request's `grant_type`. `expires_in`/
 * `refresh_token`/`refresh_token_expires_in` are present ONLY when the
 * connecting OAuth App has opted into GitHub's "expire user tokens"
 * setting — absent otherwise, in which case every field past `token` reads
 * null and the caller treats the credential as non-expiring, exactly as it
 * always has.
 */
export interface GithubTokenGrant {
  readonly token: string;
  readonly expiresInSeconds: number | null;
  readonly refreshToken: string | null;
  readonly refreshTokenExpiresInSeconds: number | null;
}

export function parseGithubTokenGrant(body: unknown): GithubTokenGrant | null {
  if (typeof body !== 'object' || body === null) return null;
  const record = body as Record<string, unknown>;
  // A malformed grant/refresh_token/expired-app-secret answers 200 with an
  // `error` field rather than a non-2xx status — GitHub's own documented
  // shape for this endpoint under `Accept: application/json`.
  if (typeof record['error'] === 'string') return null;
  if (typeof record['access_token'] !== 'string') return null;

  return {
    token: record['access_token'],
    expiresInSeconds: typeof record['expires_in'] === 'number' ? record['expires_in'] : null,
    refreshToken: typeof record['refresh_token'] === 'string' ? record['refresh_token'] : null,
    refreshTokenExpiresInSeconds:
      typeof record['refresh_token_expires_in'] === 'number'
        ? record['refresh_token_expires_in']
        : null,
  };
}

/** `null` in, `null` out — the "this credential does not expire" case. */
export function expiresAtFrom(seconds: number | null): Date | null {
  return seconds === null ? null : new Date(Date.now() + seconds * 1000);
}

/**
 * Exchanges a still-valid refresh token for a new access token — the same
 * endpoint the initial code exchange uses, `grant_type=refresh_token`
 * instead of `authorization_code`. Returns `null` on ANY failure (network,
 * non-2xx, or a body-level `error`) rather than throwing: the caller
 * (`connectorFor`) falls back to the stale token it already has, and the
 * REAL caller's own GitHub request surfaces the honest 401 with its
 * existing "reconnect" hint — this function never invents a new error class
 * for what is, from the outside, the identical failure.
 */
export async function refreshGithubToken(
  deps: { readonly fetchImpl?: typeof fetch },
  credentials: GithubOAuthCredentials,
  refreshToken: string,
): Promise<GithubTokenGrant | null> {
  const fetchFn = deps.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await fetchFn('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
      }).toString(),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;

  return parseGithubTokenGrant(await response.json());
}

/**
 * Re-encrypts a refreshed access/refresh token pair under the SAME data key
 * the row already uses (no re-wrap needed — a data key is not being
 * rotated, only the plaintext it protects) and writes it back.
 *
 * Guarded on `token_wrapped IS NOT NULL`, not `status = 'connected'` — the
 * first version used the latter and, found from a real CI run (not a
 * hypothesis), silently discarded every refresh triggered during the
 * 'pending_repo' picker phase: `selectRepo`'s and `listReposForIntegration`'s
 * own `tokenForRow` calls read a row that is still `status = 'disconnected'`
 * (awaiting a repo choice, credentials very much present) right up until
 * `selectRepo`'s own later UPDATE flips it — so a refresh triggered by
 * either of those reads matched zero rows here, the API call to GitHub
 * happened for nothing, and the very next read saw the same stale expiry
 * and refreshed AGAIN. `disconnectIntegration`'s wipe is what the guard is
 * actually protecting against: it NULLs every credential column in the same
 * UPDATE that flips `status`, so checking that the credential is still
 * present is the same race protection the status check was trying to
 * express, without also refusing the picker-phase case that never disconnected.
 */
export async function persistRefreshedGithubToken(
  orgId: OrgId,
  integrationId: string,
  dataKey: DataKey,
  tokenWrapped: Uint8Array,
  refreshed: GithubTokenGrant,
): Promise<void> {
  await withOrgScope(orgId, async (tx) => {
    const aad = integrationTokenAad(orgId, integrationId);
    const tokenCiphertext = encryptString(dataKey.key, refreshed.token, aad);
    const refreshTokenCiphertext =
      refreshed.refreshToken === null
        ? null
        : encryptString(dataKey.key, refreshed.refreshToken, aad);

    await tx
      .update(schema.integrations)
      .set({
        tokenCiphertext: Buffer.from(tokenCiphertext),
        tokenWrapped: Buffer.from(tokenWrapped),
        tokenMasterId: dataKey.masterKeyId,
        tokenExpiresAt: expiresAtFrom(refreshed.expiresInSeconds),
        /* GitHub rotates the refresh token on every use — a successful
           refresh call almost always returns a new one. Omitted (never
           nulled) when it does not, so an old-but-still-valid refresh
           token is not thrown away for want of a new one in this one
           response. */
        ...(refreshTokenCiphertext === null
          ? {}
          : {
              refreshTokenCiphertext: Buffer.from(refreshTokenCiphertext),
              refreshTokenWrapped: Buffer.from(tokenWrapped),
              refreshTokenMasterId: dataKey.masterKeyId,
              refreshTokenExpiresAt: expiresAtFrom(refreshed.refreshTokenExpiresInSeconds),
            }),
      })
      .where(
        and(eq(schema.integrations.id, integrationId), isNotNull(schema.integrations.tokenWrapped)),
      );
  });
}
