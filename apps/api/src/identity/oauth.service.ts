import { errors, unsafeAsId } from '@taskflow/contracts';
import { createEvent } from '@taskflow/events';
import {
  generatePkcePair,
  InvalidTokenError,
  newId,
  signOAuthState,
  verifyGoogleIdToken as verifyGoogleIdTokenReal,
  verifyOAuthState,
  type OAuthStateClaims,
} from '@taskflow/security';
import * as repo from './repository.js';
import { countCredentials } from './passkey.repository.js';
import * as identityEvents from './events.js';
import { SYSTEM_ORG, issueSession, type IdentityDeps, type TokenPair } from './identity.service.js';

/**
 * OAuth sign-in (Phase 12 Wave 2 §3.3, ai/phase-12-wave2.md).
 *
 * ⚠ HUMAN REVIEW SURFACE (§2.2) — a new way into an account, the same
 * severity class as password, passkey, and TOTP auth.
 *
 * Hand-rolled authorization-code flow with PKCE, not a library — the same
 * call PLAN.md §4.2 makes for password/passkey auth. Google issues an OIDC
 * ID token, independently verifiable against its published JWKS
 * (`@taskflow/security`'s `verifyGoogleIdToken`); GitHub issues no ID token,
 * so its identity comes from two plain REST calls with the exchanged access
 * token instead.
 *
 * ## The three outcomes of a callback
 *
 * A confirmed `oauth_identities` row already existing for `(provider,
 * providerUserId)` signs that account in directly. No existing link but a
 * verified-email match against `identity.users` AUTO-LINKS (§7's decision —
 * the provider has already done its own, independent verification, so this
 * is a second party vouching for the same fact `emailVerifiedAt` already
 * represents, not a weaker one). No match at all creates a fresh,
 * password-less account, verified immediately.
 *
 * A fourth path — `linkUserId` carried in the signed state — is "link a new
 * provider to the account I am already signed into", reached from account
 * settings rather than the login page; it never issues a session because the
 * caller already has one.
 */

export type OAuthProvider = 'google' | 'github';

export interface OAuthProviderCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
}

export interface OAuthDeps {
  readonly identity: IdentityDeps;
  /** Absent entry = that provider is not configured; its routes refuse rather than the app failing to boot. */
  readonly providers: Partial<Record<OAuthProvider, OAuthProviderCredentials>>;
  readonly redirectUri: (provider: OAuthProvider) => string;
  /** Injectable so tests never make a real network call. Defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Injectable so tests verify a real, locally-signed token instead of Google's real JWKS. */
  readonly verifyGoogleIdToken?: typeof verifyGoogleIdTokenReal;
}

const clock = (deps: OAuthDeps): Date => (deps.identity.now ?? (() => new Date()))();

function credentialsFor(deps: OAuthDeps, provider: OAuthProvider): OAuthProviderCredentials {
  const credentials = deps.providers[provider];
  if (!credentials) {
    throw errors.notFound(`OAuth sign-in with ${provider} is not configured on this server.`);
  }
  return credentials;
}

/**
 * `verifyOAuthState` throws a raw `InvalidTokenError`, not an `AppError` —
 * fine for a caller inside `@taskflow/security`'s own tests, wrong reaching
 * a tRPC route boundary uncaught: nothing there maps an arbitrary `Error` to
 * a client-facing code, so a expired or forged `state` (a stale bookmark, a
 * replayed callback, a tampered query string) would surface as an opaque
 * `INTERNAL_SERVER_ERROR` instead of the same `UNAUTHENTICATED` a bad
 * refresh token already gets.
 */
async function verifyState(state: string, secret: Uint8Array): Promise<OAuthStateClaims> {
  try {
    return await verifyOAuthState(state, { secret });
  } catch (error) {
    if (error instanceof InvalidTokenError) throw errors.unauthenticated();
    throw error;
  }
}

/* -------------------------------------------------------------------------- *
 * Start
 * -------------------------------------------------------------------------- */

export interface StartResult {
  readonly authorizationUrl: string;
}

export async function start(
  deps: OAuthDeps,
  input: { provider: OAuthProvider; linkUserId?: string },
): Promise<StartResult> {
  const credentials = credentialsFor(deps, input.provider);
  const { verifier, challenge } = generatePkcePair();

  const state = await signOAuthState(
    {
      provider: input.provider,
      codeVerifier: verifier,
      ...(input.linkUserId === undefined ? {} : { linkUserId: input.linkUserId }),
    },
    { secret: deps.identity.config.jwtSecret },
  );

  const redirectUri = deps.redirectUri(input.provider);
  const url =
    input.provider === 'google'
      ? googleAuthorizationUrl(credentials.clientId, redirectUri, state, challenge)
      : githubAuthorizationUrl(credentials.clientId, redirectUri, state);

  return { authorizationUrl: url.toString() };
}

function googleAuthorizationUrl(
  clientId: string,
  redirectUri: string,
  state: string,
  challenge: string,
): URL {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url;
}

function githubAuthorizationUrl(clientId: string, redirectUri: string, state: string): URL {
  // GitHub's OAuth apps do not support PKCE; the confidential client secret
  // exchanged in the callback (never exposed to the browser) is what stands
  // in for it, the same trust boundary a server-side web app already has.
  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', 'read:user user:email');
  url.searchParams.set('state', state);
  return url;
}

/* -------------------------------------------------------------------------- *
 * Callback
 * -------------------------------------------------------------------------- */

export type OAuthCallbackResult =
  | { readonly kind: 'session'; readonly pair: TokenPair }
  | { readonly kind: 'linked'; readonly provider: OAuthProvider };

export async function callback(
  deps: OAuthDeps,
  input: { provider: OAuthProvider; code: string; state: string },
  meta: { ip: string | null; userAgent: string | null },
): Promise<OAuthCallbackResult> {
  const credentials = credentialsFor(deps, input.provider);
  const state = await verifyState(input.state, deps.identity.config.jwtSecret);

  if (state.provider !== input.provider) {
    // The `state` was minted for a different provider than the callback URL
    // claims — either a copy-paste of a stale link or a forged callback.
    throw errors.validation({ state: 'This sign-in attempt does not match its provider.' });
  }

  const found = await resolveProviderIdentity(deps, input.provider, credentials, {
    code: input.code,
    codeVerifier: state.codeVerifier,
  });
  const now = clock(deps);

  if (state.linkUserId !== undefined) {
    return linkToExistingAccount(deps, state.linkUserId, input.provider, found, now);
  }
  return signInOrCreateAccount(deps, input.provider, found, now, meta);
}

interface ProviderIdentity {
  readonly subject: string;
  readonly email: string;
}

async function resolveProviderIdentity(
  deps: OAuthDeps,
  provider: OAuthProvider,
  credentials: OAuthProviderCredentials,
  code: { code: string; codeVerifier: string },
): Promise<ProviderIdentity> {
  return provider === 'google'
    ? resolveGoogleIdentity(deps, credentials, code)
    : resolveGithubIdentity(deps, credentials, code.code);
}

async function resolveGoogleIdentity(
  deps: OAuthDeps,
  credentials: OAuthProviderCredentials,
  code: { code: string; codeVerifier: string },
): Promise<ProviderIdentity> {
  const fetchFn = deps.fetchImpl ?? fetch;
  const response = await fetchFn('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code: code.code,
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      redirect_uri: deps.redirectUri('google'),
      grant_type: 'authorization_code',
      code_verifier: code.codeVerifier,
    }).toString(),
  });

  if (!response.ok) {
    throw errors.validation({ code: 'Google rejected the authorization code.' });
  }

  const body = (await response.json()) as { id_token?: unknown };
  if (typeof body.id_token !== 'string') {
    throw errors.validation({ code: 'Google did not return an ID token.' });
  }

  const verify = deps.verifyGoogleIdToken ?? verifyGoogleIdTokenReal;
  const { subject, email } = await verify(body.id_token, credentials.clientId);
  return { subject, email };
}

const GITHUB_HEADERS = { accept: 'application/vnd.github+json', 'user-agent': 'TaskFlow' };

async function resolveGithubIdentity(
  deps: OAuthDeps,
  credentials: OAuthProviderCredentials,
  code: string,
): Promise<ProviderIdentity> {
  const fetchFn = deps.fetchImpl ?? fetch;

  const tokenResponse = await fetchFn('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({
      code,
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      redirect_uri: deps.redirectUri('github'),
    }).toString(),
  });
  if (!tokenResponse.ok) {
    throw errors.validation({ code: 'GitHub rejected the authorization code.' });
  }

  const tokenBody = (await tokenResponse.json()) as { access_token?: unknown };
  if (typeof tokenBody.access_token !== 'string') {
    throw errors.validation({ code: 'GitHub did not return an access token.' });
  }

  const authHeaders = { ...GITHUB_HEADERS, authorization: `Bearer ${tokenBody.access_token}` };

  const userResponse = await fetchFn('https://api.github.com/user', { headers: authHeaders });
  if (!userResponse.ok) {
    throw errors.validation({ code: 'GitHub rejected the access token.' });
  }
  const user = (await userResponse.json()) as { id?: unknown };
  if (typeof user.id !== 'number') {
    throw errors.validation({ code: 'GitHub returned no user id.' });
  }

  // GitHub's `/user` response only carries a public email when the account
  // has one set; `/user/emails` is the one endpoint that reports which
  // address is both primary AND verified, which is the guarantee this flow
  // needs before it will trust the address at all.
  const emailsResponse = await fetchFn('https://api.github.com/user/emails', {
    headers: authHeaders,
  });
  if (!emailsResponse.ok) {
    throw errors.validation({ code: 'GitHub rejected the access token.' });
  }
  const emails = (await emailsResponse.json()) as {
    email: string;
    primary: boolean;
    verified: boolean;
  }[];
  const primary = emails.find((entry) => entry.primary && entry.verified);
  if (!primary) {
    throw errors.validation({
      email: 'GitHub reports no verified primary email for this account.',
    });
  }

  return { subject: String(user.id), email: primary.email };
}

/* -------------------------------------------------------------------------- *
 * Outcomes
 * -------------------------------------------------------------------------- */

async function linkToExistingAccount(
  deps: OAuthDeps,
  userId: string,
  provider: OAuthProvider,
  found: ProviderIdentity,
  now: Date,
): Promise<OAuthCallbackResult> {
  const existing = await repo.findOAuthIdentity(provider, found.subject);
  if (existing && existing.userId !== userId) {
    throw errors.conflict('This provider account is already linked to a different account.');
  }

  if (!existing) {
    const linked = await repo.linkOAuthIdentity({
      id: newId<'unused'>(),
      userId,
      provider,
      providerUserId: found.subject,
      email: found.email,
    });
    if (!linked) {
      // Lost a race with a concurrent link, or this account already has a
      // link for this provider under a different provider identity.
      throw errors.conflict(
        'This account already has a linked provider identity for this service.',
      );
    }

    await deps.identity.events.publish([
      createEvent(
        identityEvents.oauthLinked,
        { userId, provider },
        { orgId: SYSTEM_ORG, actorId: unsafeAsId<'UserId'>(userId), occurredAt: now },
      ),
    ]);
  }

  return { kind: 'linked', provider };
}

async function signInOrCreateAccount(
  deps: OAuthDeps,
  provider: OAuthProvider,
  found: ProviderIdentity,
  now: Date,
  meta: { ip: string | null; userAgent: string | null },
): Promise<OAuthCallbackResult> {
  const existingLink = await repo.findOAuthIdentity(provider, found.subject);
  if (existingLink) {
    return sessionFor(deps, existingLink.userId, provider, now, meta);
  }

  const existingUser = await repo.findUserByEmail(found.email);
  if (existingUser) {
    const linked = await repo.linkOAuthIdentity({
      id: newId<'unused'>(),
      userId: existingUser.id,
      provider,
      providerUserId: found.subject,
      email: found.email,
    });
    // A lost race (someone else linked this exact provider identity a moment
    // ago) is not fatal here — the account is the same either way, so
    // sign-in proceeds; only the event is skipped for the loser.
    if (linked) {
      await deps.identity.events.publish([
        createEvent(
          identityEvents.oauthLinked,
          { userId: existingUser.id, provider },
          { orgId: SYSTEM_ORG, actorId: unsafeAsId<'UserId'>(existingUser.id), occurredAt: now },
        ),
      ]);
    }
    return sessionFor(deps, existingUser.id, provider, now, meta);
  }

  const userId = newId<'UserId'>();
  const created = await repo.createOAuthUserAndLink({
    userId,
    email: found.email,
    now,
    linkId: newId<'unused'>(),
    provider,
    providerUserId: found.subject,
  });

  if (!created) {
    // Someone else created this exact account (by email) between the read
    // above and this write — a genuine race, not an error condition. The
    // account now exists; sign in as it rather than fail a legitimate
    // attempt over unlucky timing.
    const raceWinner = await repo.findUserByEmail(found.email);
    if (!raceWinner) throw errors.conflict('Could not complete sign-in. Try again.');
    return sessionFor(deps, raceWinner.id, provider, now, meta);
  }

  await deps.identity.events.publish([
    createEvent(
      identityEvents.userRegistered,
      { userId, email: found.email },
      { orgId: SYSTEM_ORG, actorId: null, occurredAt: now },
    ),
    createEvent(
      identityEvents.oauthLinked,
      { userId, provider },
      { orgId: SYSTEM_ORG, actorId: unsafeAsId<'UserId'>(userId), occurredAt: now },
    ),
  ]);

  return sessionFor(deps, userId, provider, now, meta);
}

async function sessionFor(
  deps: OAuthDeps,
  userId: string,
  provider: OAuthProvider,
  now: Date,
  meta: { ip: string | null; userAgent: string | null },
): Promise<OAuthCallbackResult> {
  const user = await repo.findUserById(userId);
  if (user?.status !== 'active') {
    // Same answer a suspended/locked account gets from password login — an
    // OAuth-verified email is not a reason to let a suspension through.
    throw errors.invalidCredentials();
  }

  const pair = await issueSession(deps.identity, userId, now, now, meta);

  await deps.identity.events.publish([
    createEvent(
      identityEvents.userLoggedIn,
      {
        userId,
        sessionId: pair.sessionId,
        method: 'oauth' as const,
        ip: meta.ip,
        userAgent: meta.userAgent,
      },
      { orgId: SYSTEM_ORG, actorId: null, occurredAt: now },
    ),
  ]);
  await repo.clearLoginFailures(userId, now);

  return { kind: 'session', pair };
}

/* -------------------------------------------------------------------------- *
 * Account settings — connected accounts
 * -------------------------------------------------------------------------- */

export interface ConnectedAccount {
  readonly provider: OAuthProvider;
  readonly email: string;
  readonly linkedAt: Date;
}

export async function listConnected(userId: string): Promise<readonly ConnectedAccount[]> {
  const rows = await repo.listOAuthIdentities(userId);
  return rows.map((row) => ({
    provider: row.provider as OAuthProvider,
    email: row.email,
    linkedAt: row.linkedAt,
  }));
}

/**
 * Removes a linked provider, unless it is the last way in — the same
 * "not locking someone out of their own account" check `passkey.service.ts`'s
 * `deletePasskey` already makes, generalized across all three methods.
 */
export async function unlink(
  deps: OAuthDeps,
  input: { userId: string; provider: OAuthProvider },
): Promise<{ status: 'unlinked' }> {
  const now = clock(deps);
  const user = await repo.findUserById(input.userId);
  if (!user) throw errors.notFound('Account not found.');

  const [passkeyCount, oauthCount] = await Promise.all([
    countCredentials(input.userId),
    repo.countOAuthIdentities(input.userId),
  ]);

  if (user.passwordHash === null && passkeyCount === 0 && oauthCount <= 1) {
    throw errors.validation({
      provider:
        'This is the only way to sign in to this account. Add a password or a passkey first.',
    });
  }

  const removed = await repo.unlinkOAuthIdentity(input.userId, input.provider);
  if (!removed) throw errors.notFound('That provider is not linked to this account.');

  await deps.identity.events.publish([
    createEvent(
      identityEvents.oauthUnlinked,
      { userId: input.userId, provider: input.provider },
      { orgId: SYSTEM_ORG, actorId: unsafeAsId<'UserId'>(input.userId), occurredAt: now },
    ),
  ]);

  return { status: 'unlinked' };
}
