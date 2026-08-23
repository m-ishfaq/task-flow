import Constants from 'expo-constants';
import { parseConfig } from './config.js';
import { createSecureStore } from './device-secure-store.js';
import { createDeviceKey } from './device-key.native.js';
import { createBiometricGate } from './biometric-gate.native.js';
import { createPreferences } from './preferences.js';
import { createMobileSession, SessionExpiredError, type MobileSession } from './session.js';
import { createMobileSocket, type MobileSocket } from './socket.js';
import { createMobileChatSocket, type MobileChatSocket } from './chat-socket.js';
import { createMobileRtcSocket, type MobileRtcSocket } from './rtc-socket.js';
import { createMobileClient, isUnauthenticated, type MobileTRPCClient } from './trpc-client.js';
import type { BiometricGate } from './biometric-gate.js';

/**
 * The app's one composition root (ai/phase-14-mobile.md §5, §7, §8) — where
 * the ports built and unit-tested in this directory get their real,
 * device-backed implementations wired together. Everything above this file
 * in `src/lib/` stays injectable and Expo-free on purpose (§11's CI/device
 * split); this file is the seam where that stops, so it is the one module in
 * the spine that cannot be unit-tested without a device or a mocked
 * `expo-constants` — nothing here has logic of its own to test.
 *
 * `Constants.expoConfig.extra` is `app.config.ts`'s `extra.apiBaseUrl`/
 * `extra.realtimeBaseUrl`, injected into the already-tested, already-pure
 * `parseConfig` — see `config.ts`'s own header on why the sockets below
 * dial `config.realtimeBaseUrl` rather than `config.apiBaseUrl` directly.
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

/**
 * The biometric app-lock's one gate (§4.4). Exported alongside `session` for
 * the same reason `prefs` is: `_layout.tsx` needs it directly, ABOVE
 * `session.restore()` — see `biometric-gate.ts`'s own header for why this
 * lives outside `session.ts` entirely rather than as one of its deps.
 */
export const biometricGate: BiometricGate = createBiometricGate();

export const session: MobileSession = createMobileSession({
  secureStore: createSecureStore(),
  prefs,
  deviceKey: createDeviceKey(),
  api: {
    refresh: async (refreshToken, deviceSignature) => {
      try {
        return await anonymousClient.auth.native.refresh.mutate({
          refreshToken,
          ...(deviceSignature === undefined ? {} : { deviceSignature }),
        });
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
    /**
     * Device binding (§4.5). `apiClient` — not `anonymousClient` — because
     * `auth.native.deviceKey.register` is a `selfRoute`: it needs the bearer
     * this session JUST adopted, which `apiClient`'s `authHeaders` resolves
     * by calling back into `session.authHeaders()`. Referencing `apiClient`
     * here, before its own `const` below has run, is safe: this function
     * only ever executes later, from `session.adopt()`, by which point the
     * whole module has finished loading — the same lazy-reference pattern
     * `gatewaySocket.onSessionEnded` uses in the other direction.
     */
    registerDeviceKey: async (publicKey) => {
      await apiClient.auth.native.deviceKey.register.mutate({ publicKey });
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

/**
 * The app's one realtime connection (§8). No Wave 1 screen opens a board yet
 * — home is a placeholder (§7) — so nothing calls `gatewaySocket.joinBoardRoom`
 * today; it is wired here anyway, alongside `session` and `apiClient`, so the
 * spine is complete and testable at the composition level rather than
 * something a later wave has to remember to assemble correctly under time
 * pressure. `getExpiresAt` reads the store fresh on every call, never once at
 * construction, so a renewed token reschedules `ready`'s reauth correctly.
 */
export const gatewaySocket: MobileSocket = createMobileSocket({
  apiBaseUrl: config.realtimeBaseUrl,
  accessToken: () => session.accessToken(),
  getExpiresAt: () => session.store.getState().expiresAt,
  onSessionEnded: () => {
    void session.clear();
  },
});

/**
 * The app's one `/chat` namespace connection (Chat, live: typing indicators
 * + broadcast-driven refresh). A second socket instance, not a second
 * transport — see `chat-socket.ts`'s own header, including why this one
 * takes no `onSessionEnded`: `gatewaySocket`'s own listener above is what
 * clears the session.
 */
export const chatSocket: MobileChatSocket = createMobileChatSocket({
  apiBaseUrl: config.realtimeBaseUrl,
  accessToken: () => session.accessToken(),
  getExpiresAt: () => session.store.getState().expiresAt,
});

/**
 * The app's one `/rtc` namespace connection — in-app voice signalling
 * (Phase 13, Wave 5 here). A third socket instance, not a third transport
 * — see `rtc-socket.ts`'s own header, and `chat-socket.ts`'s identical
 * note on why this also takes no `onSessionEnded`: `gatewaySocket`'s own
 * listener above is what clears the session.
 */
export const rtcSocket: MobileRtcSocket = createMobileRtcSocket({
  apiBaseUrl: config.realtimeBaseUrl,
  accessToken: () => session.accessToken(),
  getExpiresAt: () => session.store.getState().expiresAt,
});
