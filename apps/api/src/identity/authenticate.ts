import { SessionIdSchema, UserIdSchema } from '@taskflow/contracts';
import { verifyAccessToken } from '@taskflow/security';
import type { AuthenticatedPrincipal } from '../trpc/context.js';

/**
 * Turns an `Authorization` header into a principal (PLAN.md §8.1).
 *
 * ⚠ HUMAN REVIEW SURFACE (§2.2).
 *
 * This is the function that decides who every request is, and it has exactly one
 * job: verify the signature and report what the token says. It does not consult
 * the database, and that is a design commitment rather than an omission — see
 * `verifyAccessToken` in @taskflow/security. Revocation is bounded by the
 * ten-minute token lifetime and enforced at refresh; a session lookup here would
 * put a query on the hot path of every request and undo the reason the token
 * exists.
 *
 * ## Why a bad token is `null` rather than a rejection
 *
 * An unparseable, expired, or forged token produces the same result as no token
 * at all: an unauthenticated request. Rejecting outright would change nothing
 * for protected routes — they already fail closed — while breaking the case that
 * matters, which is a client holding a stale token calling `auth.login` or
 * `auth.refresh` to get a fresh one. Failing the request there would strand a
 * user whose only problem is that ten minutes elapsed.
 *
 * The safety of that choice rests entirely on routes being fail-closed by
 * construction (guardrail 4). It is not a general licence to swallow errors.
 */

const BEARER = /^Bearer$/i;

export interface AuthenticateConfig {
  readonly jwtSecret: Uint8Array;
}

/**
 * Extracts the token from an `Authorization` header value.
 *
 * Exported for its own tests. The parsing is stricter than it looks necessary
 * to be: exactly two whitespace-separated parts, scheme matched case-
 * insensitively per RFC 9110 §11.1, and no attempt to be helpful about a bare
 * token with no scheme. Accepting `Authorization: <jwt>` would mean any header
 * that happens to hold a JWT-shaped string authenticates a request.
 */
export function bearerToken(header: string | undefined): string | null {
  if (typeof header !== 'string') return null;

  const parts = header.trim().split(/\s+/);
  if (parts.length !== 2) return null;

  const [scheme, token] = parts;
  if (scheme === undefined || token === undefined) return null;
  if (!BEARER.test(scheme)) return null;

  return token.length > 0 ? token : null;
}

/**
 * Verifies a bearer token and returns the principal it names, or null.
 *
 * `org` is always null today. The token carries no membership because none
 * exists yet, and deriving one from a claim would mean the caller's own
 * credential asserted their role — see `requireOrg` in trpc/builder.ts.
 */
export async function authenticate(
  header: string | undefined,
  config: AuthenticateConfig,
): Promise<AuthenticatedPrincipal | null> {
  const token = bearerToken(header);
  if (token === null) return null;

  try {
    const claims = await verifyAccessToken(token, { secret: config.jwtSecret });

    /* Parsed rather than cast. The signature proves the claims came from this
       API, not that they are well-formed — a token minted by an earlier version
       of this code, or by a bug, is correctly signed and still nonsense. A
       malformed id that reached `withOrgScope` would be a string interpolated
       into an RLS session variable. */
    const userId = UserIdSchema.safeParse(claims.userId);
    const sessionId = SessionIdSchema.safeParse(claims.sessionId);
    if (!userId.success || !sessionId.success) return null;

    return {
      userId: userId.data,
      sessionId: sessionId.data,
      authenticatedAt: new Date(claims.authenticatedAt * 1000),
      org: null,
      tokenScopes: null,
    };
  } catch {
    // verifyAccessToken throws one error for every failure mode on purpose, so
    // there is nothing here worth distinguishing.
    return null;
  }
}
