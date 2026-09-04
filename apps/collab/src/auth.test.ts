import { describe, expect, it } from 'vitest';
import { signAccessToken } from '@taskflow/security';
import { generateTestAccessTokenKeyPair } from '@taskflow/security/testing';
import { MOBILE_CLIENT } from '@taskflow/contracts';
import { authenticateConnection, isNativeClient, isSelfOrigin, originAllowed } from './auth.js';

/**
 * The origin check (ai/phase-6-docs.md §3.3, §8), and a smoke test that this
 * module signs and verifies against the same `@taskflow/security` primitive
 * `apps/realtime` does.
 *
 * The full `authenticateConnection` — token verification composed with
 * `authorizeConnect`'s database-backed decision — is exercised end to end in
 * `authorize.test.ts` against real Postgres. Splitting the origin check out
 * here mirrors `apps/realtime/src/auth.test.ts`'s own split: this is the part
 * that needs no database and no real tuples, so it runs everywhere instantly.
 *
 * `authenticateConnection`'s own describe block below tests the ORIGIN GATE
 * in isolation, without touching `authorizeConnect` or Postgres: every case
 * presents a token signed with the WRONG secret, so a connection that gets
 * past the origin gate fails at token verification next (`invalid_token`)
 * rather than reaching the database — the refusal REASON is what proves the
 * gate was passed, the same trick `authorize.test.ts`'s own end-to-end cases
 * do not need since they run against a real database anyway.
 */

const ORIGINS = ['http://localhost:5173'];

describe('originAllowed', () => {
  it('accepts exactly the configured origins', () => {
    expect(originAllowed('http://localhost:5173', ORIGINS)).toBe(true);
    expect(originAllowed('http://evil.test', ORIGINS)).toBe(false);
  });

  it('refuses a MISSING origin rather than treating it as trusted', () => {
    expect(originAllowed(null, ORIGINS)).toBe(false);
    expect(originAllowed('', ORIGINS)).toBe(false);
  });

  it('does not accept a lookalike that merely contains an allowed origin', () => {
    expect(originAllowed('http://localhost:5173.evil.test', ORIGINS)).toBe(false);
    expect(originAllowed('http://evil.test/http://localhost:5173', ORIGINS)).toBe(false);
    expect(originAllowed('https://localhost:5173', ORIGINS)).toBe(false);
  });
});

describe('isSelfOrigin (§8, ported from apps/realtime/src/auth.ts)', () => {
  it('matches an origin naming exactly the request’s own host:port', () => {
    expect(isSelfOrigin('http://10.78.51.128:3001', '10.78.51.128:3001')).toBe(true);
  });

  it('is scheme-independent — only host:port is compared', () => {
    expect(isSelfOrigin('ws://10.78.51.128:3001', '10.78.51.128:3001')).toBe(true);
  });

  it('does not match a real, different origin — this is not a blanket bypass', () => {
    expect(isSelfOrigin('http://evil.test', '10.78.51.128:3001')).toBe(false);
  });

  it('does not match a same-host origin at a DIFFERENT port', () => {
    expect(isSelfOrigin('http://10.78.51.128:9999', '10.78.51.128:3001')).toBe(false);
  });

  it('refuses rather than throws on a missing Host or a malformed origin', () => {
    expect(isSelfOrigin('http://10.78.51.128:3001', null)).toBe(false);
    expect(isSelfOrigin('not-a-url', '10.78.51.128:3001')).toBe(false);
  });
});

describe('isNativeClient (§8, ported from apps/realtime/src/auth.ts)', () => {
  it('reads the exact marker the mobile client sends', () => {
    expect(isNativeClient(MOBILE_CLIENT)).toBe(true);
  });

  it('refuses anything else — absent or the wrong value', () => {
    expect(isNativeClient(null)).toBe(false);
    expect(isNativeClient('browser')).toBe(false);
  });
});

/* A deliberately WRONG key pair (module scope: top-level await, since a
   `describe` callback cannot be async), so a connection that gets past the
   origin gate fails at token verification next rather than reaching
   `authorizeConnect` — which needs real Postgres. Asserting the refusal is
   `invalid_token` (not `forbidden_origin`) is how these run as pure unit
   tests and still prove the origin gate was actually passed. */
const { publicKey: ORIGIN_GATE_PUBLIC_KEY } = await generateTestAccessTokenKeyPair();
const { privateKey: ORIGIN_GATE_WRONG_PRIVATE_KEY } = await generateTestAccessTokenKeyPair();

describe('authenticateConnection’s origin gate (§8, the native-client interim allowance)', () => {
  const PUBLIC_KEY = ORIGIN_GATE_PUBLIC_KEY;
  const WRONG_PRIVATE_KEY = ORIGIN_GATE_WRONG_PRIVATE_KEY;
  const ORIGINS = ['http://localhost:5173'];

  async function pastOriginToken(): Promise<string> {
    return signAccessToken(
      {
        userId: '0195ff00-0000-7000-8000-000000000a01',
        sessionId: '0195ff00-0000-7000-8000-000000000501',
        authenticatedAt: Math.floor(Date.now() / 1000),
      },
      { privateKey: WRONG_PRIVATE_KEY },
    );
  }

  async function refusalOf(
    input: Omit<Parameters<typeof authenticateConnection>[0], 'token' | 'documentName'>,
  ): Promise<string> {
    try {
      await authenticateConnection(
        { ...input, token: await pastOriginToken(), documentName: 'page:irrelevant' },
        { jwtPublicKey: PUBLIC_KEY, allowedOrigins: ORIGINS },
      );
    } catch (error) {
      if (error instanceof Error && 'refusal' in error) return String(error.refusal);
      throw error;
    }
    throw new Error('expected the connection to be refused, but it succeeded');
  }

  it('is let through with no Origin, if it presents the marker', async () => {
    expect(
      await refusalOf({
        origin: null,
        orgIdParam: null,
        nativeClientHeader: MOBILE_CLIENT,
        host: null,
      }),
    ).toBe('invalid_token');
  });

  it('still refuses no-Origin with no marker — the interim allowance changes nothing else', async () => {
    expect(
      await refusalOf({ origin: null, orgIdParam: null, nativeClientHeader: null, host: null }),
    ).toBe('forbidden_origin');
  });

  it('never overrides a PRESENT, disallowed origin — a browser cannot claim to be native', async () => {
    expect(
      await refusalOf({
        origin: 'http://evil.test',
        orgIdParam: null,
        nativeClientHeader: MOBILE_CLIENT,
        host: null,
      }),
    ).toBe('forbidden_origin');
  });

  describe('a self-referential Origin (§8, the real-device finding realtime already made)', () => {
    const REAL_DEVICE_ORIGIN = 'http://10.78.51.128:3001';
    const REAL_DEVICE_HOST = '10.78.51.128:3001';

    it('is let through, with the marker', async () => {
      expect(
        await refusalOf({
          origin: REAL_DEVICE_ORIGIN,
          orgIdParam: null,
          nativeClientHeader: MOBILE_CLIENT,
          host: REAL_DEVICE_HOST,
        }),
      ).toBe('invalid_token');
    });

    it('is refused without the native marker — this never weakens the browser path', async () => {
      expect(
        await refusalOf({
          origin: REAL_DEVICE_ORIGIN,
          orgIdParam: null,
          nativeClientHeader: null,
          host: REAL_DEVICE_HOST,
        }),
      ).toBe('forbidden_origin');
    });

    it('is refused when the marker is present but Origin does NOT match Host', async () => {
      expect(
        await refusalOf({
          origin: REAL_DEVICE_ORIGIN,
          orgIdParam: null,
          nativeClientHeader: MOBILE_CLIENT,
          host: 'a-different-host:9999',
        }),
      ).toBe('forbidden_origin');
    });
  });
});

describe('token signing smoke test', () => {
  it('signs a token this module can later verify (proves the shared primitive is wired)', async () => {
    const { privateKey } = await generateTestAccessTokenKeyPair();
    const token = await signAccessToken(
      {
        userId: '0195ff20-0000-7000-8000-000000000001',
        sessionId: '0195ff20-0000-7000-8000-000000000501',
        authenticatedAt: Math.floor(Date.now() / 1000),
      },
      { privateKey },
    );

    expect(typeof token).toBe('string');
    expect(token.split('.')).toHaveLength(3);
  });
});
