import type { OrgId, RequestId, SessionId, UserId } from '@taskflow/contracts';
import type { Permission, RelationshipTuple, Role, Subject } from '@taskflow/policy';

/**
 * What every request carries.
 *
 * `principal` is null for an unauthenticated request and is the ONLY way a
 * handler learns who is calling. In particular there is no `orgId` on the
 * context outside it: an org id taken from a path parameter or a header is
 * attacker-controlled, and feeding one to `withOrgScope` would set the RLS
 * session variable to whatever the caller asked for — turning the strongest
 * guardrail in the system into an instruction.
 */

/**
 * The organization the caller is acting in, and what they may do there.
 *
 * NESTED inside the principal rather than sitting beside it, because the two are
 * not independent facts: an org membership without an authenticated user is
 * meaningless, and two sibling nullable fields would let that state be
 * constructed. Here it cannot be expressed.
 */
export interface OrgMembership {
  /** From the membership lookup. Never from a request parameter. */
  readonly orgId: OrgId;
  readonly role: Role;
  /** Already expanded through team membership by the tuple loader. */
  readonly tuples: readonly RelationshipTuple[];
  /**
   * Individual, org-level permissions granted to this member on top of
   * their role (ai/phase-15-ai-copilot-and-permissions.md §1), already
   * filtered to active (non-revoked) rows by `loadMemberGrants`.
   */
  readonly memberGrants: readonly Permission[];
}

/**
 * What a verified access token ALONE proves: a user, a session, and when they
 * last presented a credential.
 *
 * Note what is NOT in that list — a role. The token is signed by this API and
 * could carry one, and the earlier draft of this interface assumed it would.
 * That would mean a demotion takes effect only when the token expires, so a
 * revoked admin keeps admin for the ten minutes that matter most. The role comes
 * from a membership read instead, and `org` is null until Phase 2 provides one.
 */
export interface AuthenticatedPrincipal {
  readonly userId: UserId;
  readonly sessionId: SessionId;
  /**
   * When the session last proved possession of a credential.
   *
   * Step-up re-authentication (§8.1) compares against this for role changes, API
   * token creation, number purchase, and recording export. Deliberately NOT
   * advanced by a refresh — see identity.service.ts.
   *
   * For a token-authenticated principal this is the token's `created_at` — the
   * token IS the credential, so this is when it was proved (§6.4 step 5).
   */
  readonly authenticatedAt: Date;
  /** Null when the caller has authenticated but selected no organization. */
  readonly org: OrgMembership | null;
  /**
   * The scope set of the API token this request authenticated with, or null
   * for a session-authenticated request (ai/phase-10-automation.md §6.4).
   *
   * Non-null is the marker of a TOKEN principal: the builder refuses token
   * principals on self/step-up routes, and intersects this set with the route's
   * declared permission before the handler runs — a token scoped to
   * `card:read` is refused on a `card:update` route even while its owner could
   * do both.
   */
  readonly tokenScopes: readonly string[] | null;
}

/** A principal that has an organization — what a permission check needs. */
export interface OrgScopedPrincipal extends AuthenticatedPrincipal {
  readonly org: OrgMembership;
}

/**
 * Flattens a principal into the shape the policy engine takes.
 *
 * One function, so the mapping from "who is calling" to "what can() is asked
 * about" exists in exactly one place. Assembling this inline at each call site
 * is how a handler ends up passing a role from somewhere other than the
 * membership.
 */
export function subjectOf(principal: OrgScopedPrincipal): Subject {
  return {
    orgId: principal.org.orgId,
    userId: principal.userId,
    role: principal.org.role,
    tuples: principal.org.tuples,
    memberGrants: principal.org.memberGrants,
  };
}

export interface RequestContext {
  readonly requestId: RequestId;
  readonly principal: AuthenticatedPrincipal | null;

  /**
   * The refresh token from its httpOnly cookie, if one arrived.
   *
   * Read from the cookie by the Fastify layer and never from a request body. A
   * refresh token in a body is a refresh token JavaScript can read, which
   * removes the entire reason for splitting the token pair in two: the short
   * access token lives in memory and can be stolen by XSS for ten minutes, while
   * the thing that mints new ones is unreachable from script.
   */
  readonly refreshToken: string | null;

  /** For audit entries, rate limiting, and abuse analysis. Null behind a proxy that strips it. */
  readonly ip: string | null;
  readonly userAgent: string | null;

  /**
   * Writes (or clears, with null) the refresh cookie on the response.
   *
   * A callback rather than direct access to the Fastify reply, so a route cannot
   * set arbitrary headers and so the same router works under the in-process
   * caller used by tests and the fuzz harness, where there is no response at all.
   *
   * The routes that issue a session call this INSTEAD of returning the refresh
   * token in the body. Returning it would mean JavaScript can read it, which
   * removes the entire reason for splitting the token pair.
   */
  readonly setRefreshCookie: (token: string | null) => void;
}

/** Narrowed context for routes that have passed the authentication middleware. */
export interface AuthenticatedContext extends RequestContext {
  readonly principal: AuthenticatedPrincipal;
}

/** Narrowed further: authenticated AND acting inside an organization. */
export interface OrgScopedContext extends AuthenticatedContext {
  readonly principal: OrgScopedPrincipal;
}
