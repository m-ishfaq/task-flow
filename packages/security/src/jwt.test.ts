import { describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  InvalidTokenError,
  signAccessToken,
  verifyAccessToken,
  type AccessTokenClaims,
} from './jwt.js';
import { secureBytes } from './random.js';

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
    const token = await signAccessToken(claims, config);
    await expect(verifyAccessToken(token, config)).resolves.toEqual(claims);
  });

  it('omits optional claims rather than emitting undefined', async () => {
    const minimal: AccessTokenClaims = {
      userId: claims.userId,
      sessionId: claims.sessionId,
      authenticatedAt: claims.authenticatedAt,
    };
    const verified = await verifyAccessToken(await signAccessToken(minimal, config), config);

    expect('orgId' in verified).toBe(false);
    expect('role' in verified).toBe(false);
  });

  it('expires within the documented window', async () => {
    const token = await signAccessToken(claims, config);
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'),
    ) as { exp: number; iat: number };

    expect(payload.exp - payload.iat).toBe(ACCESS_TOKEN_TTL_SECONDS);
    expect(ACCESS_TOKEN_TTL_SECONDS).toBeLessThanOrEqual(900);
  });
});

describe('rejection', () => {
  it('rejects a token signed with a different secret', async () => {
    const token = await signAccessToken(claims, other);
    await expect(verifyAccessToken(token, config)).rejects.toThrow(InvalidTokenError);
  });

  it('rejects a tampered payload', async () => {
    const token = await signAccessToken(claims, config);
    const [header, payload, signature] = token.split('.');

    const decoded = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    decoded['role'] = 'owner'; // the privilege escalation the signature prevents
    const forged = Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url');

    await expect(
      verifyAccessToken(`${header ?? ''}.${forged}.${signature ?? ''}`, config),
    ).rejects.toThrow(InvalidTokenError);
  });

  it('rejects the alg:none forgery', async () => {
    // The oldest JWT vulnerability: a library that honours the header's
    // algorithm accepts an unsigned token as valid. `algorithms: ['HS256']` is
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

    await expect(verifyAccessToken(unsigned, config)).rejects.toThrow(InvalidTokenError);
  });

  it('rejects an expired token', async () => {
    const expired = await new SignJWT({ sid: claims.sessionId, auth_time: claims.authenticatedAt })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(claims.userId)
      .setIssuer('taskflow')
      .setAudience('taskflow-api')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(config.secret);

    await expect(verifyAccessToken(expired, config)).rejects.toThrow(InvalidTokenError);
  });

  it('rejects a correctly signed token issued for something else', async () => {
    // A valid signature is not the same as a token meant for this. Without the
    // issuer and audience checks, any other artifact signed with the same secret
    // — a webhook signature, a token from a different environment sharing a
    // secret by accident — authenticates as a user.
    const foreign = await new SignJWT({ sid: claims.sessionId, auth_time: claims.authenticatedAt })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(claims.userId)
      .setIssuer('some-other-service')
      .setAudience('some-other-service')
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(config.secret);

    await expect(verifyAccessToken(foreign, config)).rejects.toThrow(InvalidTokenError);
  });

  it.each([
    ['empty', ''],
    ['not a JWT', 'hello'],
    ['two segments', 'a.b'],
    ['garbage segments', 'aaa.bbb.ccc'],
  ])('rejects %s', async (_label, token) => {
    await expect(verifyAccessToken(token, config)).rejects.toThrow(InvalidTokenError);
  });

  it('rejects a token missing required claims', async () => {
    const incomplete = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(claims.userId)
      .setIssuer('taskflow')
      .setAudience('taskflow-api')
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(config.secret);

    await expect(verifyAccessToken(incomplete, config)).rejects.toThrow(InvalidTokenError);
  });

  it('gives the same message whatever went wrong', async () => {
    // Distinguishing "expired" from "bad signature" is only useful to someone
    // probing the token format.
    const messages = await Promise.all(
      ['', 'garbage', await signAccessToken(claims, other)].map((token) =>
        verifyAccessToken(token, config).then(
          () => 'no error',
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        ),
      ),
    );

    expect(new Set(messages).size).toBe(1);
  });
});

describe('key strength', () => {
  it.each([0, 8, 16, 31])('refuses a %s-byte secret', async (size) => {
    // HS256's security is bounded by key length; a short secret is recoverable
    // offline from a single captured token, which is a full authentication
    // bypass rather than a weakening.
    await expect(signAccessToken(claims, { secret: new Uint8Array(size) })).rejects.toThrow(
      RangeError,
    );
    await expect(verifyAccessToken('x.y.z', { secret: new Uint8Array(size) })).rejects.toThrow(
      RangeError,
    );
  });
});
