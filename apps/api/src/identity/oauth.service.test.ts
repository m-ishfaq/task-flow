import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  closeDatabase,
  initializeDatabase,
  initializePlatformAdminDatabase,
  sql,
  withGlobalScope,
} from '@taskflow/db';
import { up } from '@taskflow/db/migrate';
import { RecordingEventBus } from '@taskflow/events';
import { errors, isAppError } from '@taskflow/contracts';
import { generatePkcePair, signOAuthState } from '@taskflow/security';
import * as identity from './identity.service.js';
import * as repo from './repository.js';
import * as oauth from './oauth.service.js';
import type { IdentityDeps } from './identity.service.js';
import type { OAuthDeps, OAuthProvider } from './oauth.service.js';
import { TEST_JWT_PRIVATE_KEY } from '../testing/fixtures.js';

/**
 * OAuth sign-in, against real Postgres (Phase 12 Wave 2 §3.3) — same
 * discipline as `identity.service.test.ts`: a duplicate-email auto-link is a
 * database behaviour (the unique index deciding who wins a race), not
 * something a mock can demonstrate.
 *
 * `fetchImpl` and `verifyGoogleIdToken` are stubbed rather than real — the
 * signature/JWKS half of Google's ID token is already proven for real in
 * `@taskflow/security/src/oauth.test.ts`; what matters HERE is everything a
 * library or a crypto test cannot show: which account a callback resolves
 * to, and under what conditions it creates one, links one, or refuses.
 *
 * ⚠ These cover a HUMAN REVIEW SURFACE (§2.2).
 */

const APP_URL =
  process.env['TEST_DATABASE_URL'] ??
  'postgresql://taskflow_app:app-dev-secret@localhost:5433/taskflow_test';
const MIGRATION_URL =
  process.env['TEST_DATABASE_MIGRATION_URL'] ??
  'postgresql://taskflow_migrator:migrator-dev-secret@localhost:5433/taskflow_test';

const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'packages',
  'db',
  'migrations',
);

const JWT_STATE_SECRET = new Uint8Array(Buffer.alloc(32, 7));
const PASSWORD = 'correct horse battery staple 42';

let events: RecordingEventBus;

function identityDeps(): IdentityDeps {
  return {
    config: {
      jwtPrivateKey: TEST_JWT_PRIVATE_KEY,
      jwtStateSecret: JWT_STATE_SECRET,
      refreshTokenTtlMs: 30 * 24 * 60 * 60 * 1000,
      verificationTtlMs: 24 * 60 * 60 * 1000,
      passwordResetTtlMs: 60 * 60 * 1000,
      lockThreshold: 3,
      lockDurationMs: 15 * 60 * 1000,
      onBreachCheckUnavailable: 'allow',
    },
    events,
    checkBreached: () => Promise.resolve({ status: 'ok' as const }),
    deliver: () => Promise.resolve(),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type FetchInput = Parameters<typeof fetch>[0];

/** Extracts the URL string from whatever shape `fetch`'s first argument takes. */
function urlOf(input: FetchInput): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** A fetch stub that answers Google's token endpoint with an id_token carrying the given claims verbatim. */
function fakeGoogleFetch(claims: { subject: string; email: string }): typeof fetch {
  return (input: FetchInput): Promise<Response> => {
    const href = urlOf(input);
    if (href === 'https://oauth2.googleapis.com/token') {
      return Promise.resolve(jsonResponse({ id_token: JSON.stringify(claims) }));
    }
    throw new Error(`oauth.service.test.ts: unexpected fetch to ${href}`);
  };
}

/** Round-trips whatever the fake token endpoint embedded, standing in for real JWKS verification. */
function fakeVerifyGoogleIdToken(idToken: string): Promise<{ subject: string; email: string }> {
  return Promise.resolve(JSON.parse(idToken) as { subject: string; email: string });
}

function fakeGithubFetch(profile: {
  id: number;
  email: string;
  primary?: boolean;
  verified?: boolean;
}): typeof fetch {
  return (input: FetchInput): Promise<Response> => {
    const href = urlOf(input);
    if (href === 'https://github.com/login/oauth/access_token') {
      return Promise.resolve(jsonResponse({ access_token: 'gh-token-xyz' }));
    }
    if (href === 'https://api.github.com/user') {
      return Promise.resolve(jsonResponse({ id: profile.id }));
    }
    if (href === 'https://api.github.com/user/emails') {
      return Promise.resolve(
        jsonResponse([
          {
            email: profile.email,
            primary: profile.primary ?? true,
            verified: profile.verified ?? true,
          },
        ]),
      );
    }
    throw new Error(`oauth.service.test.ts: unexpected fetch to ${href}`);
  };
}

/** Native credentials are a SEPARATE map from `providers` — opt in per test, not a fixed default. */
function googleDeps(
  claims: { subject: string; email: string },
  nativeProviders: OAuthDeps['nativeProviders'] = {},
): OAuthDeps {
  return {
    identity: identityDeps(),
    providers: {
      google: { clientId: 'google-client', clientSecret: 'google-secret' },
    },
    nativeProviders,
    redirectUri: (provider: OAuthProvider, channel) =>
      channel === 'native'
        ? 'taskflow://oauth-callback'
        : `https://app.test/oauth/callback/${provider}`,
    fetchImpl: fakeGoogleFetch(claims),
    verifyGoogleIdToken: fakeVerifyGoogleIdToken,
  };
}

function githubDeps(
  profile: { id: number; email: string; primary?: boolean; verified?: boolean },
  nativeProviders: OAuthDeps['nativeProviders'] = {},
): OAuthDeps {
  return {
    identity: identityDeps(),
    providers: {
      github: { clientId: 'github-client', clientSecret: 'github-secret' },
    },
    nativeProviders,
    redirectUri: (provider: OAuthProvider, channel) =>
      channel === 'native'
        ? 'taskflow://oauth-callback'
        : `https://app.test/oauth/callback/${provider}`,
    fetchImpl: fakeGithubFetch(profile),
  };
}

const meta = { ip: '203.0.113.5', userAgent: 'vitest' };

function codeOf(error: unknown): string {
  return isAppError(error) ? error.code : `not an AppError: ${String(error)}`;
}

async function codeOfRejection(promise: Promise<unknown>): Promise<string> {
  return promise.then(
    () => 'no error',
    (error: unknown) => codeOf(error),
  );
}

/** The code a cross-channel refresh refusal surfaces as (channel-binding.test.ts's own constant). */
const REFUSED = codeOf(errors.tokenExpired());

/** Registers and verifies a password account, returning its id and email. */
async function registeredUser(email: string): Promise<string> {
  const deps = identityDeps();
  await identity.register(deps, { email, password: PASSWORD }, meta);
  const user = await repo.findUserByEmail(email);
  if (!user) throw new Error('registeredUser: no such user after register()');
  await withGlobalScope(async (tx) => {
    await tx.execute(sql`
      UPDATE identity.users SET email_verified_at = now() WHERE id = ${user.id}
    `);
  });
  return user.id;
}

beforeAll(async () => {
  await up({ migrationUrl: MIGRATION_URL, migrationsDir: MIGRATIONS_DIR });
  initializeDatabase({ url: APP_URL, applicationName: 'oauth-test' });
  initializePlatformAdminDatabase({
    url:
      process.env['TEST_DATABASE_PLATFORM_ADMIN_URL'] ??
      'postgresql://taskflow_platform_admin:platform-admin-dev-secret@localhost:5433/taskflow_test',
    applicationName: 'oauth-test-admin',
  });
}, 60_000);

afterAll(async () => {
  await closeDatabase();
});

beforeEach(async () => {
  events = new RecordingEventBus();

  await withGlobalScope(async (tx) => {
    await tx.execute(sql`
      DELETE FROM identity.users
      WHERE email_normalized LIKE 'oauth-%@example.test'
    `);
  });
});

describe('callback — fresh sign-in, no existing account', () => {
  it('creates a password-less account, links it, and signs in', async () => {
    const deps = googleDeps({ subject: 'google-sub-1', email: 'oauth-new@example.test' });
    const state = await signOAuthState(
      { provider: 'google', codeVerifier: 'v' },
      { secret: JWT_STATE_SECRET },
    );

    const result = await oauth.callback(
      deps,
      { provider: 'google', code: 'auth-code', state },
      meta,
    );

    expect(result.kind).toBe('session');
    const user = await repo.findUserByEmail('oauth-new@example.test');
    expect(user).toBeTruthy();
    expect(user?.passwordHash).toBeNull();
    expect(user?.emailVerifiedAt).toBeTruthy();

    const links = await repo.listOAuthIdentities(user?.id ?? '');
    expect(links).toHaveLength(1);
    expect(links[0]?.provider).toBe('google');
    expect(links[0]?.providerUserId).toBe('google-sub-1');

    expect(events.names()).toEqual(['user.registered', 'user.oauth_linked', 'user.logged_in']);
  });
});

describe('callback — auto-link on verified email match', () => {
  it('links to an existing password account and signs in, with no new-account event', async () => {
    const userId = await registeredUser('oauth-existing@example.test');
    events.events.length = 0;

    const deps = googleDeps({ subject: 'google-sub-2', email: 'oauth-existing@example.test' });
    const state = await signOAuthState(
      { provider: 'google', codeVerifier: 'v' },
      { secret: JWT_STATE_SECRET },
    );

    const result = await oauth.callback(
      deps,
      { provider: 'google', code: 'auth-code', state },
      meta,
    );

    expect(result.kind).toBe('session');
    const links = await repo.listOAuthIdentities(userId);
    expect(links).toHaveLength(1);
    expect(events.names()).toEqual(['user.oauth_linked', 'user.logged_in']);
  });
});

describe('callback — existing linked identity', () => {
  it('signs in directly, with no link event at all', async () => {
    const deps1 = googleDeps({ subject: 'google-sub-3', email: 'oauth-repeat@example.test' });
    const state1 = await signOAuthState(
      { provider: 'google', codeVerifier: 'v' },
      { secret: JWT_STATE_SECRET },
    );
    await oauth.callback(deps1, { provider: 'google', code: 'c1', state: state1 }, meta);

    events.events.length = 0;
    const deps2 = googleDeps({ subject: 'google-sub-3', email: 'oauth-repeat@example.test' });
    const state2 = await signOAuthState(
      { provider: 'google', codeVerifier: 'v' },
      { secret: JWT_STATE_SECRET },
    );
    const result = await oauth.callback(
      deps2,
      { provider: 'google', code: 'c2', state: state2 },
      meta,
    );

    expect(result.kind).toBe('session');
    expect(events.names()).toEqual(['user.logged_in']);
  });

  it('refuses a suspended account', async () => {
    const deps1 = googleDeps({ subject: 'google-sub-4', email: 'oauth-suspend@example.test' });
    const state1 = await signOAuthState(
      { provider: 'google', codeVerifier: 'v' },
      { secret: JWT_STATE_SECRET },
    );
    await oauth.callback(deps1, { provider: 'google', code: 'c1', state: state1 }, meta);

    const user = await repo.findUserByEmail('oauth-suspend@example.test');
    await withGlobalScope(async (tx) => {
      await tx.execute(sql`UPDATE identity.users SET status = 'suspended' WHERE id = ${user?.id}`);
    });

    const deps2 = googleDeps({ subject: 'google-sub-4', email: 'oauth-suspend@example.test' });
    const state2 = await signOAuthState(
      { provider: 'google', codeVerifier: 'v' },
      { secret: JWT_STATE_SECRET },
    );

    const errorCode = await codeOfRejection(
      oauth.callback(deps2, { provider: 'google', code: 'c2', state: state2 }, meta),
    );
    expect(errorCode).toBe('INVALID_CREDENTIALS');
  });
});

describe('callback — GitHub', () => {
  it('uses the verified primary email', async () => {
    const deps = githubDeps({ id: 555, email: 'oauth-gh@example.test' });
    const state = await signOAuthState(
      { provider: 'github', codeVerifier: 'v' },
      { secret: JWT_STATE_SECRET },
    );

    const result = await oauth.callback(deps, { provider: 'github', code: 'c', state }, meta);

    expect(result.kind).toBe('session');
    const user = await repo.findUserByEmail('oauth-gh@example.test');
    const links = await repo.listOAuthIdentities(user?.id ?? '');
    expect(links[0]?.providerUserId).toBe('555');
  });

  it('refuses when no email is both primary and verified', async () => {
    const deps = githubDeps({ id: 556, email: 'oauth-gh2@example.test', verified: false });
    const state = await signOAuthState(
      { provider: 'github', codeVerifier: 'v' },
      { secret: JWT_STATE_SECRET },
    );

    const errorCode = await codeOfRejection(
      oauth.callback(deps, { provider: 'github', code: 'c', state }, meta),
    );
    expect(errorCode).toBe('VALIDATION_FAILED');
  });
});

describe('callback — state integrity', () => {
  it('refuses a state signed for a different provider', async () => {
    const deps = googleDeps({ subject: 'google-sub-9', email: 'oauth-mismatch@example.test' });
    const state = await signOAuthState(
      { provider: 'github', codeVerifier: 'v' },
      { secret: JWT_STATE_SECRET },
    );

    const errorCode = await codeOfRejection(
      oauth.callback(deps, { provider: 'google', code: 'c', state }, meta),
    );
    expect(errorCode).toBe('VALIDATION_FAILED');
  });

  it('refuses a state signed with a different secret', async () => {
    const deps = googleDeps({ subject: 'google-sub-10', email: 'oauth-forged@example.test' });
    const state = await signOAuthState(
      { provider: 'google', codeVerifier: 'v' },
      { secret: new Uint8Array(Buffer.alloc(32, 9)) },
    );

    const errorCode = await codeOfRejection(
      oauth.callback(deps, { provider: 'google', code: 'c', state }, meta),
    );
    expect(errorCode).toBe('UNAUTHENTICATED');
  });
});

describe('start', () => {
  it('refuses an unconfigured provider', async () => {
    const deps: OAuthDeps = {
      identity: identityDeps(),
      providers: {},
      nativeProviders: {},
      redirectUri: (provider) => `https://app.test/oauth/callback/${provider}`,
    };

    const errorCode = await codeOfRejection(oauth.start(deps, { provider: 'google' }));
    expect(errorCode).toBe('NOT_FOUND');
  });

  it('builds a Google authorization URL carrying PKCE and state', async () => {
    const deps = googleDeps({ subject: 'unused', email: 'unused@example.test' });
    const { authorizationUrl } = await oauth.start(deps, { provider: 'google' });
    const url = new URL(authorizationUrl);

    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe('google-client');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBeTruthy();
  });
});

describe('native channel — the client-held PKCE binding (§4.4)', () => {
  /* The native redirect lands on a plain custom scheme that, on Android, any
     installed app may also register an intent filter for, and
     `auth.native.oauth.callback` is public by necessity — there is no session
     yet. These prove that holding a genuine `(code, state)` is NOT enough. */

  /** Deps whose fetch fails the test if the provider is reached at all. */
  function unreachableProviderDeps(): OAuthDeps {
    return {
      identity: identityDeps(),
      providers: { google: { clientId: 'google-client', clientSecret: 'google-secret' } },
      nativeProviders: { google: { clientId: 'google-native-client' } },
      redirectUri: () => 'taskflow://oauth-callback',
      fetchImpl: (): Promise<Response> => {
        throw new Error('the provider must never be reached on a refused binding');
      },
      verifyGoogleIdToken: fakeVerifyGoogleIdToken,
    };
  }

  it('refuses an intercepted (code, state) presented with NO verifier', async () => {
    /* The attack in full: another app received the redirect, so it holds
       everything that crossed the wire. It still cannot redeem it.

       The assertion that matters most is not the refusal — it is that the
       code was never exchanged. A refusal issued AFTER burning the victim's
       code would read correctly in a diff and still have sent a token request
       to the provider on an attacker's behalf; `unreachableProviderDeps`
       throws if that happens, the same shape `spend-gate.test.ts` uses to
       prove its own gate runs before the provider is reached. */
    const { challenge } = generatePkcePair();
    const state = await signOAuthState(
      { provider: 'google', codeVerifier: 'v', channel: 'native', clientChallenge: challenge },
      { secret: JWT_STATE_SECRET },
    );

    expect(
      await codeOfRejection(
        oauth.callback(
          unreachableProviderDeps(),
          { provider: 'google', code: 'stolen', state },
          meta,
        ),
      ),
    ).toBe('VALIDATION_FAILED');
  });

  it('refuses a verifier that does not match the challenge', async () => {
    const { challenge } = generatePkcePair();
    const other = generatePkcePair();
    const state = await signOAuthState(
      { provider: 'google', codeVerifier: 'v', channel: 'native', clientChallenge: challenge },
      { secret: JWT_STATE_SECRET },
    );

    expect(
      await codeOfRejection(
        oauth.callback(
          unreachableProviderDeps(),
          { provider: 'google', code: 'stolen', state, clientVerifier: other.verifier },
          meta,
        ),
      ),
    ).toBe('VALIDATION_FAILED');
  });

  it('refuses a NATIVE state carrying no challenge at all — the downgrade path', async () => {
    /* Without this branch the control is opt-out: strip the claim and the old
       unbound behaviour comes back. A native state with no binding is refused
       outright rather than falling through to it. */
    const state = await signOAuthState(
      { provider: 'google', codeVerifier: 'v', channel: 'native' },
      { secret: JWT_STATE_SECRET },
    );

    expect(
      await codeOfRejection(
        oauth.callback(unreachableProviderDeps(), { provider: 'google', code: 'c', state }, meta),
      ),
    ).toBe('VALIDATION_FAILED');
  });

  it('refuses to START a native flow with no challenge, so an unbound state cannot be minted', async () => {
    const deps = googleDeps(
      { subject: 'unused', email: 'unused@example.test' },
      { google: { clientId: 'google-native-client' } },
    );

    expect(
      await codeOfRejection(oauth.start(deps, { provider: 'google', channel: 'native' })),
    ).toBe('VALIDATION_FAILED');
  });

  it('leaves the BROWSER flow unbound — its redirect is an https origin no app can claim', async () => {
    const deps = googleDeps({
      subject: 'google-sub-browser-unbound',
      email: 'oauth-browser-unbound@example.test',
    });
    const state = await signOAuthState(
      { provider: 'google', codeVerifier: 'v' },
      { secret: JWT_STATE_SECRET },
    );

    const result = await oauth.callback(deps, { provider: 'google', code: 'c', state }, meta);
    expect(result.kind).toBe('session');
  });
});

describe('native channel', () => {
  it('mints a session bound to the native channel, not the browser one', async () => {
    const deps = googleDeps(
      { subject: 'google-sub-native-1', email: 'oauth-native-1@example.test' },
      { google: { clientId: 'google-native-client' } },
    );
    const { verifier, challenge } = generatePkcePair();
    const state = await signOAuthState(
      { provider: 'google', codeVerifier: 'v', channel: 'native', clientChallenge: challenge },
      { secret: JWT_STATE_SECRET },
    );

    const result = await oauth.callback(
      deps,
      { provider: 'google', code: 'c', state, clientVerifier: verifier },
      meta,
    );
    if (result.kind !== 'session') throw new Error('expected a session, got a link result');

    // Bound to 'native' (migration 0080): refused on the browser refresh
    // route, and the refusal does not revoke it — accepted on its own route.
    expect(
      await codeOfRejection(
        identity.refresh(
          identityDeps(),
          { refreshToken: result.pair.refreshToken },
          meta,
          'browser',
        ),
      ),
    ).toBe(REFUSED);
    const next = await identity.refresh(
      identityDeps(),
      { refreshToken: result.pair.refreshToken },
      meta,
      'native',
    );
    expect(next.refreshToken).not.toBe(result.pair.refreshToken);
  });

  it('omits client_secret from the Google token exchange when the native client has none', async () => {
    let sawSecret = false;
    const fetchImpl: typeof fetch = (input, init) => {
      const href = urlOf(input);
      if (href !== 'https://oauth2.googleapis.com/token') {
        throw new Error(`oauth.service.test.ts: unexpected fetch to ${href}`);
      }
      const body = typeof init?.body === 'string' ? init.body : '';
      sawSecret = new URLSearchParams(body).has('client_secret');
      return Promise.resolve(
        jsonResponse({
          id_token: JSON.stringify({
            subject: 'google-sub-native-3',
            email: 'oauth-native-3@example.test',
          }),
        }),
      );
    };
    const deps: OAuthDeps = {
      identity: identityDeps(),
      providers: { google: { clientId: 'google-client', clientSecret: 'google-secret' } },
      nativeProviders: { google: { clientId: 'google-native-client' } },
      redirectUri: (provider, channel) =>
        channel === 'native'
          ? 'taskflow://oauth-callback'
          : `https://app.test/oauth/callback/${provider}`,
      fetchImpl,
      verifyGoogleIdToken: fakeVerifyGoogleIdToken,
    };
    const { verifier, challenge } = generatePkcePair();
    const state = await signOAuthState(
      { provider: 'google', codeVerifier: 'v', channel: 'native', clientChallenge: challenge },
      { secret: JWT_STATE_SECRET },
    );

    const result = await oauth.callback(
      deps,
      { provider: 'google', code: 'c', state, clientVerifier: verifier },
      meta,
    );
    expect(result.kind).toBe('session');
    expect(sawSecret).toBe(false);
  });

  it('refuses native sign-in for a provider with no native credentials, even with a browser pair configured', async () => {
    const deps = googleDeps({ subject: 'unused', email: 'unused@example.test' });
    const state = await signOAuthState(
      { provider: 'google', codeVerifier: 'v', channel: 'native' },
      { secret: JWT_STATE_SECRET },
    );

    const errorCode = await codeOfRejection(
      oauth.callback(deps, { provider: 'google', code: 'c', state }, meta),
    );
    expect(errorCode).toBe('NOT_FOUND');
  });

  it('refuses a native GitHub exchange when the native app has no secret configured', async () => {
    const deps = githubDeps(
      { id: 999, email: 'oauth-native-gh@example.test' },
      { github: { clientId: 'github-native-client-no-secret' } },
    );
    const { verifier, challenge } = generatePkcePair();
    const state = await signOAuthState(
      { provider: 'github', codeVerifier: 'v', channel: 'native', clientChallenge: challenge },
      { secret: JWT_STATE_SECRET },
    );

    const errorCode = await codeOfRejection(
      oauth.callback(
        deps,
        { provider: 'github', code: 'c', state, clientVerifier: verifier },
        meta,
      ),
    );
    expect(errorCode).toBe('NOT_FOUND');
  });

  it('start signs a state carrying the native channel and uses the native redirect and credentials', async () => {
    const deps = googleDeps(
      { subject: 'unused', email: 'unused@example.test' },
      { google: { clientId: 'google-native-client' } },
    );

    const { authorizationUrl } = await oauth.start(deps, {
      provider: 'google',
      channel: 'native',
      clientChallenge: generatePkcePair().challenge,
    });
    const url = new URL(authorizationUrl);
    expect(url.searchParams.get('client_id')).toBe('google-native-client');
    expect(url.searchParams.get('redirect_uri')).toBe('taskflow://oauth-callback');
  });
});

describe('linking to an existing session', () => {
  it('links without issuing a new session', async () => {
    const userId = await registeredUser('oauth-linker@example.test');
    events.events.length = 0;

    const state = await signOAuthState(
      { provider: 'google', codeVerifier: 'v', linkUserId: userId },
      { secret: JWT_STATE_SECRET },
    );
    const deps = googleDeps({ subject: 'google-sub-link', email: 'someone-else@example.test' });

    const result = await oauth.callback(deps, { provider: 'google', code: 'c', state }, meta);

    expect(result).toEqual({ kind: 'linked', provider: 'google' });
    const links = await repo.listOAuthIdentities(userId);
    expect(links).toHaveLength(1);
    expect(events.names()).toEqual(['user.oauth_linked']);
  });

  /**
   * `auth.native.oauth.startLink` (added alongside this test) wires no new
   * SERVICE logic — `start` already accepted `{ linkUserId, channel }`
   * together, and `callback`'s `kind: 'linked'` branch is shared by both
   * channels regardless. What was never exercised end-to-end is a `start`
   * that carries BOTH at once, the exact combination the new route calls.
   */
  it('links over the native channel, using native credentials and redirect', async () => {
    const userId = await registeredUser('oauth-linker-native@example.test');
    events.events.length = 0;

    const deps = googleDeps(
      { subject: 'google-sub-native-link', email: 'someone-else-native@example.test' },
      { google: { clientId: 'google-native-client' } },
    );

    const { verifier, challenge } = generatePkcePair();
    const { authorizationUrl } = await oauth.start(deps, {
      provider: 'google',
      linkUserId: userId,
      channel: 'native',
      clientChallenge: challenge,
    });
    const url = new URL(authorizationUrl);
    expect(url.searchParams.get('client_id')).toBe('google-native-client');
    expect(url.searchParams.get('redirect_uri')).toBe('taskflow://oauth-callback');
    const state = url.searchParams.get('state');
    if (state === null) throw new Error('expected a state param');

    const result = await oauth.callback(
      deps,
      { provider: 'google', code: 'c', state, clientVerifier: verifier },
      meta,
    );

    expect(result).toEqual({ kind: 'linked', provider: 'google' });
    expect(await repo.listOAuthIdentities(userId)).toHaveLength(1);
    expect(events.names()).toEqual(['user.oauth_linked']);
  });

  it('refuses linking a provider identity already linked elsewhere', async () => {
    const victim = await registeredUser('oauth-victim@example.test');
    const attacker = await registeredUser('oauth-attacker@example.test');

    const victimState = await signOAuthState(
      { provider: 'google', codeVerifier: 'v', linkUserId: victim },
      { secret: JWT_STATE_SECRET },
    );
    await oauth.callback(
      googleDeps({ subject: 'google-sub-shared', email: 'victim-google@example.test' }),
      { provider: 'google', code: 'c1', state: victimState },
      meta,
    );

    const attackerState = await signOAuthState(
      { provider: 'google', codeVerifier: 'v', linkUserId: attacker },
      { secret: JWT_STATE_SECRET },
    );
    const errorCode = await codeOfRejection(
      oauth.callback(
        googleDeps({ subject: 'google-sub-shared', email: 'attacker-google@example.test' }),
        { provider: 'google', code: 'c2', state: attackerState },
        meta,
      ),
    );

    expect(errorCode).toBe('CONFLICT');
  });
});

describe('unlink', () => {
  it('refuses to remove the last way in', async () => {
    const userId = await registeredUser('oauth-lastmethod@example.test');
    const state = await signOAuthState(
      { provider: 'google', codeVerifier: 'v', linkUserId: userId },
      { secret: JWT_STATE_SECRET },
    );
    await oauth.callback(
      googleDeps({ subject: 'google-sub-only', email: 'irrelevant@example.test' }),
      { provider: 'google', code: 'c', state },
      meta,
    );

    // A password-registered account still has its password, so unlinking its
    // only OAuth provider must succeed — this asserts the refusal path
    // separately, against an account with NO password at all.
    const passwordless = await withGlobalScope(async (tx) => {
      await tx.execute(sql`UPDATE identity.users SET password_hash = NULL WHERE id = ${userId}`);
      return userId;
    });

    const errorCode = await codeOfRejection(
      oauth.unlink(googleDeps({ subject: 'unused', email: 'unused@example.test' }), {
        userId: passwordless,
        provider: 'google',
      }),
    );
    expect(errorCode).toBe('VALIDATION_FAILED');
  });

  it('removes a provider that is not the last way in, and emits an event', async () => {
    const userId = await registeredUser('oauth-unlink@example.test');
    const state = await signOAuthState(
      { provider: 'google', codeVerifier: 'v', linkUserId: userId },
      { secret: JWT_STATE_SECRET },
    );
    await oauth.callback(
      googleDeps({ subject: 'google-sub-unlink', email: 'irrelevant@example.test' }),
      { provider: 'google', code: 'c', state },
      meta,
    );
    events.events.length = 0;

    const result = await oauth.unlink(
      googleDeps({ subject: 'unused', email: 'unused@example.test' }),
      { userId, provider: 'google' },
    );

    expect(result).toEqual({ status: 'unlinked' });
    expect(await repo.listOAuthIdentities(userId)).toHaveLength(0);
    expect(events.names()).toEqual(['user.oauth_unlinked']);
  });
});

describe('listConnected', () => {
  it('returns the linked providers with their captured email', async () => {
    const userId = await registeredUser('oauth-list@example.test');
    const state = await signOAuthState(
      { provider: 'google', codeVerifier: 'v', linkUserId: userId },
      { secret: JWT_STATE_SECRET },
    );
    await oauth.callback(
      googleDeps({ subject: 'google-sub-list', email: 'captured@example.test' }),
      { provider: 'google', code: 'c', state },
      meta,
    );

    const connected = await oauth.listConnected(userId);
    expect(connected).toHaveLength(1);
    expect(connected[0]?.provider).toBe('google');
    expect(connected[0]?.email).toBe('captured@example.test');
    expect(connected[0]?.linkedAt).toBeInstanceOf(Date);
  });
});
