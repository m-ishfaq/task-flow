import { createStore, type StoreApi } from 'zustand/vanilla';
import type { OrgId } from '@taskflow/contracts';
import { REFRESH_TOKEN_KEY, type SecureStore } from './secure-store.js';

/**
 * The handset's half of the session (ai/phase-14-mobile.md §4).
 *
 * The server-side identity machinery is reused UNCHANGED — Argon2id, refresh
 * rotation with reuse detection that revokes the whole token family, lockout,
 * revocation. This module is only about where the two tokens live on a phone and
 * how a failure is classified, which is where mobile genuinely differs from the
 * browser.
 *
 * ## Where the two tokens live, and why
 *
 *   ACCESS   in memory only (this store). Same as web: a module's blast radius
 *            under compromise is that process's lifetime, and the token expires
 *            in minutes regardless. Never written to the keystore or to
 *            unencrypted storage.
 *   REFRESH  the platform keystore, via the injected SecureStore (secure-store.ts).
 *            The web's httpOnly `__Host-` cookie has no analogue on a phone, so
 *            hardware-backed storage plus a device-bound token (Wave 1b) are the
 *            compensating controls.
 *
 * ## The native token shape carries the refresh token, and that is the §4.3 point
 *
 * `SessionTokens` INCLUDES `refreshToken`, unlike apps/web's `SessionBody`, which
 * deliberately never carries one because the web keeps it in a cookie the body
 * must not duplicate. On native there is no cookie, so the refresh token arrives
 * in the response body — from a native auth path whose output schema is a
 * SEPARATE object from the browser's `SessionResponse`, so the web path can
 * never acquire the field. That server change is a §2.2 human-review surface and
 * lands in its own increment; this type is the client half of the contract.
 *
 * ## Everything transport-facing is injected
 *
 * `SessionApi` (the token exchange) and `SecureStore` / `Preferences` (storage)
 * are ports, so this store's logic runs under unit tests with no Expo runtime
 * and no live server. The concrete `SessionApi` — built on the tRPC client and
 * the native auth path — wires in later; its only obligation is the error
 * contract below.
 */

/** What a native token exchange returns. Carries the refresh token (§4.3). */
export interface SessionTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresInSeconds: number;
  readonly sessionId: string;
}

/**
 * Thrown by a `SessionApi` when the refresh token itself was REJECTED —
 * expired, revoked, or reuse-detected. It is the one failure that means "this
 * session is over"; the adapter classifies tRPC's UNAUTHENTICATED / TOKEN_EXPIRED
 * into it, exactly as apps/web's narrow `isUnauthenticated` does, so this store
 * never parses a transport error itself. A network drop or a 500 is any OTHER
 * error and must NOT end the session (see `refresh` and `restore`).
 */
export class SessionExpiredError extends Error {
  constructor(message = 'session expired') {
    super(message);
    this.name = 'SessionExpiredError';
  }
}

export interface SessionApi {
  /** Exchange a refresh token for a fresh pair. Throws SessionExpiredError on auth failure. */
  refresh(refreshToken: string): Promise<SessionTokens>;
  /** Best-effort server-side revocation on explicit sign-out. */
  logout?(refreshToken: string): Promise<void>;
}

/** Non-secure key/value storage (the remembered org id — not a credential). */
export interface Preferences {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

const ORG_PREF_KEY = 'taskflow.org';

export type SessionStatus =
  /** Boot has not finished; the stored refresh token has not been exchanged. */
  'restoring' | 'authenticated' | 'anonymous';

export interface SessionState {
  readonly status: SessionStatus;
  readonly accessToken: string | null;
  /** Epoch millis. Null when there is no token. */
  readonly expiresAt: number | null;
  readonly sessionId: string | null;
  /** This user's id, read UNVERIFIED from the access token's `sub` (see decodeUserId). */
  readonly userId: string | null;
  readonly orgId: OrgId | null;
}

export interface MobileSession {
  readonly store: StoreApi<SessionState>;
  /** A usable access token, refreshing if necessary. Null means "not signed in". */
  accessToken(): Promise<string | null>;
  /** Exchange the stored refresh token for a new pair, at most once at a time. */
  refresh(): Promise<string | null>;
  /** Boot-time restore from the keystore. */
  restore(): Promise<void>;
  /** Adopt a freshly minted token pair (from sign-in or a refresh). */
  adopt(tokens: SessionTokens): Promise<void>;
  /** Persist the selected org (non-secure storage). */
  selectOrg(orgId: OrgId | null): Promise<void>;
  /** End the session locally: wipe memory AND delete the keystore token. */
  clear(): Promise<void>;
  /** End the session on the server (best-effort), then locally. */
  signOut(): Promise<void>;
  /** Headers for an authenticated request. Omits what it does not have. */
  authHeaders(): Promise<Record<string, string>>;
}

/** Header the API reads to select the tenant. Must match apps/api/src/tenancy/resolve.ts. */
export const ORG_HEADER = 'x-taskflow-org';

/**
 * Remaining lifetime, in ms, below which an access token is treated as spent.
 * Covers clock skew and the round trip so a token valid at attach time does not
 * expire mid-flight and fail on the server. Same margin as apps/web.
 */
const EXPIRY_MARGIN_MS = 30_000;

/**
 * Reads the `sub` claim out of a JWT, UNVERIFIED. Verification would need the
 * signing key this app never holds and would be pointless: the server verifies
 * the same token on every request this id could influence. Nothing here trusts
 * the value — it exists only so the UI can answer "is this mine?". Returns null
 * for anything that does not parse. Ported verbatim from apps/web/session.ts.
 */
function decodeUserId(accessToken: string): string | null {
  try {
    const segment = accessToken.split('.')[1];
    if (segment === undefined) return null;

    const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
    const claims: unknown = JSON.parse(atob(padded));

    if (typeof claims !== 'object' || claims === null) return null;
    const sub = (claims as Record<string, unknown>)['sub'];
    return typeof sub === 'string' ? sub : null;
  } catch {
    return null;
  }
}

export interface SessionDeps {
  readonly secureStore: SecureStore;
  readonly prefs: Preferences;
  readonly api: SessionApi;
}

/**
 * Builds a session bound to concrete storage and a token-exchange transport.
 * A factory rather than apps/web's module singleton so the whole thing is
 * constructible in a test with in-memory ports.
 */
export function createMobileSession(deps: SessionDeps): MobileSession {
  const { secureStore, prefs, api } = deps;

  const store = createStore<SessionState>(() => ({
    status: 'restoring',
    accessToken: null,
    expiresAt: null,
    sessionId: null,
    userId: null,
    orgId: null,
  }));

  /**
   * Single-flight, exactly as apps/web. Refresh tokens rotate with reuse
   * detection, so a screen firing a dozen queries against an expired access
   * token must present the ONE stored refresh token once — not a dozen times,
   * where the first rotates it and the rest look like a stolen-token replay and
   * revoke the whole family.
   */
  let inFlight: Promise<string | null> | null = null;

  async function adopt(tokens: SessionTokens): Promise<void> {
    // The refresh token goes to the keystore FIRST: if that write fails we have
    // not yet told the store it is authenticated, so we fail closed rather than
    // holding a session whose refresh token was never persisted.
    await secureStore.setItem(REFRESH_TOKEN_KEY, tokens.refreshToken);
    store.setState({
      status: 'authenticated',
      accessToken: tokens.accessToken,
      expiresAt: Date.now() + tokens.expiresInSeconds * 1000,
      sessionId: tokens.sessionId,
      userId: decodeUserId(tokens.accessToken),
    });
  }

  /** Reset to anonymous WITHOUT touching the keystore (see restore's offline case). */
  function settleAnonymous(): void {
    store.setState({
      status: 'anonymous',
      accessToken: null,
      expiresAt: null,
      sessionId: null,
      userId: null,
    });
  }

  async function clear(): Promise<void> {
    await secureStore.deleteItem(REFRESH_TOKEN_KEY);
    await prefs.removeItem(ORG_PREF_KEY);
    store.setState({
      status: 'anonymous',
      accessToken: null,
      expiresAt: null,
      sessionId: null,
      userId: null,
      orgId: null,
    });
  }

  async function refresh(): Promise<string | null> {
    inFlight ??= (async () => {
      try {
        const refreshToken = await secureStore.getItem(REFRESH_TOKEN_KEY);
        if (refreshToken === null) {
          settleAnonymous();
          return null;
        }
        const tokens = await api.refresh(refreshToken);
        await adopt(tokens);
        return tokens.accessToken;
      } catch (error) {
        /* Only a rejected refresh token means "signed out". A network drop or a
           500 must leave the stored token ALONE — on a phone an offline launch
           is routine, and deleting the credential there would strand the user
           until re-login for the crime of opening the app on a train. That is
           why this catch deletes nothing except on SessionExpiredError. */
        if (error instanceof SessionExpiredError) await clear();
        return null;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  async function accessToken(): Promise<string | null> {
    const { accessToken: token, expiresAt } = store.getState();
    if (token !== null && expiresAt !== null && expiresAt - Date.now() > EXPIRY_MARGIN_MS) {
      return token;
    }
    return refresh();
  }

  async function restore(): Promise<void> {
    const token = await refresh();
    /* On failure there is nothing to preserve, but there is also nothing to
       throw away: `refresh` has already cleared the session if the token was
       rejected, and left it intact on a network error. Either way, settle to a
       renderable state so boot does not hang on the splash — WITHOUT deleting a
       token that an offline launch could not exchange. */
    if (token === null && store.getState().status === 'restoring') settleAnonymous();
  }

  async function selectOrg(orgId: OrgId | null): Promise<void> {
    if (orgId === null) await prefs.removeItem(ORG_PREF_KEY);
    else await prefs.setItem(ORG_PREF_KEY, orgId);
    store.setState({ orgId });
  }

  async function signOut(): Promise<void> {
    try {
      const refreshToken = await secureStore.getItem(REFRESH_TOKEN_KEY);
      if (refreshToken !== null && api.logout !== undefined) await api.logout(refreshToken);
    } finally {
      // Local state is cleared even if the server call failed. A client that
      // believes it is signed out while still holding a token is the worse
      // outcome; visible state must never overstate what is still live.
      await clear();
    }
  }

  async function authHeaders(): Promise<Record<string, string>> {
    const token = await accessToken();
    const { orgId } = store.getState();
    return {
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...(orgId === null ? {} : { [ORG_HEADER]: orgId }),
    };
  }

  return {
    store,
    accessToken,
    refresh,
    restore,
    adopt,
    selectOrg,
    clear,
    signOut,
    authHeaders,
  };
}

/** Hydrate the remembered org id from preferences (validated by the org gate before use). */
export async function readRememberedOrg(prefs: Preferences): Promise<string | null> {
  return prefs.getItem(ORG_PREF_KEY);
}
