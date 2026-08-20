/**
 * OAuth sign-in, the native half (ai/phase-14-mobile.md §4.4) — ported from
 * apps/web's `features/auth/oauth.ts`, adapted for a system-browser session
 * instead of a page navigation.
 *
 * Deliberately imports nothing from `app-session.ts`: everything else in
 * `src/lib/` stays Expo-free and importable under plain vitest (this file's
 * own header on why), and the reverse direction — `app-session.ts` importing
 * FROM here — is the only one this codebase allows. The `auth.native.oauth.*`
 * calls themselves live in `sign-in.tsx`, alongside `apiClient` and
 * `session.adopt`, mirroring how `signIn`/`verifyTotp` are inlined there
 * already rather than wrapped in a hook here.
 *
 * There is no `(auth)/oauth-callback` ROUTE for expo-router to mount.
 * `expo-web-browser`'s `openAuthSessionAsync` intercepts the provider's
 * redirect to `OAUTH_REDIRECT_URL` directly at the native layer — an
 * `ASWebAuthenticationSession` on iOS, a Custom Tab + intent filter on
 * Android — and resolves its promise with the URL before expo-router's own
 * deep-link handling ever sees it. A route file here would simply never be
 * visited.
 */

export type OAuthProvider = 'google' | 'github';

export const OAUTH_PROVIDER_LABEL: Readonly<Record<OAuthProvider, string>> = {
  google: 'Google',
  github: 'GitHub',
};

/** The custom-scheme redirect `app.config.ts` registers (`scheme: 'taskflow'`). */
export const OAUTH_REDIRECT_URL = 'taskflow://oauth-callback';

/**
 * Extracts `code`/`state` from the system-browser session's redirect URL.
 *
 * Hand-rolled rather than `URL`/`URLSearchParams`: React Native's polyfill
 * for both has historically been incomplete across versions, and this only
 * ever needs two known keys out of a URL whose scheme this app registered
 * itself. Returns null for anything that does not carry both — the caller
 * treats that as a failed round trip, never as a value to trust partially.
 */
export function parseOAuthRedirect(url: string): { code: string; state: string } | null {
  const queryIndex = url.indexOf('?');
  if (queryIndex === -1) return null;

  const params = new Map<string, string>();
  for (const pair of url.slice(queryIndex + 1).split('&')) {
    const [key, value] = pair.split('=');
    if (key === undefined || value === undefined) continue;
    params.set(decodeURIComponent(key), decodeURIComponent(value));
  }

  const code = params.get('code');
  const state = params.get('state');
  return code === undefined || state === undefined ? null : { code, state };
}
