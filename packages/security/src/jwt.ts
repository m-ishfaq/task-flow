import { SignJWT, jwtVerify, type JWTPayload } from 'jose';

/**
 * Access tokens (PLAN.md §8.1).
 *
 * The access token is a short-lived, signed statement of who the caller is. It
 * is held in browser MEMORY only — never localStorage, never a cookie — and the
 * long-lived half of the pair is the httpOnly refresh cookie, which JavaScript
 * cannot read. That split is what keeps an XSS from becoming permanent account
 * takeover: script running on the page can steal an access token good for ten
 * minutes, but not the thing that mints new ones.
 *
 * HS256 rather than RS256 because there is exactly one issuer and one verifier,
 * both this API. Asymmetric signing buys the ability to let other parties verify
 * without the signing key, which nothing here needs, in exchange for key
 * management this project does not want yet. If the socket gateway or a
 * third-party consumer ever verifies these, that trade flips and this becomes
 * RS256 — the interface below does not change.
 *
 * ⚠ HUMAN REVIEW SURFACE (§2.2).
 */

/**
 * Ten minutes.
 *
 * The number is a bet about revocation: an access token cannot be withdrawn
 * before it expires, so this is the maximum time a revoked session keeps
 * working. Shorter means more refresh round-trips; longer means "log out
 * everywhere" is a lie for longer. Session revocation checks happen on refresh,
 * so this is exactly the window.
 */
export const ACCESS_TOKEN_TTL_SECONDS = 600;

const ALGORITHM = 'HS256';

/**
 * Fixed issuer and audience.
 *
 * Both are verified, not merely set. Without them a token minted for one purpose
 * — a webhook signature, a different environment sharing a secret by accident —
 * can be presented as an access token, and the signature check passes because
 * the signature is genuinely valid. Binding is what makes "correctly signed"
 * mean "signed for this".
 */
const ISSUER = 'taskflow';
const AUDIENCE = 'taskflow-api';

export interface AccessTokenClaims {
  /** The authenticated user. */
  readonly userId: string;
  /** The session this token belongs to, so a refresh can be tied back to it. */
  readonly sessionId: string;
  /** The active organization, if the caller has selected one. */
  readonly orgId?: string;
  /** Role within that organization. Re-read on refresh, never trusted longer. */
  readonly role?: string;
  /** Seconds since epoch when a credential was last proven, for step-up (§8.1). */
  readonly authenticatedAt: number;
}

export interface JwtConfig {
  /** 32 raw bytes. Comes from the validated env schema, never a literal. */
  readonly secret: Uint8Array;
}

function assertSecret(secret: Uint8Array): void {
  if (secret.length < 32) {
    // HS256's security is bounded by the key length. A short secret is
    // brute-forceable offline from a single captured token, which is a total
    // authentication bypass rather than a degradation.
    throw new RangeError(
      `JWT secret must be at least 32 bytes, got ${String(secret.length)}. A shorter key can be recovered offline from one captured token.`,
    );
  }
}

/** Signs an access token valid for `ACCESS_TOKEN_TTL_SECONDS`. */
export async function signAccessToken(
  claims: AccessTokenClaims,
  config: JwtConfig,
): Promise<string> {
  assertSecret(config.secret);

  // Destructured rather than compared as `claims.role === undefined`, which the
  // role-comparison guardrail flags — correctly, in the sense that it cannot
  // tell an authorization decision from a presence check, and would rather stop
  // both than miss one. The claim is carried, not evaluated: whether a role
  // grants anything is decided by can() from @taskflow/policy.
  const { orgId, role: roleClaim } = claims;

  const payload: JWTPayload = {
    sub: claims.userId,
    sid: claims.sessionId,
    auth_time: claims.authenticatedAt,
    ...(orgId === undefined ? {} : { org: orgId }),
    ...(roleClaim === undefined ? {} : { role: roleClaim }),
  };

  return new SignJWT(payload)
    .setProtectedHeader({ alg: ALGORITHM, typ: 'JWT' })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${String(ACCESS_TOKEN_TTL_SECONDS)}s`)
    .sign(config.secret);
}

/**
 * TOTP login challenge tokens (Phase 12 Wave 2 §3.2).
 *
 * Issued when `login()` verifies the password but the account also has a
 * confirmed TOTP credential — proof that the FIRST factor succeeded, good
 * for five minutes, redeemable exactly once at `auth.totp.verifyLogin`.
 *
 * A DIFFERENT audience than `AUDIENCE` above, deliberately — the one
 * property this token must never have is being accepted anywhere an access
 * token is, and `verifyAccessToken`'s own audience check already refuses
 * anything not signed for `'taskflow-api'`. Sharing the audience would mean
 * a bug in one verifier's caller could accept the other token type; a
 * distinct audience makes that a signature failure instead of a logic bug.
 */
const TOTP_CHALLENGE_AUDIENCE = 'taskflow-totp-challenge';
const TOTP_CHALLENGE_TTL_SECONDS = 300;

export interface TotpChallengeClaims {
  readonly userId: string;
}

export async function signTotpChallenge(
  claims: TotpChallengeClaims,
  config: JwtConfig,
): Promise<string> {
  assertSecret(config.secret);

  return new SignJWT({ sub: claims.userId })
    .setProtectedHeader({ alg: ALGORITHM, typ: 'JWT' })
    .setIssuer(ISSUER)
    .setAudience(TOTP_CHALLENGE_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${String(TOTP_CHALLENGE_TTL_SECONDS)}s`)
    .sign(config.secret);
}

export async function verifyTotpChallenge(
  token: string,
  config: JwtConfig,
): Promise<TotpChallengeClaims> {
  assertSecret(config.secret);

  try {
    const { payload } = await jwtVerify(token, config.secret, {
      issuer: ISSUER,
      audience: TOTP_CHALLENGE_AUDIENCE,
      algorithms: [ALGORITHM],
      clockTolerance: 5,
    });

    const userId = payload.sub;
    if (typeof userId !== 'string') throw new InvalidTokenError();

    return { userId };
  } catch {
    throw new InvalidTokenError();
  }
}

/**
 * OAuth authorization `state` tokens (Phase 12 Wave 2 §3.3).
 *
 * Signed rather than stored server-side — the state only has to survive one
 * redirect round trip to the provider and back, so a table (and its cleanup)
 * buys nothing a JWT doesn't already give for free. It carries the PKCE
 * `code_verifier` the callback needs to complete the exchange, which is why
 * it must not be guessable: unlike the TOTP challenge, this token is placed
 * directly in a URL query parameter the provider echoes back, so its own
 * signature — not secrecy of the value — is what stops a forged callback
 * from being accepted as a real one.
 *
 * A distinct audience for the same reason `TOTP_CHALLENGE_AUDIENCE` is
 * distinct from `AUDIENCE`: this must never be accepted as a bearer access
 * token even though both are signed with the same secret.
 */
const OAUTH_STATE_AUDIENCE = 'taskflow-oauth-state';
const OAUTH_STATE_TTL_SECONDS = 600;

export interface OAuthStateClaims {
  readonly provider: string;
  readonly codeVerifier: string;
  /** Set when linking a provider to an already signed-in account, rather than signing in fresh. */
  readonly linkUserId?: string;
  /**
   * Set when `start` was called from the native app. Carries the channel
   * through the redirect round trip — the state is the only thing that
   * survives it — so `callback` knows to exchange the code against the
   * NATIVE redirect URI/credentials and mint a body-delivered session
   * (ai/phase-14-mobile.md §4.4). Absent means browser, the same fail-safe
   * default `issueSession` callers use elsewhere: a forged or truncated
   * claim can only fall back to the cookie path, never forge native delivery.
   */
  readonly channel?: 'native';
  /**
   * S256 challenge for a verifier the CLIENT holds (ai/phase-14-mobile.md §4.4).
   *
   * Set by `auth.native.oauth.start`/`startLink` and required back at
   * `auth.native.oauth.callback`. Distinct from `codeVerifier` above, which
   * secures the server<->provider leg and never leaves this server — see
   * `verifyPkceChallenge`'s own header for why that one cannot defend a
   * custom-scheme redirect, and this one can. Not secret: a JWT payload is
   * signed, not encrypted, so an interceptor reads this exactly as it reads
   * the challenge in the authorization URL. Its preimage is the secret.
   */
  readonly clientChallenge?: string;
}

export async function signOAuthState(claims: OAuthStateClaims, config: JwtConfig): Promise<string> {
  assertSecret(config.secret);

  const { linkUserId, channel, clientChallenge } = claims;
  return new SignJWT({
    provider: claims.provider,
    verifier: claims.codeVerifier,
    ...(linkUserId === undefined ? {} : { link: linkUserId }),
    ...(channel === undefined ? {} : { channel }),
    ...(clientChallenge === undefined ? {} : { cc: clientChallenge }),
  })
    .setProtectedHeader({ alg: ALGORITHM, typ: 'JWT' })
    .setIssuer(ISSUER)
    .setAudience(OAUTH_STATE_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${String(OAUTH_STATE_TTL_SECONDS)}s`)
    .sign(config.secret);
}

export async function verifyOAuthState(
  token: string,
  config: JwtConfig,
): Promise<OAuthStateClaims> {
  assertSecret(config.secret);

  try {
    const { payload } = await jwtVerify(token, config.secret, {
      issuer: ISSUER,
      audience: OAUTH_STATE_AUDIENCE,
      algorithms: [ALGORITHM],
      clockTolerance: 5,
    });

    const { provider, verifier, link, channel, cc } = payload;
    if (typeof provider !== 'string' || typeof verifier !== 'string') {
      throw new InvalidTokenError();
    }
    if (link !== undefined && typeof link !== 'string') throw new InvalidTokenError();
    if (channel !== undefined && channel !== 'native') throw new InvalidTokenError();
    if (cc !== undefined && typeof cc !== 'string') throw new InvalidTokenError();

    return {
      provider,
      codeVerifier: verifier,
      ...(link === undefined ? {} : { linkUserId: link }),
      ...(channel === undefined ? {} : { channel }),
      ...(cc === undefined ? {} : { clientChallenge: cc }),
    };
  } catch {
    throw new InvalidTokenError();
  }
}

export class InvalidTokenError extends Error {
  constructor() {
    // One message for every failure. Expired, wrong audience, bad signature and
    // malformed must be indistinguishable to the caller — the differences are
    // useful only to someone probing the token format.
    super('Invalid or expired token.');
    this.name = 'InvalidTokenError';
  }
}

/**
 * Connector OAuth `state` tokens (Phase 10 Wave 4, ai/phase-10-automation.md
 * §7.2).
 *
 * The same shape and reasoning as `OAUTH_STATE_AUDIENCE` above, for a
 * different flow: a Slack/GitHub CONNECTOR connect, minted by
 * `integration.begin` (an org-scoped, `integration:manage`, step-up route)
 * and completed by `integration.complete` — a public route, because the
 * browser round trip to the provider loses the session.
 *
 * It carries the ORG and USER the flow was begun for, beside the PKCE
 * verifier. That is what lets the public complete route write the connector
 * row under the right org and attribute the connect to the right person
 * without a session — the same trust model as `linkUserId` in the login
 * flow's state: the state is signed by this API and minted only by an
 * authenticated, authorized actor, so the claims it carries are as trustworthy
 * as the session that created them.
 *
 * The AUDIENCE is distinct from `OAUTH_STATE_AUDIENCE`, for the same reason
 * that one is distinct from `AUDIENCE`: a connector state must never be
 * accepted as a login-OAuth state (whose `linkUserId` would sign a different
 * account into a session), and neither must be accepted as an access token.
 */
const CONNECTOR_STATE_AUDIENCE = 'taskflow-connector-state';
const CONNECTOR_STATE_TTL_SECONDS = 600;

export interface ConnectorStateClaims {
  readonly provider: string;
  readonly codeVerifier: string;
  /** The org the connector row will be written under — from the signed state, never from a request. */
  readonly orgId: string;
  /** Whose connect this is — the step-upped actor who called `integration.begin`. */
  readonly userId: string;
}

export async function signConnectorState(
  claims: ConnectorStateClaims,
  config: JwtConfig,
): Promise<string> {
  assertSecret(config.secret);

  return new SignJWT({
    provider: claims.provider,
    verifier: claims.codeVerifier,
    org: claims.orgId,
    uid: claims.userId,
  })
    .setProtectedHeader({ alg: ALGORITHM, typ: 'JWT' })
    .setIssuer(ISSUER)
    .setAudience(CONNECTOR_STATE_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${String(CONNECTOR_STATE_TTL_SECONDS)}s`)
    .sign(config.secret);
}

export async function verifyConnectorState(
  token: string,
  config: JwtConfig,
): Promise<ConnectorStateClaims> {
  assertSecret(config.secret);

  try {
    const { payload } = await jwtVerify(token, config.secret, {
      issuer: ISSUER,
      audience: CONNECTOR_STATE_AUDIENCE,
      algorithms: [ALGORITHM],
      clockTolerance: 5,
    });

    const { provider, verifier, org, uid } = payload;
    if (
      typeof provider !== 'string' ||
      typeof verifier !== 'string' ||
      typeof org !== 'string' ||
      typeof uid !== 'string'
    ) {
      throw new InvalidTokenError();
    }

    return { provider, codeVerifier: verifier, orgId: org, userId: uid };
  } catch {
    throw new InvalidTokenError();
  }
}

/**
 * Verifies an access token and returns its claims.
 *
 * Throws `InvalidTokenError` for everything. Note what is NOT checked here:
 * whether the session is still alive. A token remains cryptographically valid
 * until it expires, so revocation is enforced at refresh time and by the
 * ten-minute ceiling — pretending otherwise would mean a database read on every
 * request, which is the design this token exists to avoid.
 */
export async function verifyAccessToken(
  token: string,
  config: JwtConfig,
): Promise<AccessTokenClaims> {
  assertSecret(config.secret);

  try {
    const { payload } = await jwtVerify(token, config.secret, {
      issuer: ISSUER,
      audience: AUDIENCE,
      // Pinned. Without it, a token whose header says `alg: none` — or one
      // signed with a weaker algorithm the library also supports — is accepted,
      // which is the oldest JWT vulnerability there is.
      algorithms: [ALGORITHM],
      clockTolerance: 5,
    });

    const userId = payload.sub;
    const sessionId = payload['sid'];
    const authenticatedAt = payload['auth_time'];
    const orgId = payload['org'];
    const role = payload['role'];

    if (
      typeof userId !== 'string' ||
      typeof sessionId !== 'string' ||
      typeof authenticatedAt !== 'number'
    ) {
      throw new InvalidTokenError();
    }

    return {
      userId,
      sessionId,
      authenticatedAt,
      ...(typeof orgId === 'string' ? { orgId } : {}),
      ...(typeof role === 'string' ? { role } : {}),
    };
  } catch {
    throw new InvalidTokenError();
  }
}
