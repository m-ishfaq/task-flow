import { create } from 'zustand';
import type { OrgId } from '@taskflow/contracts';
import { createClient, isUnauthenticated } from './trpc-client.js';

/**
 * The browser's half of the session (PLAN.md §8.1).
 *
 * ## Where the two tokens live, and why they live there
 *
 * The API issues a PAIR, and splitting them is the entire defence:
 *
 *   REFRESH  httpOnly `__Host-` cookie. Script cannot read it. It never appears
 *            in this file, in any store, or in any response body — the API's
 *            `.strict()` output schema is what keeps it out (see
 *            apps/api/src/identity/session-response.ts).
 *   ACCESS   this store, IN MEMORY ONLY, and never localStorage or
 *            sessionStorage.
 *
 * The access token in memory is not a small preference. `localStorage` is
 * readable by any script that runs on the page, survives the tab closing, and is
 * shared across tabs — so one XSS is a token an attacker keeps. In a module
 * variable, the blast radius of the same XSS is the lifetime of that tab, and
 * the token expires in minutes regardless.
 *
 * The cost is real and accepted: a page reload has no access token. Boot calls
 * `restore()`, which exchanges the cookie for a fresh one. That is a request on
 * every load, and it is the price of not storing a credential where script can
 * read it.
 *
 * ## Why refreshing is single-flight
 *
 * Refresh tokens ROTATE, and the API detects reuse: presenting a token that has
 * already been exchanged revokes the entire session family, because that is what
 * a stolen-and-replayed token looks like (Phase 1, identity.service.ts).
 *
 * A board opening fires a dozen queries at once. If each noticed an expired
 * access token and called `auth.refresh`, they would all present the SAME cookie
 * — the first rotates it, the rest are replays, and the user is signed out of
 * every device for the crime of loading a page. `inFlight` below is what makes
 * that impossible: concurrent callers await one exchange.
 */

/** The org header the API reads. Must match apps/api/src/tenancy/resolve.ts. */
export const ORG_HEADER = 'x-taskflow-org';

/**
 * Where the selected org is remembered between visits.
 *
 * Safe to persist because it is not a credential and confers nothing: the header
 * it becomes is attacker-controlled by design and is used as a WHERE filter
 * against the caller's own memberships, never as a value written to
 * `app.org_id`. Naming an org you are not in resolves to no membership and every
 * permission-bearing route answers NOT_A_MEMBER.
 *
 * Safe is not the same as CORRECT, and the difference is a real bug this file
 * used to have. The value outlives the session that chose it — it is read at
 * module load, before anyone has signed in — so a database reset, an account
 * removed from an org, or simply a second person signing in at the same browser
 * leaves a stored id that names an org the current caller is not in. The router
 * guard only asks whether an org is SELECTED, so that stale id sailed through to
 * `/projects` and every query on the page answered NOT_A_MEMBER. Signing out was
 * the only thing that cleared it, which is why the failure appeared exactly once
 * and never again.
 *
 * Two things now stop that. `OrgGate` validates the stored id against
 * `tenancy.orgs.list` — the one query that needs no org — before the router
 * renders anything, and `clear()` below drops it whenever the session ends by
 * ANY route rather than only through the sign-out button.
 */
const ORG_STORAGE_KEY = 'taskflow.org';

export type SessionStatus =
  /** Boot has not finished; the cookie has not been exchanged yet. */
  'restoring' | 'authenticated' | 'anonymous';

interface SessionState {
  readonly status: SessionStatus;
  readonly accessToken: string | null;
  /** Epoch millis. Null when there is no token. */
  readonly expiresAt: number | null;
  readonly sessionId: string | null;
  readonly orgId: OrgId | null;
  /**
   * The address this session signed in with, when it is known.
   *
   * Used to pre-fill the step-up prompt, which has to present a credential again
   * (§8.1) and should not make someone retype their own address.
   *
   * IN MEMORY ONLY, and deliberately not persisted beside `orgId`: an email in
   * localStorage tells the next person at a shared machine who was last here,
   * which the org id does not. So it is null after a reload — the prompt asks
   * for it, and one extra field is a better trade than leaving an identifier on
   * disk.
   *
   * Null after `restore()` for that reason, since a refresh carries no email.
   */
  readonly email: string | null;
}

interface SessionActions {
  readonly adopt: (body: SessionBody, email?: string) => void;
  readonly clear: () => void;
  readonly selectOrg: (orgId: OrgId | null) => void;
}

export interface SessionBody {
  readonly accessToken: string;
  readonly expiresInSeconds: number;
  readonly sessionId: string;
}

function storedOrg(): OrgId | null {
  try {
    const value = window.localStorage.getItem(ORG_STORAGE_KEY);
    return value === null || value === '' ? null : (value as OrgId);
  } catch {
    // Private browsing and blocked storage both throw here. An org selection
    // that does not survive a reload is a worse experience, not a broken app.
    return null;
  }
}

function storeOrg(orgId: OrgId | null): void {
  try {
    if (orgId === null) window.localStorage.removeItem(ORG_STORAGE_KEY);
    else window.localStorage.setItem(ORG_STORAGE_KEY, orgId);
  } catch {
    // See storedOrg(): storage being unavailable must not stop the switch.
  }
}

export const useSession = create<SessionState & SessionActions>((set) => ({
  status: 'restoring',
  accessToken: null,
  expiresAt: null,
  sessionId: null,
  orgId: storedOrg(),
  email: null,

  adopt: (body, email) => {
    set({
      status: 'authenticated',
      accessToken: body.accessToken,
      expiresAt: Date.now() + body.expiresInSeconds * 1000,
      sessionId: body.sessionId,
      // Only set when the caller knows it. A refresh does not, and must not
      // erase what a sign-in recorded.
      ...(email === undefined ? {} : { email }),
    });
  },

  /**
   * Ends the session locally.
   *
   * The org selection goes with it, and that is the fix for a gap rather than
   * tidiness. Only `signOut` used to clear the stored org, so every OTHER way a
   * session ends — an expired refresh cookie, reuse detection revoking the
   * family, closing the tab — left an org id in storage for whoever signed in
   * next. Clearing here means "no session" and "no org" cannot disagree.
   *
   * Reached only on an authentication failure (see `refresh`), never on a
   * network blip, so this does not throw away a selection over a dropped
   * request.
   */
  clear: () => {
    storeOrg(null);
    set({
      status: 'anonymous',
      accessToken: null,
      expiresAt: null,
      sessionId: null,
      orgId: null,
      email: null,
    });
  },

  selectOrg: (orgId) => {
    storeOrg(orgId);
    set({ orgId });
  },
}));

/**
 * A client with no credentials, used only to exchange the refresh cookie.
 *
 * Separate from the authenticated client in `trpc.ts` because that one asks this
 * module for a token, and a client here that asked back would be a cycle. It is
 * also the honest description of the call: `auth.refresh` is a `publicRoute` —
 * the access token it renews may already have expired, so it cannot require one.
 */
const anonymous = createClient();

/**
 * Seconds of remaining lifetime below which a token is treated as spent.
 *
 * Not zero. A token that expires while a request is in flight fails on the
 * server, and the user sees an error for a token that was valid when it was
 * attached. The margin has to cover clock skew between this browser and the API
 * as well as the round trip.
 */
const EXPIRY_MARGIN_MS = 30_000;

let inFlight: Promise<string | null> | null = null;

/**
 * Returns a usable access token, exchanging the refresh cookie if necessary.
 *
 * Null means "not signed in" — which is a normal answer, not a failure: the
 * login page calls the API too.
 */
export async function accessToken(): Promise<string | null> {
  const { accessToken: token, expiresAt } = useSession.getState();
  if (token !== null && expiresAt !== null && expiresAt - Date.now() > EXPIRY_MARGIN_MS) {
    return token;
  }
  return refresh();
}

/**
 * Exchanges the refresh cookie for a new token pair, at most once at a time.
 *
 * The single-flight promise is the point of this function — see the header
 * comment. It is cleared in `finally` so a later expiry can start a new
 * exchange; leaving it set would cache a failure forever and a signed-in user
 * would never recover from one dropped request.
 */
export async function refresh(): Promise<string | null> {
  inFlight ??= (async () => {
    try {
      const body = await anonymous.auth.refresh.mutate();
      useSession.getState().adopt(body);
      return body.accessToken;
    } catch (error) {
      /* Only an authentication failure means "signed out". A network drop or a
         500 must leave the session alone: clearing it there would sign the user
         out of a working session because the wifi blinked, and the access token
         they still hold may well outlive the outage. */
      if (isUnauthenticated(error)) useSession.getState().clear();
      return null;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

/**
 * Boot-time session restore.
 *
 * Distinct from `refresh()` only in what it does with a failure: on first load
 * there is no session to preserve, so anything other than success settles the
 * status to `anonymous` and the app renders the login page instead of a spinner
 * that never resolves.
 */
export async function restore(): Promise<void> {
  const token = await refresh();
  if (token === null) useSession.getState().clear();
}

/** Ends the session on the server, then locally whatever the server said. */
export async function signOut(): Promise<void> {
  try {
    await anonymous.auth.logout.mutate();
  } finally {
    /* Local state is cleared even if the call failed. A client that believes it
       is signed out while still holding a token in memory is the worse of the
       two outcomes — the visible state must never overstate what is still live.
       `clear()` drops the stored org too, so there is nothing to add here. */
    useSession.getState().clear();
  }
}

/** Headers for an authenticated request. Omits what it does not have. */
export async function authHeaders(): Promise<Record<string, string>> {
  const token = await accessToken();
  const { orgId } = useSession.getState();

  return {
    ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    ...(orgId === null ? {} : { [ORG_HEADER]: orgId }),
  };
}
