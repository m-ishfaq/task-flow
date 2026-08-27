import { describe, it, expect } from 'vitest';
import { base64ToBase64Url, bytesToHex, parseOAuthRedirect } from './oauth.js';

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

describe('bytesToHex', () => {
  it('pads each byte to two characters', () => {
    // Without the pad, 0x00 and 0x0a collapse to '0'/'a' and the verifier
    // silently loses length — a bug that still "works" until the server
    // compares digests.
    expect(bytesToHex(new Uint8Array([0, 10, 255, 16]))).toBe('000aff10');
  });

  it('produces a 64-character verifier from 32 bytes, inside RFC 7636 43-128', () => {
    const hex = bytesToHex(new Uint8Array(32).fill(7));
    expect(hex).toHaveLength(64);
    // Every character must be in the unreserved/base64url alphabet, or the
    // value would need escaping on the wire.
    expect(hex).toMatch(/^[A-Za-z0-9\-_]+$/);
  });
});

describe('base64ToBase64Url', () => {
  it('converts every standard-base64 character the server never emits', () => {
    // The server compares against Node's digest('base64url'). A stray '+',
    // '/' or '=' fails the binding with an error that names the state rather
    // than the encoding, so this conversion has to be exact.
    expect(base64ToBase64Url('ab+/cd==')).toBe('ab-_cd');
  });

  it('leaves an already-url-safe digest untouched', () => {
    expect(base64ToBase64Url('abcDEF123-_')).toBe('abcDEF123-_');
  });
});
