import { z } from 'zod';

/**
 * Mobile runtime configuration, validated at boot (ai/phase-14-mobile.md §5).
 *
 * apps/web reads `import.meta.env` at build time and, in development, proxies
 * `/trpc` so the app is same-origin with the API — which is why the web client
 * never carries an absolute base URL. A phone is never same-origin with
 * anything, so the API base URL is an explicit value that differs per build
 * channel (dev / preview / prod). It is validated the same way the server
 * validates its env: a missing or malformed URL fails immediately and loudly,
 * rather than surfacing later as an opaque network error on the first request.
 *
 * The `raw` source is injected, never read from a global in this module. On a
 * device that source is Expo's `Constants.expoConfig.extra` (wired in the
 * Expo-shell increment); in a test it is a plain object. Keeping the parse pure
 * is what lets the whole config contract be unit-tested with no Expo runtime
 * present — the same testability argument the session store below rests on.
 *
 * NOT `.strict()`, unlike every other schema in this codebase — the exact
 * precedent `apps/api/src/config/env.ts`'s own schema documents for
 * `process.env`. `extra` is not a bag this app fully owns: `app.config.ts`'s
 * own `eas` key (EAS project linkage) and `expo-router`'s own auto-injected
 * `router` key both live in the real `Constants.expoConfig.extra` on every
 * boot, in every environment, `.strict()` here rejected the object outright
 * — `app-session.ts`'s `const config = parseConfig(...)` runs at module top
 * level, so this failure was fatal on EVERY launch from the very first
 * `expo start`, and was invisible behind other bugs until each one that
 * evaluates earlier in the import graph (`device-key`'s and
 * `expo-local-authentication`'s own eager `requireNativeModule` calls — see
 * their own files) got fixed first. A test fixture never saw it because
 * `config.test.ts` hands `parseConfig` a tidy object with only
 * `apiBaseUrl` — precisely the failure mode `env.ts`'s own comment already
 * names. Zod's default (strip unrecognized keys, don't reject them) is what
 * this boundary actually needs.
 */
export const MobileConfigSchema = z.object({
  apiBaseUrl: z.string().url(),
});

export interface MobileConfig {
  /** Origin of the API, with any trailing slash removed. */
  readonly apiBaseUrl: string;
  /**
   * The tRPC endpoint, DERIVED from `apiBaseUrl` rather than configured
   * separately — two independently-set URLs are two things that can disagree.
   */
  readonly trpcUrl: string;
}

/** Parse and normalize raw configuration. Throws on anything invalid. */
export function parseConfig(raw: unknown): MobileConfig {
  const { apiBaseUrl } = MobileConfigSchema.parse(raw);
  const base = apiBaseUrl.replace(/\/+$/, '');
  return { apiBaseUrl: base, trpcUrl: `${base}/trpc` };
}
