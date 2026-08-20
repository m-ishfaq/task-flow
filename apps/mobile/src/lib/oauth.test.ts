import { describe, it, expect } from 'vitest';
import { parseOAuthRedirect } from './oauth.js';

describe('parseOAuthRedirect', () => {
  it('extracts code and state from a successful redirect', () => {
    expect(parseOAuthRedirect('taskflow://oauth-callback?code=abc123&state=xyz789')).toEqual({
      code: 'abc123',
      state: 'xyz789',
    });
  });

  it('is order-independent', () => {
    expect(parseOAuthRedirect('taskflow://oauth-callback?state=xyz789&code=abc123')).toEqual({
      code: 'abc123',
      state: 'xyz789',
    });
  });

  it('decodes percent-encoded values', () => {
    // A signed state is a JWT-like token that can carry base64url characters;
    // this asserts a value containing a would-be-encoded separator survives.
    const encoded = encodeURIComponent('part.one+two');
    expect(parseOAuthRedirect(`taskflow://oauth-callback?code=c&state=${encoded}`)).toEqual({
      code: 'c',
      state: 'part.one+two',
    });
  });

  it('returns null with no query string at all', () => {
    expect(parseOAuthRedirect('taskflow://oauth-callback')).toBeNull();
  });

  it('returns null when code is missing', () => {
    expect(parseOAuthRedirect('taskflow://oauth-callback?state=xyz789')).toBeNull();
  });

  it('returns null when state is missing', () => {
    expect(parseOAuthRedirect('taskflow://oauth-callback?code=abc123')).toBeNull();
  });

  it('returns null for a provider error redirect carrying neither', () => {
    expect(parseOAuthRedirect('taskflow://oauth-callback?error=access_denied')).toBeNull();
  });
});
