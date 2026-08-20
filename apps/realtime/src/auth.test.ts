import type { IncomingMessage } from 'node:http';
import type { Socket } from 'socket.io';
import { describe, expect, it } from 'vitest';
import { signAccessToken } from '@taskflow/security';
import { CLIENT_HEADER, MOBILE_CLIENT } from '@taskflow/contracts';
import type { TrustProxyValue } from '@taskflow/api/config/trust-proxy';
import {
  clientAddress,
  HandshakeError,
  isNativeClient,
  originAllowed,
  verifyHandshake,
} from './auth.js';

/**
 * The handshake perimeter (ai/phase-4-realtime.md §3.2, §3.7, §3.8).
 *
 * ⚠ Adjacent to a human-review surface (§2.2): this is what decides the identity
 * every room-join authorization is then evaluated against, for hours.
 *
 * `verifyHandshake` is exercised with REAL tokens from `@taskflow/security` —
 * signed by the same function the API signs with, verified by the same one it
 * verifies with. A fake token generator would only prove this file agrees with
 * itself about a format, and the properties that matter here (a wrong secret is
 * refused, an expired token is refused, every refusal is indistinguishable) are
 * exactly the ones a stub cannot demonstrate.
 */

const SECRET = Buffer.from('a'.repeat(32), 'utf8');
const WRONG_SECRET = Buffer.from('b'.repeat(32), 'utf8');
const ORIGINS = ['http://localhost:5173'];

const USER = '0195ff00-0000-7000-8000-000000000a01';
const SESSION = '0195ff00-0000-7000-8000-000000000501';

async function token(
  overrides: Partial<Parameters<typeof signAccessToken>[0]> = {},
  secret = SECRET,
): Promise<string> {
  return signAccessToken(
    {
      userId: USER,
      sessionId: SESSION,
      authenticatedAt: Math.floor(Date.now() / 1000),
      ...overrides,
    },
    { secret },
  );
}

/** Just the fields `verifyHandshake` reads, in the shape Socket.io puts them. */
function fakeSocket(
  origin: string | undefined,
  auth: unknown,
  extraHeaders: Record<string, string> = {},
): Socket {
  return {
    handshake: {
      headers: { ...(origin === undefined ? {} : { origin }), ...extraHeaders },
      auth,
    },
  } as unknown as Socket;
}

async function refusalOf(socket: Socket): Promise<string> {
  try {
    await verifyHandshake(socket, { jwtSecret: SECRET, allowedOrigins: ORIGINS });
  } catch (error) {
    if (error instanceof HandshakeError) return error.refusal;
    throw error;
  }
  throw new Error('expected the handshake to be refused, but it succeeded');
}

describe('originAllowed (§3.2)', () => {
  it('accepts exactly the configured origins', () => {
    expect(originAllowed('http://localhost:5173', ORIGINS)).toBe(true);
    expect(originAllowed('http://evil.test', ORIGINS)).toBe(false);
  });

  it('refuses a MISSING origin rather than treating it as trusted', () => {
    // Browsers always send one on a WebSocket upgrade. A request without one is
    // not a browser, and "allow it, it is probably a server-side client" is how
    // this check gets bypassed by anything that simply omits the header.
    expect(originAllowed(undefined, ORIGINS)).toBe(false);
    expect(originAllowed('', ORIGINS)).toBe(false);
  });

  it('does not accept a lookalike that merely contains an allowed origin', () => {
    // The failure this rules out is a substring/prefix check, which is the
    // natural "simplification" of an exact-match list.
    expect(originAllowed('http://localhost:5173.evil.test', ORIGINS)).toBe(false);
    expect(originAllowed('http://evil.test/http://localhost:5173', ORIGINS)).toBe(false);
    expect(originAllowed('https://localhost:5173', ORIGINS)).toBe(false);
  });
});

describe('isNativeClient (§8, interim — see this function’s own comment)', () => {
  it('reads the exact marker the mobile client sends', () => {
    expect(isNativeClient({ [CLIENT_HEADER]: MOBILE_CLIENT })).toBe(true);
  });

  it('refuses anything else — absent, wrong value, or a repeated header', () => {
    expect(isNativeClient({})).toBe(false);
    expect(isNativeClient({ [CLIENT_HEADER]: 'browser' })).toBe(false);
    // A repeated header arrives as an array in Node's http headers; treating
    // that as a match would accept ['mobile', 'mobile'] too, which is not
    // the single-string shape the real client ever sends.
    expect(isNativeClient({ [CLIENT_HEADER]: [MOBILE_CLIENT, MOBILE_CLIENT] })).toBe(false);
  });
});

describe('verifyHandshake (§3.2, §3.8)', () => {
  it('establishes the identity from the token, and only from the token', async () => {
    const identity = await verifyHandshake(
      fakeSocket(ORIGINS[0], {
        token: await token(),
        // §3.7: a client asserting an identity alongside its token must not be
        // able to influence the answer. These are simply never read.
        userId: '0195ff00-0000-7000-8000-0000000000ff',
        role: 'owner',
      }),
      { jwtSecret: SECRET, allowedOrigins: ORIGINS },
    );

    expect(identity.userId).toBe(USER);
    expect(identity.sessionId).toBe(SESSION);
    expect(identity.tokenExpiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('refuses a connection presenting no token at all', async () => {
    expect(await refusalOf(fakeSocket(ORIGINS[0], {}))).toBe('no_token');
    expect(await refusalOf(fakeSocket(ORIGINS[0], undefined))).toBe('no_token');
    expect(await refusalOf(fakeSocket(ORIGINS[0], { token: '' }))).toBe('no_token');
  });

  it('refuses a token signed with a different secret', async () => {
    expect(await refusalOf(fakeSocket(ORIGINS[0], { token: await token({}, WRONG_SECRET) }))).toBe(
      'invalid_token',
    );
  });

  it('refuses a malformed token', async () => {
    expect(await refusalOf(fakeSocket(ORIGINS[0], { token: 'not.a.jwt' }))).toBe('invalid_token');
  });

  it('refuses a disallowed origin BEFORE looking at the token', async () => {
    // Ordering matters: a page from another origin must not be able to probe
    // whether a stolen token is still valid by reading which refusal it gets.
    // Asserted with a VALID token, so the only reason to refuse is the origin.
    expect(await refusalOf(fakeSocket('http://evil.test', { token: await token() }))).toBe(
      'forbidden_origin',
    );
  });

  describe('the native client marker (§8, interim)', () => {
    it('is let through with no Origin, if it presents the marker and a valid token', async () => {
      const identity = await verifyHandshake(
        fakeSocket(undefined, { token: await token() }, { [CLIENT_HEADER]: MOBILE_CLIENT }),
        { jwtSecret: SECRET, allowedOrigins: ORIGINS },
      );
      expect(identity.userId).toBe(USER);
    });

    it('still refuses no-Origin with no marker — the interim allowance changes nothing else', async () => {
      expect(await refusalOf(fakeSocket(undefined, { token: await token() }))).toBe(
        'forbidden_origin',
      );
    });

    it('never overrides a PRESENT, disallowed origin — a browser cannot claim to be native', async () => {
      // The marker only matters when Origin is absent. A real browser always
      // attaches its true origin, so a forbidden one is refused regardless of
      // any other header sent alongside it — otherwise this "interim native
      // allowance" would double as a bypass for the browser check it was
      // never meant to touch.
      expect(
        await refusalOf(
          fakeSocket(
            'http://evil.test',
            { token: await token() },
            {
              [CLIENT_HEADER]: MOBILE_CLIENT,
            },
          ),
        ),
      ).toBe('forbidden_origin');
    });

    it('still refuses an invalid token even with no Origin and the marker present', async () => {
      // The marker relaxes the ORIGIN check only. Token verification —
      // the control that actually protects a native connection — is
      // untouched.
      expect(
        await refusalOf(
          fakeSocket(
            undefined,
            { token: await token({}, WRONG_SECRET) },
            {
              [CLIENT_HEADER]: MOBILE_CLIENT,
            },
          ),
        ),
      ).toBe('invalid_token');
    });
  });

  it('refuses a token whose subject is not a well-formed user id', async () => {
    // Otherwise it flows into loadTuples as a raw string and compares unequal
    // to every tuple subject — a denial for the wrong reason, which is the kind
    // that gets "fixed" by loosening the comparison.
    expect(
      await refusalOf(fakeSocket(ORIGINS[0], { token: await token({ userId: 'nope' }) })),
    ).toBe('invalid_token');
  });
});

describe('clientAddress (§6.5)', () => {
  function request(socketAddress: string, forwardedFor?: string): IncomingMessage {
    return {
      headers: forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor },
      socket: { remoteAddress: socketAddress },
      connection: { remoteAddress: socketAddress },
    } as unknown as IncomingMessage;
  }

  it('ignores X-Forwarded-For when no proxy is trusted (the default)', () => {
    // The control being protected: with a trusted header, a caller buys a fresh
    // per-IP budget by sending a new value on every connection, which makes the
    // §6.5 connection limit opt-out.
    expect(clientAddress(request('10.0.0.1', '1.2.3.4'), false)).toBe('10.0.0.1');
  });

  /**
   * The regression test for a real bug: a numeric `REALTIME_TRUST_PROXY` was
   * passed straight to `proxy-addr`'s `compile()`, which only accepts a string
   * or an array and throws `TypeError: unsupported trust argument`. Every
   * handshake would have been refused the instant anyone configured a hop
   * count — the single most likely value to set.
   */
  it('honours a numeric hop count without throwing', () => {
    const hop: TrustProxyValue = 1;

    expect(() => clientAddress(request('10.0.0.1', '1.2.3.4'), hop)).not.toThrow();
    expect(clientAddress(request('10.0.0.1', '1.2.3.4'), hop)).toBe('1.2.3.4');
  });

  it('trusts only as many hops as configured', () => {
    // Two proxies claimed, one trusted: the address is the nearest untrusted
    // hop, not the leftmost value the caller wrote.
    expect(clientAddress(request('10.0.0.1', '1.2.3.4, 5.6.7.8'), 1)).toBe('5.6.7.8');
  });

  it('accepts a CIDR list', () => {
    expect(clientAddress(request('10.0.0.1', '1.2.3.4'), '10.0.0.0/8')).toBe('1.2.3.4');
    // An address outside the trusted range is not a proxy, so its claim is
    // ignored and the socket address stands.
    expect(clientAddress(request('192.168.1.1', '1.2.3.4'), '10.0.0.0/8')).toBe('192.168.1.1');
  });
});
