import { describe, expect, it } from 'vitest';
import { SignJWT, generateKeyPair, exportPKCS8, exportSPKI } from 'jose';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  InvalidTokenError,
  importAccessTokenPrivateKey,
  importAccessTokenPublicKey,
  signAccessToken,
  signOAuthState,
  signTotpChallenge,
  verifyAccessToken,
  verifyOAuthState,
  verifyTotpChallenge,
  type AccessTokenClaims,
} from './jwt.js';
import { secureBytes } from './random.js';

// Access tokens are RS256 now — two real key pairs, generated once for the
// whole file rather than per test, the same way `config`/`other` below are
// generated once for the still-HS256 state-token tests.
// extractable: true only because the 'key import' suite below needs to export
// this pair back out to PEM to test the round trip; a real boot never exports
// a key it just imported.
const { privateKey, publicKey } = await generateKeyPair('RS256', {
  modulusLength: 2048,
  extractable: true,
});
const { privateKey: otherPrivateKey } = await generateKeyPair('RS256', {
  modulusLength: 2048,
});

const signingConfig = { privateKey };
const verifyConfig = { publicKey };
const otherSigningConfig = { privateKey: otherPrivateKey };

const config = { secret: secureBytes(32) };
const other = { secret: secureBytes(32) };

const claims: AccessTokenClaims = {
  userId: '018f4d1e-7c3a-7b2e-8f1a-000000000001',
  sessionId: '018f4d1e-7c3a-7b2e-8f1a-0000000000f1',
  orgId: '018f4d1e-7c3a-7b2e-8f1a-00000000000a',
  role: 'member',
  authenticatedAt: Math.floor(Date.now() / 1000),
};

describe('round trip', () => {
  it('recovers every claim', async () => {
    const token = await signAccessToken(claims, signingConfig);
    await expect(verifyAccessToken(token, verifyConfig)).resolves.toEqual(claims);
  });

  it('omits optional claims rather than emitting undefined', async () => {
    const minimal: AccessTokenClaims = {
      userId: claims.userId,
      sessionId: claims.sessionId,
      authenticatedAt: claims.authenticatedAt,
    };
    const verified = await verifyAccessToken(
      await signAccessToken(minimal, signingConfig),
      verifyConfig,
    );

    expect('orgId' in verified).toBe(false);
    expect('role' in verified).toBe(false);
  });

  it('expires within the documented window', async () => {
    const token = await signAccessToken(claims, signingConfig);
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'),
    ) as { exp: number; iat: number };

    expect(payload.exp - payload.iat).toBe(ACCESS_TOKEN_TTL_SECONDS);
    expect(ACCESS_TOKEN_TTL_SECONDS).toBeLessThanOrEqual(900);
  });
});

describe('rejection', () => {
  it('rejects a token signed with a different key pair', async () => {
    const token = await signAccessToken(claims, otherSigningConfig);
    await expect(verifyAccessToken(token, verifyConfig)).rejects.toThrow(InvalidTokenError);
  });

  it('rejects a tampered payload', async () => {
    const token = await signAccessToken(claims, signingConfig);
    const [header, payload, signature] = token.split('.');

    const decoded = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    decoded['role'] = 'owner'; // the privilege escalation the signature prevents
    const forged = Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url');

    await expect(
      verifyAccessToken(`${header ?? ''}.${forged}.${signature ?? ''}`, verifyConfig),
    ).rejects.toThrow(InvalidTokenError);
  });

  it('rejects the alg:none forgery', async () => {
    // The oldest JWT vulnerability: a library that honours the header's
    // algorithm accepts an unsigned token as valid. `algorithms: ['RS256']` is
    // what refuses it, and this test is what proves that option is still there.
    const unsigned =
      Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' }), 'utf8').toString('base64url') +
      '.' +
      Buffer.from(
        JSON.stringify({
          sub: claims.userId,
          sid: claims.sessionId,
          auth_time: claims.authenticatedAt,
          role: 'owner',
          iss: 'taskflow',
          aud: 'taskflow-api',
          exp: Math.floor(Date.now() / 1000) + 600,
        }),
        'utf8',
      ).toString('base64url') +
      '.';

    await expect(verifyAccessToken(unsigned, verifyConfig)).rejects.toThrow(InvalidTokenError);
  });

  it('rejects an expired token', async () => {
    const expired = await new SignJWT({ sid: claims.sessionId, auth_time: claims.authenticatedAt })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setSubject(claims.userId)
      .setIssuer('taskflow')
      .setAudience('taskflow-api')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(privateKey);

    await expect(verifyAccessToken(expired, verifyConfig)).rejects.toThrow(InvalidTokenError);
  });

  it('rejects a correctly signed token issued for something else', async () => {
    // A valid signature is not the same as a token meant for this. Without the
    // issuer and audience checks, any other artifact signed with the same key
    // — a token from a different environment sharing key material by accident
    // — authenticates as a user.
    const foreign = await new SignJWT({ sid: claims.sessionId, auth_time: claims.authenticatedAt })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setSubject(claims.userId)
      .setIssuer('some-other-service')
      .setAudience('some-other-service')
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(privateKey);

    await expect(verifyAccessToken(foreign, verifyConfig)).rejects.toThrow(InvalidTokenError);
  });

  it.each([
    ['empty', ''],
    ['not a JWT', 'hello'],
    ['two segments', 'a.b'],
    ['garbage segments', 'aaa.bbb.ccc'],
  ])('rejects %s', async (_label, token) => {
    await expect(verifyAccessToken(token, verifyConfig)).rejects.toThrow(InvalidTokenError);
  });

  it('rejects a token missing required claims', async () => {
    const incomplete = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setSubject(claims.userId)
      .setIssuer('taskflow')
      .setAudience('taskflow-api')
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(privateKey);

    await expect(verifyAccessToken(incomplete, verifyConfig)).rejects.toThrow(InvalidTokenError);
  });

  it('gives the same message whatever went wrong', async () => {
    // Distinguishing "expired" from "bad signature" is only useful to someone
    // probing the token format.
    const messages = await Promise.all(
      ['', 'garbage', await signAccessToken(claims, otherSigningConfig)].map((token) =>
        verifyAccessToken(token, verifyConfig).then(
          () => 'no error',
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        ),
      ),
    );

    expect(new Set(messages).size).toBe(1);
  });
});

describe('TOTP challenge tokens', () => {
  const userId = claims.userId;

  it('round-trips the user id', async () => {
    const token = await signTotpChallenge({ userId }, config);
    await expect(verifyTotpChallenge(token, config)).resolves.toEqual({ userId });
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await signTotpChallenge({ userId }, other);
    await expect(verifyTotpChallenge(token, config)).rejects.toThrow(InvalidTokenError);
  });

  it('is refused by the access-token verifier, and vice versa', async () => {
    // A distinct audience means a challenge can never be replayed as a bearer
    // access token — and now a distinct ALGORITHM too, since the access token
    // moved to RS256 and this one stays HS256: `verifyAccessToken`'s pinned
    // `algorithms: ['RS256']` refuses an HS256 token before it even reaches
    // the audience check.
    const challenge = await signTotpChallenge({ userId }, config);
    await expect(verifyAccessToken(challenge, verifyConfig)).rejects.toThrow(InvalidTokenError);

    const access = await signAccessToken(
      { userId, sessionId: claims.sessionId, authenticatedAt: claims.authenticatedAt },
      signingConfig,
    );
    await expect(verifyTotpChallenge(access, config)).rejects.toThrow(InvalidTokenError);
  });

  it('expires within the documented five-minute window', async () => {
    const token = await signTotpChallenge({ userId }, config);
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'),
    ) as { exp: number; iat: number };

    expect(payload.exp - payload.iat).toBe(300);
  });
});

describe('OAuth state tokens', () => {
  it('round-trips provider and code verifier, omitting linkUserId when absent', async () => {
    const token = await signOAuthState({ provider: 'google', codeVerifier: 'a-verifier' }, config);
    const verified = await verifyOAuthState(token, config);

    expect(verified).toEqual({ provider: 'google', codeVerifier: 'a-verifier' });
    expect('linkUserId' in verified).toBe(false);
  });

  it('round-trips linkUserId when linking to an existing session', async () => {
    const token = await signOAuthState(
      { provider: 'github', codeVerifier: 'a-verifier', linkUserId: claims.userId },
      config,
    );

    await expect(verifyOAuthState(token, config)).resolves.toEqual({
      provider: 'github',
      codeVerifier: 'a-verifier',
      linkUserId: claims.userId,
    });
  });

  it('rejects a token signed with a different secret', async () => {
    const token = await signOAuthState({ provider: 'google', codeVerifier: 'v' }, other);
    await expect(verifyOAuthState(token, config)).rejects.toThrow(InvalidTokenError);
  });

  it('is refused by the access-token and TOTP-challenge verifiers, and vice versa', async () => {
    const state = await signOAuthState({ provider: 'google', codeVerifier: 'v' }, config);
    await expect(verifyAccessToken(state, verifyConfig)).rejects.toThrow(InvalidTokenError);
    await expect(verifyTotpChallenge(state, config)).rejects.toThrow(InvalidTokenError);

    const challenge = await signTotpChallenge({ userId: claims.userId }, config);
    await expect(verifyOAuthState(challenge, config)).rejects.toThrow(InvalidTokenError);
  });
});

describe('key strength', () => {
  // HS256's security is bounded by key length; a short secret is recoverable
  // offline from a single captured token, which is a full authentication
  // bypass rather than a weakening. Exercised here via OAuth state — the
  // state-token functions are the ones that still take a raw HS256 secret.
  // The access token moved to RS256 keys (`signAccessToken`/`verifyAccessToken`
  // no longer accept a raw secret at all — the type system refuses one), which
  // has no equivalent "too short" failure mode to test.
  it.each([0, 8, 16, 31])('refuses a %s-byte secret', async (size) => {
    await expect(
      signOAuthState({ provider: 'google', codeVerifier: 'v' }, { secret: new Uint8Array(size) }),
    ).rejects.toThrow(RangeError);
    await expect(verifyOAuthState('x.y.z', { secret: new Uint8Array(size) })).rejects.toThrow(
      RangeError,
    );
  });
});

describe('key import', () => {
  it('round-trips a base64-encoded PEM key pair, matching real boot behaviour', async () => {
    // Mirrors exactly what each process does at startup: JWT_PRIVATE_KEY /
    // JWT_PUBLIC_KEY in the validated env schema are base64-encoded PEM, and
    // this is the only path that ever turns them into the KeyLike objects
    // signAccessToken/verifyAccessToken actually use.
    const privatePem = await exportPKCS8(privateKey);
    const publicPem = await exportSPKI(publicKey);

    const importedPrivate = await importAccessTokenPrivateKey(
      Buffer.from(privatePem, 'utf8').toString('base64'),
    );
    const importedPublic = await importAccessTokenPublicKey(
      Buffer.from(publicPem, 'utf8').toString('base64'),
    );

    const token = await signAccessToken(claims, { privateKey: importedPrivate });
    await expect(verifyAccessToken(token, { publicKey: importedPublic })).resolves.toEqual(claims);
  });
});
