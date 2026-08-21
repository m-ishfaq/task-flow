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
       even start, but the entitlement alone does nothing without a real
       domain hosting `.well-known/apple-app-site-association` naming this
       app's team + bundle id — see the README's "Passkeys" section for the
       full checklist. Obviously-invalid placeholder rather than a
       plausible-looking one, matching eas.json's own MOBILE_API_BASE_URL
       precedent: a wrong-but-real-looking domain fails silently (the
       ceremony just never completes, indistinguishable from "not
       configured yet"); this fails loudly the moment anyone tries it. */
    associatedDomains: ['webcredentials:SET-REAL-DOMAIN-BEFORE-PASSKEYS-WORK.invalid'],
  },
  android: {
    package: 'com.taskflow.app',
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
    /* iOS refuses Face ID outright with no NSFaceIDUsageDescription in
       Info.plist — not a soft failure, the ceremony never even starts
       (§4.4's biometric app-lock). Android has no equivalent string to set;
       the plugin is a no-op there. */
    ['expo-local-authentication', { faceIDPermission: 'Unlock TaskFlow with Face ID.' }],
  ],
  extra: {
    apiBaseUrl: API_BASE_URL,
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
