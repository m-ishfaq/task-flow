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

/* -------------------------------------------------------------------------- *
 * The client-held PKCE binding (ai/phase-14-mobile.md §4.4, RFC 8252 §8.1)
 *
 * `OAUTH_REDIRECT_URL` above is a plain custom scheme, and on Android any
 * installed app may register an intent filter for it. `auth.native.oauth.
 * callback` is necessarily public — there is no session yet — so without a
 * secret only the real app holds, whoever received that redirect could redeem
 * `(code, state)` for a full session. RFC 7636's own verifier cannot help: the
 * SERVER holds it (it rides inside the signed state), so an interceptor never
 * needs it.
 *
 * So the app mints a second verifier, sends only its S256 challenge to
 * `start`, and presents the plaintext at `callback`. S256 and never `plain`:
 * the challenge is bound into a JWT whose payload is SIGNED, not encrypted, so
 * `plain` would ship the secret to the very interceptor this defends against.
 *
 * These two helpers are pure so they stay unit-testable with no Expo runtime
 * (this file's own header); the hashing and randomness live in
 * `oauth-pkce.native.ts`, the same split `secure-store.ts`/`device-secure-
 * store.ts` and `device-key.ts`/`device-key.native.ts` already use.
 * -------------------------------------------------------------------------- */

/**
 * Lowercase hex for `bytes`.
 *
 * Hex rather than base64: every hex character is already inside RFC 7636's
 * unreserved set (and base64url's alphabet), so the verifier needs no
 * re-encoding and no `Buffer`/`btoa` — neither of which React Native provides
 * dependably. 32 bytes give 64 characters, inside the spec's 43-128 range.
 */
export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/**
 * Standard base64 to base64url, unpadded.
 *
 * `expo-crypto` emits only HEX or standard BASE64; the server compares against
 * Node's `digest('base64url')`. This is that conversion, and it must stay
 * exact — a stray `=` or `+` makes every native sign-in fail the binding check
 * with an error that names the state, not the encoding.
 */
export function base64ToBase64Url(value: string): string {
  return value.replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
