import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExpoConfig } from 'expo/config';

/**
 * `colors.surface.hex` from `@taskflow/tokens`, copied rather than imported
 * — tried the import first, and it breaks `expo config`/`expo export`/
 * `eas build` outright: `Cannot find module '.../colors.js' imported from
 * .../index.ts`. Expo's config loader runs `app.config.ts` through Node's
 * OWN ESM resolution, a different execution context from Metro (which has
 * this file's own custom `.js`→`.ts` rewrite next door in
 * `metro.config.js`) and from `tsc`/Vitest (NodeNext `moduleResolution`) —
 * neither of which extends to a workspace package's NodeNext-style
 * `./colors.js` re-export the way this repo writes every internal import.
 * A value this unlikely to change is a cheap enough copy; if it drifts,
 * `packages/tokens/src/colors.test.ts` (or a visual check against a real
 * build) is what would catch it, not a compiler.
 */
const STATUS_BAR_BACKGROUND = '#0d1117';

/**
 * Expo config (ai/phase-14-mobile.md §5, §10).
 *
 * A `.ts` file rather than a static `app.json`, for the same reason apps/web's
 * `vite.config.ts` reads `process.env` directly instead of going through the
 * validated Zod schema in `apps/api/src/config`: this runs in Node, at build
 * time, on the machine invoking the Expo CLI / EAS — never on the device — so
 * guardrail 3's ban on bare `process.env` (which targets application runtime
 * code) does not apply here any more than it applies to `vite.config.ts`.
 *
 * `MOBILE_API_BASE_URL` is what `src/lib/config.ts` receives as
 * `Constants.expoConfig.extra.apiBaseUrl` at runtime, validated there with the
 * same "fail loudly at boot" discipline the server's own env schema uses. The
 * default below is deliberately not "correct" for a physical device — a phone
 * cannot reach the host machine's `localhost` — it exists so a missing
 * environment variable fails at `parseConfig` with a clear message instead of
 * every request silently going nowhere. Real runs (simulator, physical device,
 * EAS build channel) set it explicitly; see the README for the three cases.
 */

/* The repo-root .env — the same file every other app in this monorepo loads
   (vite.config.ts's own comment explains why in full). The Expo CLI has its
   OWN `.env` auto-loading, but it looks in THIS PACKAGE's directory
   (apps/mobile/.env), not the repo root, so relying on it would silently miss
   the one .env file this codebase actually uses and MOBILE_API_BASE_URL would
   always fall through to the loopback default below. `process.loadEnvFile`
   follows --env-file semantics: a variable already set on process.env wins,
   so a shell export still beats the file. */
const envFile = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '.env');
if (existsSync(envFile)) {
  process.loadEnvFile(envFile);
}

const API_BASE_URL = process.env['MOBILE_API_BASE_URL'] ?? 'http://localhost:3000';

/* Per-developer Firebase config for push (§9) — gitignored, never committed.
   See the `android`/`ios` blocks below for why each is wired in only when
   present, and push-notifications.ts's header for the service-account key
   these are NOT (that one goes to `eas credentials`, never a file here). */
const GOOGLE_SERVICES_JSON = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'google-services.json',
);
const GOOGLE_SERVICE_INFO_PLIST = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'GoogleService-Info.plist',
);

/* Optional, unlike API_BASE_URL above — no loopback default to fail loudly
   against, because "unset" is a legitimate, common state: apps/web's own
   `vite.config.ts` needs the identical split (`WEB_API_ORIGIN` /
   `WEB_REALTIME_ORIGIN`, defaulting to :3000/:3001) because apps/api and
   apps/realtime are two separate local-dev processes on two separate ports,
   while a real deployment typically fronts both behind one public origin —
   the same origin `apiBaseUrl` already names. `config.ts`'s `parseConfig`
   is what encodes "falls back to apiBaseUrl when unset" as the actual
   default; leaving it undefined here rather than guessing a `:3001` origin
   the way `WEB_REALTIME_ORIGIN` does is deliberate — this value backs THREE
   socket connections (`gatewaySocket`, `chatSocket`, `rtcSocket`), all real
   servers in production, so a wrong-but-plausible default here would fail
   silently (a socket that never connects reads identically to "realtime is
   slow") exactly the failure mode this file's own comment on
   `MOBILE_API_BASE_URL` for preview/production already argues against. */
const REALTIME_BASE_URL = process.env['MOBILE_REALTIME_BASE_URL'];

/* Same shape and reasoning as REALTIME_BASE_URL above — `apps/collab` is a
   THIRD separate local-dev process/port (`COLLAB_PORT`), fronted by the
   same one public origin in a real deployment. Backs `use-doc-page.ts`'s
   one Hocuspocus connection. */
const COLLAB_BASE_URL = process.env['MOBILE_COLLAB_BASE_URL'];

const config: ExpoConfig = {
  name: 'TaskFlow',
  slug: 'taskflow',
  /* The EAS account this project's builds belong to — paired with
     `extra.eas.projectId` below. Not a secret, same reasoning: it is a
     public identifier (the project's own dashboard URL already carries it),
     not a credential. */
  owner: 'm.1shfaq',
  version: '0.0.0',
  orientation: 'portrait',
  userInterfaceStyle: 'automatic',
  /* The custom scheme the OAuth system-browser redirect returns to (§4.4;
     `src/lib/oauth.ts`'s `OAUTH_REDIRECT_URL`) and any future universal-link
     fallback. `expo-router`'s deep-link handling reads it, and a scheme
     changed after release breaks every previously-installed app's
     return-from-browser flow. */
  scheme: 'taskflow',
  /* The TaskFlow flow-mark (`apps/web/src/components/taskflow-logo.tsx` /
     `apps/web/public/favicon.svg`'s three-node design), rendered to a 1024x1024
     PNG on the app's own dark surface color rather than left transparent —
     iOS composites the app icon on an opaque backing regardless, so an
     icon authored WITHOUT one gets an arbitrary black or white fill picked
     for you, not transparency. `android.adaptiveIcon` below is the
     Android-specific masked variant of the same mark. */
  icon: './assets/icon.png',
  /* Android and iOS only, explicit rather than left to Expo's own default
     (`['ios', 'android', 'web']`). A `web` target left implicit is exactly
     the kind of gap this codebase argues against elsewhere — nothing in
     `app/` or `src/lib/` has ever been written with a browser target in
     mind, `apps/web` already owns that surface, and `expo export`'s web
     bundle pulls in a different code path than ios/android (found while
     verifying this app actually bundles, ai/phase-14-mobile.md §11). */
  platforms: ['ios', 'android'],
  ios: {
    /* A placeholder reverse-DNS id. MUST be replaced with the real one before
       any build leaves this machine — see §10's "no secret in the bundle"
       checklist, which this line sits right next to in spirit: an id that
       collides with someone else's is a release-time failure, not a runtime
       security one, but it is exactly as easy to ship by accident. */
    bundleIdentifier: 'com.taskflow.app',
    supportsTablet: true,
    /* Passkeys (§4.4) need this ENTITLEMENT present before the ceremony can
       even start, but the entitlement alone does nothing without the domain
       below ALSO hosting `.well-known/apple-app-site-association` — a
       `webcredentials` AASA file naming `<AppleTeamID>.com.taskflow.app`.
       That server-side file is the remaining step: this config points iOS at
       the domain, the AASA file on the domain points back at this app, and
       passkeys only work once BOTH sides agree. See the README's "Passkeys"
       section for the full checklist. */
    associatedDomains: ['webcredentials:taskflow-demo.duckdns.org'],
    ...(existsSync(GOOGLE_SERVICE_INFO_PLIST)
      ? { googleServicesFile: './GoogleService-Info.plist' }
      : {}),
  },
  android: {
    package: 'com.taskflow.app',
    /* The masked variant `icon` above needs on Android: a FOREGROUND layer
       only, transparent background, scaled well inside the ~66% safe zone
       the OS mask crops to (a full-bleed foreground gets clipped to a
       circle/squircle/rounded-square depending on the launcher, cutting
       off the outer nodes of the mark) — `backgroundColor` is a flat fill
       behind it, the same dark surface color as `icon.png`'s own
       background, so the two render identically wherever the OS shows one
       or the other. */
    adaptiveIcon: {
      foregroundImage: './assets/adaptive-icon-foreground.png',
      backgroundColor: STATUS_BAR_BACKGROUND,
    },
    /* Push notifications (§9, push-notifications.ts's own header on "code
       complete, infrastructure not"): `expo-notifications` needs this file
       present for Expo's prebuild to apply the `google-services` Gradle
       plugin FCM reads at runtime — without it, `getExpoPushTokenAsync`
       fails on Android regardless of EAS credentials being configured.
       Not committed (see .gitignore) — it is account-specific config, not
       source, the same reasoning as `apps/mobile/android/` itself being
       generated rather than checked in. Wired in ONLY when present so a
       checkout with no Firebase project configured still builds; the file
       comes from Firebase Console (Project settings -> your Android app),
       never from `eas credentials` — that command is for the SEPARATE
       service-account key, which is a real secret and never belongs in a
       file this config references, committed or not. */
    ...(existsSync(GOOGLE_SERVICES_JSON) ? { googleServicesFile: './google-services.json' } : {}),
    /* `adjustResize` makes Android resize the window when the software
       keyboard appears, pushing bottom-sheet modals above it instead of
       covering the input field. `adjustPan` (the default) scrolls the
       whole window up, which leaves the keyboard overlapping sheets opened
       via Modal — the exact bug this fixes in project/[projectId].tsx. */
    softwareKeyboardLayoutMode: 'resize',
  },
  /* Found live: on Android, this app's default TRANSLUCENT status bar let
     scrolled content render visibly underneath the clock/battery icons —
     confirmed on a real device (a heading scrolled half-behind the status
     bar). `paddingTop` alone cannot fix this: it only sets where content
     STARTS, and unbounded scrolling moves it past that point regardless of
     how much padding there is. An OPAQUE status bar is what actually
     prevents it, by construction, no matter how far anything scrolls —
     `translucent: false` plus a background matching the app's own dark
     surface (`@taskflow/tokens`, the same color every screen already uses)
     rather than Android's own default. `useSafeAreaInsets()`-based padding
     (the screens that had `paddingTop: 24` hardcoded) is the other half —
     this makes the bar solid; that keeps content clear of it in the first
     place. Requires a native rebuild to take effect, the same as any other
     `app.config.ts` change — `expo start`'s JS-only reload cannot show
     this working. */
  androidStatusBar: {
    backgroundColor: STATUS_BAR_BACKGROUND,
    barStyle: 'light-content',
    translucent: false,
  },
  /* EAS Update's own linkage, paired with extra.eas.projectId below — same
     "dynamic config can't be auto-written" reason as that field. `policy:
     "appVersion"` ties a published update's runtime compatibility to this
     file's own `version`, rather than a separately-tracked fingerprint, so a
     build stays the honest source of truth for what it can receive. Nothing
     is actually published yet (no product surface exists to update, per the
     app's own README) — this is the linkage EAS's build step itself
     requires to exist before it will produce a build at all. */
  updates: {
    url: 'https://u.expo.dev/b3129211-ec7b-4cca-ab67-6c39a32095cf',
  },
  runtimeVersion: {
    policy: 'appVersion',
  },
  plugins: [
    'expo-router',
    /* Android refuses plaintext `http://` outright by default since API 28
       (Network Security Config's base config has `cleartextTrafficPermitted
       = false`) — a RESTRICTION, not an absence of one, so there is nothing
       to opt into for HTTPS. The React Native template's own generated
       manifest only sets `android:usesCleartextTraffic="true"` in the
       DEBUG variant; a release build (`assembleRelease`, what an installed
       APK actually runs) inherits the strict default and drops every
       request at the OS layer before it reaches this app's own network
       code — no exception thrown, nothing in `adb logcat` naming this app,
       and correspondingly nothing in the API server's log, because the
       request never leaves the device. Found exactly that way testing a
       release build against a local API over `adb reverse`.

       Gated on the URL actually being `http://`, not unconditionally
       `true` — the one deployment shape that needs this is local/LAN
       testing (`MOBILE_API_BASE_URL=http://localhost:3000` or a LAN IP);
       `eas.json`'s `production` profile has no default and every real
       value for it is an `https://` origin, which never sets this flag.
       A blanket `usesCleartextTraffic: true` would permit plaintext to ANY
       host from a shipped production build, not just this app's own API. */
    [
      'expo-build-properties',
      {
        android: {
          usesCleartextTraffic: API_BASE_URL.startsWith('http://'),
        },
      },
    ],
    /* Android's status bar renders a notification icon as a WHITE SILHOUETTE
       on transparent, regardless of what color the source PNG actually is
       (a full-color icon there just shows as a white blob) — this is a
       SEPARATE asset from `icon`/`adaptiveIcon` above for exactly that
       reason, not a duplicate. `color` is the background tint Android
       applies behind it in the notification shade; matches this app's own
       dark surface color rather than Android's default. iOS has no
       equivalent concept (its notification icon is just the app icon), so
       this plugin is a no-op there — nothing further to configure. */
    [
      'expo-notifications',
      { icon: './assets/notification-icon.png', color: STATUS_BAR_BACKGROUND },
    ],
    /* iOS refuses Face ID outright with no NSFaceIDUsageDescription in
       Info.plist — not a soft failure, the ceremony never even starts
       (§4.4's biometric app-lock). Android has no equivalent string to set;
       the plugin is a no-op there. */
    ['expo-local-authentication', { faceIDPermission: 'Unlock TaskFlow with Face ID.' }],
    /* In-app voice calling (Phase 13, Wave 5 here). `react-native-webrtc`
       ships real native code — Expo Go can never run it — and this
       community plugin is what wires it into a config-plugin/dev-client
       build without ejecting to bare. The mic string is real: this app
       calls `getUserMedia({ audio: true, video: false })` and nothing
       else. The camera string is NOT — the plugin requests
       `NSCameraUsageDescription`/`CAMERA` unconditionally, for every app
       that uses it, whether or not video is ever captured; Wave 3 (video)
       will make it true, and until then it is a declared-but-unused
       permission rather than a runtime prompt nobody would see (iOS/Android
       both only prompt when code actually opens the camera, which this app
       never does). Named here rather than silently accepted, the same
       "documented trade, not a hidden one" standard this file already sets
       for the passkeys entitlement above. */
    [
      '@config-plugins/react-native-webrtc',
      {
        microphonePermission: 'TaskFlow uses your microphone for voice calls.',
        cameraPermission: 'TaskFlow will use your camera for video calls in a future update.',
      },
    ],
    /* Native CallKit (iOS) / ConnectionService (Android) — `call-keep.ts`'s
       own header explains the feature and its real scope (the app-process-
       alive case; waking a killed app is separate, not-yet-built work).
       This plugin does exactly three things, all inspectable in its own
       source (`@config-plugins/react-native-callkeep`'s `withCallkeep.js`):
       adds `voip` to iOS's `UIBackgroundModes` and links `CallKit`/`Intents`
       .framework, and on Android adds the phone/call-management permissions
       plus the two services (`VoiceConnectionService`, a background
       messaging service) `react-native-callkeep`'s native module needs
       registered in the manifest. It does NOT wire PushKit/VoIP-push
       AppDelegate code — that is a real, separate, manual native step this
       app does not need yet, since nothing sends a VoIP push. */
    '@config-plugins/react-native-callkeep',
  ],
  extra: {
    apiBaseUrl: API_BASE_URL,
    ...(REALTIME_BASE_URL === undefined ? {} : { realtimeBaseUrl: REALTIME_BASE_URL }),
    ...(COLLAB_BASE_URL === undefined ? {} : { collabBaseUrl: COLLAB_BASE_URL }),
    /* EAS project linkage — not a secret per §10's own public/private test.
       A project id identifies which EAS project a build belongs to, nothing
       more, and is already visible in the Expo dashboard's URL for anyone
       with project access. `eas build` needs this to know which cloud
       project a build targets; a DYNAMIC config (this file) is the one case
       EAS's own `eas init` cannot write it into automatically, unlike a
       static app.json, so it is set here by hand instead. */
    eas: {
      projectId: 'b3129211-ec7b-4cca-ab67-6c39a32095cf',
    },
  },
};

export default config;
