import { describe, expect, it } from 'vitest';
import {
  REFRESH_COOKIE,
  clearRefreshCookieOptions,
  readRefreshCookie,
  refreshCookieOptions,
  serializeRefreshCookie,
} from './cookies.js';

/**
 * Cookie attributes are not configuration — each one removes a specific attack
 * (PLAN.md §8.1). These assertions exist so that "simplifying" any of them away
 * fails rather than merely working.
 */

describe('cookie name', () => {
  it('uses the __Host- prefix', () => {
    // A prefix the BROWSER enforces: it refuses a `__Host-*` cookie that is not
    // Secure, not Path=/, or that carries a Domain. Without it, script on any
    // sibling subdomain can overwrite the refresh cookie and fix the victim's
    // session to one the attacker controls.
    expect(REFRESH_COOKIE.startsWith('__Host-')).toBe(true);
  });
});

describe('serialization', () => {
  it('sets every attribute the __Host- prefix requires', () => {
    const header = serializeRefreshCookie('tf_rt_abc', refreshCookieOptions(3600));

    expect(header).toContain('HttpOnly'); // script cannot read it — the whole point of splitting the pair
    expect(header).toContain('Secure'); // never sent over plaintext
    expect(header).toContain('SameSite=Strict'); // not attached cross-site at all, so CSRF is impossible not merely mitigated
    expect(header).toContain('Path=/'); // required by __Host-
    expect(header).toContain('Max-Age=3600');
    expect(header).not.toContain('Domain='); // a Domain attribute would void the prefix
  });

  it('expires the cookie when clearing', () => {
    const header = serializeRefreshCookie('', clearRefreshCookieOptions());

    expect(header).toContain('Max-Age=0');
    expect(header).toContain('HttpOnly');
    expect(header).toContain('Secure');
  });

  it('is SameSite=Strict rather than Lax', () => {
    // Lax still sends cookies on top-level navigations, and refresh is a
    // state-changing POST. Strict is what makes the endpoint unreachable
    // cross-site.
    expect(serializeRefreshCookie('x', refreshCookieOptions(60))).not.toContain('SameSite=Lax');
  });
});

describe('reading', () => {
  it('finds the cookie among others', () => {
    const header = `theme=dark; ${REFRESH_COOKIE}=tf_rt_value; locale=en`;
    expect(readRefreshCookie(header)).toBe('tf_rt_value');
  });

  it('tolerates whitespace and ordering', () => {
    expect(readRefreshCookie(`  ${REFRESH_COOKIE}=abc  ; other=1`)).toBe('abc');
    expect(readRefreshCookie(`other=1;${REFRESH_COOKIE}=abc`)).toBe('abc');
  });

  it('returns null when absent, empty, or malformed', () => {
    expect(readRefreshCookie(undefined)).toBeNull();
    expect(readRefreshCookie('')).toBeNull();
    expect(readRefreshCookie('other=1')).toBeNull();
    expect(readRefreshCookie(`${REFRESH_COOKIE}=`)).toBeNull();
    expect(readRefreshCookie('novalue')).toBeNull();
  });

  it('does not match a cookie whose name merely ends with ours', () => {
    // `evil___Host-taskflow_refresh` must not be read as the real one.
    expect(readRefreshCookie(`evil${REFRESH_COOKIE}=attacker-value`)).toBeNull();
  });

  it('keeps a value containing an equals sign intact', () => {
    // Splitting on every `=` rather than the first silently truncates the token,
    // which would present as "sessions randomly stop working".
    expect(readRefreshCookie(`${REFRESH_COOKIE}=abc=def==`)).toBe('abc=def==');
  });
});
