import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExpoConfig } from 'expo/config';

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
  version: '0.0.0',
  orientation: 'portrait',
  userInterfaceStyle: 'automatic',
  /* The custom scheme for the OAuth system-browser redirect (§4.4, deferred
     past Wave 1) and any future universal-link fallback. Registered here even
     though nothing consumes it yet — `expo-router`'s deep-link handling reads
     it, and a scheme changed after release breaks every previously-installed
     app's return-from-browser flow. */
  scheme: 'taskflow',
  ios: {
    /* A placeholder reverse-DNS id. MUST be replaced with the real one before
       any build leaves this machine — see §10's "no secret in the bundle"
       checklist, which this line sits right next to in spirit: an id that
       collides with someone else's is a release-time failure, not a runtime
       security one, but it is exactly as easy to ship by accident. */
    bundleIdentifier: 'com.taskflow.app',
    supportsTablet: true,
  },
  android: {
    package: 'com.taskflow.app',
  },
  plugins: ['expo-router'],
  extra: {
    apiBaseUrl: API_BASE_URL,
  },
};

export default config;
