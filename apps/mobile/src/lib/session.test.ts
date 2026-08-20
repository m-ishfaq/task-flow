import { describe, it, expect, vi } from 'vitest';
import type { OrgId } from '@taskflow/contracts';
import { createInMemorySecureStore, REFRESH_TOKEN_KEY, type SecureStore } from './secure-store.js';
import {
  createMobileSession,
  ORG_HEADER,
  SessionExpiredError,
  type Preferences,
  type SessionApi,
  type SessionTokens,
} from './session.js';

/** A JWT whose `sub` decodeUserId can read. Signature is irrelevant — never verified here. */
function makeJwt(sub: string): string {
  const seg = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${seg({ alg: 'none' })}.${seg({ sub })}.sig`;
}

function tokens(over: Partial<SessionTokens> = {}): SessionTokens {
  return {
    accessToken: makeJwt('user_1'),
    refreshToken: 'refresh_1',
    expiresInSeconds: 600,
    sessionId: 'sess_1',
    ...over,
  };
}

function memoryPrefs(): Preferences {
  const map = new Map<string, string>();
  return {
    getItem: (k) => Promise.resolve(map.get(k) ?? null),
    setItem: (k, v) => {
      map.set(k, v);
      return Promise.resolve();
    },
    removeItem: (k) => {
      map.delete(k);
      return Promise.resolve();
    },
  };
}

function setup(api: SessionApi, secureStore: SecureStore = createInMemorySecureStore()) {
  const prefs = memoryPrefs();
  const session = createMobileSession({ secureStore, prefs, api });
  return { session, prefs, secureStore };
}

describe('createMobileSession', () => {
  it('adopt persists the refresh token to the keystore and decodes the user id', async () => {
    const api: SessionApi = { refresh: vi.fn() };
    const { session, secureStore } = setup(api);

    await session.adopt(tokens({ accessToken: makeJwt('user_42') }));

    const state = session.store.getState();
    expect(state.status).toBe('authenticated');
    expect(state.userId).toBe('user_42');
    expect(state.accessToken).not.toBeNull();
    expect(await secureStore.getItem(REFRESH_TOKEN_KEY)).toBe('refresh_1');
  });

  it('restore with no stored token settles anonymous without calling the server', async () => {
    const refresh = vi.fn();
    const { session } = setup({ refresh });

    await session.restore();

    expect(session.store.getState().status).toBe('anonymous');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('restore exchanges a stored token and becomes authenticated', async () => {
    const secureStore = createInMemorySecureStore();
    await secureStore.setItem(REFRESH_TOKEN_KEY, 'stored_refresh');
    const refresh = vi.fn((rt: string) =>
      Promise.resolve(tokens({ refreshToken: `${rt}_rotated` })),
    );
    const { session } = setup({ refresh }, secureStore);

    await session.restore();

    expect(refresh).toHaveBeenCalledWith('stored_refresh');
    expect(session.store.getState().status).toBe('authenticated');
    // Rotation persisted the new token.
    expect(await secureStore.getItem(REFRESH_TOKEN_KEY)).toBe('stored_refresh_rotated');
  });

  it('a network error at boot settles anonymous but KEEPS the stored token (offline launch)', async () => {
    const secureStore = createInMemorySecureStore();
    await secureStore.setItem(REFRESH_TOKEN_KEY, 'stored_refresh');
    const refresh = vi.fn(() => Promise.reject(new Error('network down')));
    const { session } = setup({ refresh }, secureStore);

    await session.restore();

    expect(session.store.getState().status).toBe('anonymous');
    // The credential survives so a later online refresh can recover the session.
    expect(await secureStore.getItem(REFRESH_TOKEN_KEY)).toBe('stored_refresh');
  });

  it('a rejected refresh token clears the session AND deletes the stored token', async () => {
    const secureStore = createInMemorySecureStore();
    await secureStore.setItem(REFRESH_TOKEN_KEY, 'stored_refresh');
    const refresh = vi.fn(() => Promise.reject(new SessionExpiredError()));
    const { session } = setup({ refresh }, secureStore);

    await session.restore();

    expect(session.store.getState().status).toBe('anonymous');
    expect(await secureStore.getItem(REFRESH_TOKEN_KEY)).toBeNull();
  });

  it('accessToken returns the cached token without refreshing when it is fresh', async () => {
    const refresh = vi.fn();
    const { session } = setup({ refresh });
    await session.adopt(tokens());

    const token = await session.accessToken();

    expect(token).not.toBeNull();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('accessToken refreshes when the token is expired', async () => {
    const secureStore = createInMemorySecureStore();
    const refresh = vi.fn(() => Promise.resolve(tokens({ accessToken: makeJwt('user_1') })));
    const { session } = setup({ refresh }, secureStore);
    // Adopt an already-expired token, then persist a refresh token to exchange.
    await session.adopt(tokens({ expiresInSeconds: -60 }));

    const token = await session.accessToken();

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(token).not.toBeNull();
  });

  it('concurrent refreshes are single-flight — the token is presented once', async () => {
    const secureStore = createInMemorySecureStore();
    await secureStore.setItem(REFRESH_TOKEN_KEY, 'stored_refresh');
    const refresh = vi.fn(() => Promise.resolve(tokens()));
    const { session } = setup({ refresh }, secureStore);

    await Promise.all([session.refresh(), session.refresh(), session.refresh()]);

    // Rotating refresh tokens: a dozen concurrent presents would look like a
    // stolen-token replay and revoke the whole family. Exactly one exchange.
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('authHeaders carries the bearer and the org header, omitting what is absent', async () => {
    const { session } = setup({ refresh: vi.fn() });

    // Anonymous: no bearer, no org.
    expect(await session.authHeaders()).toEqual({});

    await session.adopt(tokens());
    await session.selectOrg('org_a' as OrgId);
    const headers = await session.authHeaders();

    expect(headers['authorization']).toMatch(/^Bearer /);
    expect(headers[ORG_HEADER]).toBe('org_a');
  });

  it('signOut revokes on the server and clears local state', async () => {
    const secureStore = createInMemorySecureStore();
    const logout = vi.fn(() => Promise.resolve());
    const { session, prefs } = setup({ refresh: vi.fn(), logout }, secureStore);
    await session.adopt(tokens());
    await session.selectOrg('org_a' as OrgId);

    await session.signOut();

    expect(logout).toHaveBeenCalledWith('refresh_1');
    expect(session.store.getState().status).toBe('anonymous');
    expect(session.store.getState().orgId).toBeNull();
    expect(await secureStore.getItem(REFRESH_TOKEN_KEY)).toBeNull();
    expect(await prefs.getItem('taskflow.org')).toBeNull();
  });
});
