import { describe, it, expect, vi } from 'vitest';
import {
  NativeSessionResponse,
  SessionResponse,
  handOff,
  nativeSession,
} from './session-response.js';

/**
 * The load-bearing property of ai/phase-14-mobile.md §4.3: the browser body and
 * the native body are separate schemas that cannot cross. These assertions fail
 * if a future edit couples them — e.g. adds `refreshToken` to `SessionResponse`,
 * or derives one schema from the other so a change to one leaks into the other.
 */

const pair = {
  accessToken: 'access.jwt.value',
  refreshToken: 'refresh-token-value',
  expiresInSeconds: 600,
  sessionId: 'sess_1',
};

describe('SessionResponse (browser)', () => {
  it('accepts a cookie-less body', () => {
    expect(
      SessionResponse.safeParse({
        accessToken: pair.accessToken,
        expiresInSeconds: pair.expiresInSeconds,
        sessionId: pair.sessionId,
      }).success,
    ).toBe(true);
  });

  it('REJECTS a body carrying a refresh token — strict is the enforcement', () => {
    // The whole reason the browser token lives in an httpOnly cookie: it must
    // never appear in a body script can read.
    expect(SessionResponse.safeParse({ ...pair }).success).toBe(false);
  });
});

describe('NativeSessionResponse (phone)', () => {
  it('accepts a full body including the refresh token', () => {
    expect(NativeSessionResponse.safeParse({ ...pair }).success).toBe(true);
  });

  it('REQUIRES the refresh token — a native body without one is invalid', () => {
    const { refreshToken: _dropped, ...withoutRefresh } = pair;
    expect(NativeSessionResponse.safeParse(withoutRefresh).success).toBe(false);
  });

  it('is strict — an unknown key is rejected', () => {
    expect(NativeSessionResponse.safeParse({ ...pair, extra: 1 }).success).toBe(false);
  });
});

describe('the two schemas are independent', () => {
  it('the native shape does not validate as a browser response, and vice versa', () => {
    // If either schema were derived from the other, one of these would pass.
    expect(SessionResponse.safeParse({ ...pair }).success).toBe(false);
    const { refreshToken: _dropped, ...browserShape } = pair;
    expect(NativeSessionResponse.safeParse(browserShape).success).toBe(false);
  });
});

describe('handOff (browser) vs nativeSession (phone)', () => {
  it('handOff puts the refresh token in the cookie and returns a body without it', () => {
    const setRefreshCookie = vi.fn();
    const body = handOff({ setRefreshCookie }, pair);

    expect(setRefreshCookie).toHaveBeenCalledWith(pair.refreshToken);
    expect(body).not.toHaveProperty('refreshToken');
    expect(SessionResponse.safeParse(body).success).toBe(true);
  });

  it('nativeSession returns the refresh token in the body and touches no cookie', () => {
    // It takes no response context at all, so it structurally cannot set a
    // cookie — the mechanisms cannot be mixed.
    const body = nativeSession(pair);

    expect(body.refreshToken).toBe(pair.refreshToken);
    expect(NativeSessionResponse.safeParse(body).success).toBe(true);
  });
});
