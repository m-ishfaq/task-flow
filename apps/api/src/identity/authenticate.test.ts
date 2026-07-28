import { describe, expect, it } from 'vitest';
import { ACCESS_TOKEN_TTL_SECONDS, signAccessToken } from '@taskflow/security';
import { authenticate, bearerToken } from './authenticate.js';

/**
 * The function that decides who every request is.
 *
 * Written after discovering that `verifyAccessToken` had never run against a
 * token this server issued: the context factory left `auth` null
 * unconditionally, so the whole verification path was dead code that compiled
 * and was covered by its own unit tests in @taskflow/security. These tests go
 * through the real signer, so a change to either half breaks them.
 */

const SECRET = new Uint8Array(Buffer.alloc(32, 7));
const OTHER_SECRET = new Uint8Array(Buffer.alloc(32, 9));

const USER_ID = '018f4d1e-7c3a-7b2e-8f1a-000000000001';
const SESSION_ID = '018f4d1e-7c3a-7b2e-8f1a-000000000002';

async function tokenFor(overrides: { userId?: string; sessionId?: string } = {}): Promise<string> {
  return signAccessToken(
    {
      userId: overrides.userId ?? USER_ID,
      sessionId: overrides.sessionId ?? SESSION_ID,
      authenticatedAt: Math.floor(Date.now() / 1000),
    },
    { secret: SECRET },
  );
}

/**
 * Corrupts a token's signature so it can no longer verify.
 *
 * The FIRST character of the signature segment, not the last. An HS256 signature
 * is 32 bytes, which base64url-encodes to 43 characters — and the 43rd carries
 * only 4 significant bits, so two of the four substitutions for it decode to
 * identical bytes. The original version of this helper flipped the last
 * character and therefore produced a still-valid token whenever the encoding
 * happened to land that way: a test that passed most runs and failed at random.
 *
 * The first character carries a full 6 bits, so changing it always changes the
 * signature.
 */
function tamper(token: string): string {
  const [header, payload, signature] = token.split('.');
  const first = signature?.[0] ?? '';

  return `${header ?? ''}.${payload ?? ''}.${first === 'A' ? 'B' : 'A'}${signature?.slice(1) ?? ''}`;
}

describe('bearerToken', () => {
  it('extracts the token from a well-formed header', () => {
    expect(bearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
  });

  it('matches the scheme case-insensitively', () => {
    // RFC 9110 §11.1 makes the scheme case-insensitive, and real clients send
    // `bearer`. Rejecting those would be a bug that only shows up in production.
    expect(bearerToken('bearer abc')).toBe('abc');
    expect(bearerToken('BEARER abc')).toBe('abc');
  });

  it('rejects a bare token with no scheme', () => {
    // Accepting this would mean any header holding a JWT-shaped string
    // authenticates the request.
    expect(bearerToken('abc.def.ghi')).toBeNull();
  });

  it('rejects a different scheme', () => {
    expect(bearerToken('Basic dXNlcjpwYXNz')).toBeNull();
  });

  it('rejects extra parts', () => {
    expect(bearerToken('Bearer abc def')).toBeNull();
  });

  it('rejects an absent, empty, or whitespace-only header', () => {
    expect(bearerToken(undefined)).toBeNull();
    expect(bearerToken('')).toBeNull();
    expect(bearerToken('   ')).toBeNull();
    expect(bearerToken('Bearer ')).toBeNull();
  });
});

describe('authenticate', () => {
  it('returns the principal named by a valid token', async () => {
    const principal = await authenticate(`Bearer ${await tokenFor()}`, { jwtSecret: SECRET });

    expect(principal?.userId).toBe(USER_ID);
    expect(principal?.sessionId).toBe(SESSION_ID);
    expect(principal?.authenticatedAt).toBeInstanceOf(Date);
  });

  it('carries no organization', async () => {
    // The property Phase 2 changes. A role that arrived in the token would mean
    // a demotion takes effect only when the token expires — so a revoked admin
    // stays admin for exactly the ten minutes that matter.
    const principal = await authenticate(`Bearer ${await tokenFor()}`, { jwtSecret: SECRET });

    expect(principal?.org).toBeNull();
  });

  it('reports no principal for a token signed with another key', async () => {
    const forged = await signAccessToken(
      { userId: USER_ID, sessionId: SESSION_ID, authenticatedAt: Math.floor(Date.now() / 1000) },
      { secret: OTHER_SECRET },
    );

    await expect(authenticate(`Bearer ${forged}`, { jwtSecret: SECRET })).resolves.toBeNull();
  });

  it('reports no principal for a tampered token', async () => {
    await expect(
      authenticate(`Bearer ${tamper(await tokenFor())}`, { jwtSecret: SECRET }),
    ).resolves.toBeNull();
  });

  it('reports no principal for garbage', async () => {
    await expect(authenticate('Bearer not-a-jwt', { jwtSecret: SECRET })).resolves.toBeNull();
  });

  it('reports no principal when no header arrived', async () => {
    await expect(authenticate(undefined, { jwtSecret: SECRET })).resolves.toBeNull();
  });

  it('rejects a correctly signed token whose ids are not ids', async () => {
    // The signature proves the claims came from this API, not that they make
    // sense. A malformed id reaching withOrgScope is a string interpolated into
    // an RLS session variable.
    const wrong = await signAccessToken(
      {
        userId: 'not-a-uuid',
        sessionId: SESSION_ID,
        authenticatedAt: Math.floor(Date.now() / 1000),
      },
      { secret: SECRET },
    );

    await expect(authenticate(`Bearer ${wrong}`, { jwtSecret: SECRET })).resolves.toBeNull();
  });

  it('preserves the credential-proof time for step-up', async () => {
    // Step-up compares against this. Losing the seconds-to-milliseconds
    // conversion would put every authentication in 1970 and make every step-up
    // route permanently unreachable — or, with the error in the other
    // direction, permanently open.
    const authenticatedAt = Math.floor(Date.now() / 1000) - 120;
    const token = await signAccessToken(
      { userId: USER_ID, sessionId: SESSION_ID, authenticatedAt },
      { secret: SECRET },
    );

    const principal = await authenticate(`Bearer ${token}`, { jwtSecret: SECRET });
    const ageSeconds = (Date.now() - (principal?.authenticatedAt.getTime() ?? 0)) / 1000;

    expect(ageSeconds).toBeGreaterThan(110);
    expect(ageSeconds).toBeLessThan(130);
  });

  it('agrees with the advertised token lifetime', () => {
    // Guards the pair of constants a client depends on: the API tells the
    // browser `expiresInSeconds`, and the browser schedules its refresh from it.
    expect(ACCESS_TOKEN_TTL_SECONDS).toBeGreaterThan(0);
    expect(ACCESS_TOKEN_TTL_SECONDS).toBeLessThanOrEqual(900);
  });
});
