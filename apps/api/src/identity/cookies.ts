/**
 * The refresh token cookie (PLAN.md §8.1).
 *
 * Every attribute below is doing work, and dropping any one of them costs a
 * specific defence:
 *
 *   __Host-      The prefix a browser ENFORCES. A cookie named `__Host-*` is
 *                only accepted when it is Secure, Path=/, and has no Domain —
 *                which means a subdomain cannot set it. Without the prefix, an
 *                XSS on any `*.example.com` can overwrite the refresh cookie and
 *                fix the victim's session to one the attacker controls.
 *   HttpOnly     Script cannot read it. This is the whole reason the token pair
 *                is split: XSS gets a ten-minute access token, not the thing
 *                that mints new ones.
 *   Secure       Never sent over plaintext HTTP.
 *   SameSite=Strict  The cookie is not attached to cross-site requests at all,
 *                which is what makes CSRF against the refresh endpoint
 *                impossible rather than merely mitigated. Strict rather than Lax
 *                because refresh is a POST that changes state, and Lax still
 *                sends cookies on top-level navigations.
 *   Path=/       Required by the __Host- prefix.
 */

export const REFRESH_COOKIE = '__Host-taskflow_refresh';

export interface CookieOptions {
  readonly httpOnly: true;
  readonly secure: true;
  readonly sameSite: 'strict';
  readonly path: '/';
  readonly maxAge?: number;
}

export function refreshCookieOptions(maxAgeSeconds: number): CookieOptions {
  return {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: '/',
    maxAge: maxAgeSeconds,
  };
}

/** Options for clearing it. maxAge 0 rather than a past date — same effect, fewer clock assumptions. */
export function clearRefreshCookieOptions(): CookieOptions {
  return { httpOnly: true, secure: true, sameSite: 'strict', path: '/', maxAge: 0 };
}

/**
 * Reads the refresh token out of a raw Cookie header.
 *
 * Hand-parsed rather than pulled from a plugin because this runs on every
 * request and needs no configuration. Splits on the FIRST `=` only: a cookie
 * value may legitimately contain `=` (base64url padding does not, but the next
 * token format might), and splitting on all of them silently truncates it.
 */
export function readRefreshCookie(header: string | undefined): string | null {
  if (!header) return null;

  for (const part of header.split(';')) {
    const trimmed = part.trim();
    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;

    if (trimmed.slice(0, separator) === REFRESH_COOKIE) {
      const value = trimmed.slice(separator + 1);
      return value.length > 0 ? value : null;
    }
  }
  return null;
}

/** Serializes a Set-Cookie header value. */
export function serializeRefreshCookie(value: string, options: CookieOptions): string {
  const parts = [
    `${REFRESH_COOKIE}=${value}`,
    `Path=${options.path}`,
    'SameSite=Strict',
    'HttpOnly',
    'Secure',
  ];

  if (options.maxAge !== undefined) parts.push(`Max-Age=${String(options.maxAge)}`);
  return parts.join('; ');
}
