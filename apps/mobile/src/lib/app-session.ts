import Constants from 'expo-constants';
import { parseConfig } from './config.js';
import { createSecureStore } from './device-secure-store.js';
import { createPreferences } from './preferences.js';
import { createMobileSession, SessionExpiredError, type MobileSession } from './session.js';
import { createMobileClient, isUnauthenticated, type MobileTRPCClient } from './trpc-client.js';

/**
 * The app's one composition root (ai/phase-14-mobile.md §5, §7) — where the
 * ports built and unit-tested in this directory get their real, device-backed
 * implementations wired together. Everything above this file in `src/lib/`
 * stays injectable and Expo-free on purpose (§11's CI/device split); this file
 * is the seam where that stops, so it is the one module in the spine that
 * cannot be unit-tested without a device or a mocked `expo-constants` — nothing
 * here has logic of its own to test.
 *
 * `Constants.expoConfig.extra` is `app.config.ts`'s `extra.apiBaseUrl`, injected
 * into the already-tested, already-pure `parseConfig`.
 */
const config = parseConfig(Constants.expoConfig?.extra);

/**
 * A second, UNAUTHENTICATED client — mirroring apps/web's own `anonymous`
 * client split in `lib/session.ts` (`const anonymous = createClient()`), and
 * for the identical reason: `session` below needs a `SessionApi` that can call
 * `auth.native.refresh`, and the main client's `authHeaders` calls back into
 * `session.authHeaders()`. Wiring the refresh call through THAT client would be
 * `session -> apiClient -> session`, a construction cycle. This client sends no
 * bearer token, which is correct anyway: `auth.native.refresh` and
 * `auth.native.logout` are `publicRoute`s that take the refresh token as
 * INPUT, not as a header — there is nothing for this client to authenticate.
 */
const anonymousClient = createMobileClient({
  trpcUrl: config.trpcUrl,
  authHeaders: () => Promise.resolve({}),
});

/**
 * The app's one session instance. A module-level singleton rather than
 * `createMobileSession`'s test-only construction pattern, because there is
 * exactly one signed-in identity per running app — unlike `session.ts`, which
 * stays a factory so tests can build as many independent instances as they need.
 */
/**
 * Exported alongside `session`, not just used internally: `(app)/_layout.tsx`
 * needs `readRememberedOrg(prefs)` directly, BEFORE the org gate has anything
 * to validate it against (see that file's own header for why this is a
 * two-step hydration on native and a one-step read on web).
 */
export const prefs = createPreferences();

export const session: MobileSession = createMobileSession({
  secureStore: createSecureStore(),
  prefs,
  api: {
    refresh: async (refreshToken) => {
      try {
        return await anonymousClient.auth.native.refresh.mutate({ refreshToken });
      } catch (error) {
        // Classify tRPC's UNAUTHENTICATED / TOKEN_EXPIRED into the one error
        // session.ts's `refresh()` treats as "sign out"; everything else
        // (a network drop, a 500) must reach `refresh()` as an ordinary
        // rejection so the stored token survives it.
        if (isUnauthenticated(error)) throw new SessionExpiredError();
        throw error;
      }
    },
    logout: async (refreshToken) => {
      await anonymousClient.auth.native.logout.mutate({ refreshToken });
    },
  },
});

/**
 * The app's one authenticated tRPC client. Every screen imports this — never
 * `createMobileClient` directly — the same "one client, headers resolved per
 * request" discipline `apps/web/src/lib/trpc.ts` documents: resolving
 * `session.authHeaders()` fresh on every request is what lets a spent access
 * token refresh itself mid-flight and an org switch take effect on the very
 * next query.
 */
export const apiClient: MobileTRPCClient = createMobileClient({
  trpcUrl: config.trpcUrl,
  authHeaders: () => session.authHeaders(),
});
