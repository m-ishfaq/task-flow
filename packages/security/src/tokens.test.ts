import { describe, expect, it } from 'vitest';
import {
  TOKEN_PREFIX,
  hashToken,
  isTokenKind,
  issueHumanCode,
  issueNumericCode,
  issueToken,
  verifyToken,
  type TokenKind,
} from './tokens.js';
import { HUMAN_ALPHABET } from './random.js';

const KINDS = Object.keys(TOKEN_PREFIX) as TokenKind[];

describe('issueToken', () => {
  it.each(KINDS)('prefixes a %s token so a leak is greppable', (kind) => {
    const { token } = issueToken(kind);
    expect(token.startsWith(`${TOKEN_PREFIX[kind]}_`)).toBe(true);
    expect(isTokenKind(token, kind)).toBe(true);
  });

  it('uses a distinct prefix per kind', () => {
    // Overlapping prefixes would make secret-scanning rules ambiguous and let a
    // token of one kind be presented where another is expected.
    const prefixes = Object.values(TOKEN_PREFIX);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it('carries 256 bits of entropy in a URL-safe body', () => {
    const { token } = issueToken('apiToken');
    const body = token.slice(TOKEN_PREFIX.apiToken.length + 1);
    expect(body).toHaveLength(43); // 32 bytes, base64url
    expect(body).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('never repeats', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2_000; i += 1) seen.add(issueToken('refresh').token);
    expect(seen.size).toBe(2_000);
  });

  it('returns a hash that does not contain the token', () => {
    // The stored value must be useless to whoever reads the table.
    const { token, hash } = issueToken('apiToken');
    expect(hash).not.toContain(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(hashToken(token));
  });
});

describe('verifyToken', () => {
  it('accepts the issued token', () => {
    const { token, hash } = issueToken('passwordReset');
    expect(verifyToken(token, hash)).toBe(true);
  });

  it('rejects a different token, including a near-miss', () => {
    const { token, hash } = issueToken('passwordReset');
    expect(verifyToken(issueToken('passwordReset').token, hash)).toBe(false);
    expect(verifyToken(`${token}x`, hash)).toBe(false);
    expect(verifyToken(token.slice(0, -1), hash)).toBe(false);
    expect(verifyToken('', hash)).toBe(false);
  });

  it('rejects a token of the wrong kind', () => {
    const { hash } = issueToken('refresh');
    expect(isTokenKind('tf_pat_abc', 'refresh')).toBe(false);
    expect(verifyToken('tf_pat_abc', hash)).toBe(false);
  });
});

describe('issueNumericCode', () => {
  it('produces digits only, of the requested length', () => {
    for (let i = 0; i < 100; i += 1) {
      const { token } = issueNumericCode(6);
      expect(token).toMatch(/^\d{6}$/);
    }
  });

  it('can produce a code with leading zeros', () => {
    // A code generated as a NUMBER and formatted loses leading zeros, silently
    // shrinking the space and breaking string comparison against the stored
    // hash. Generating characters directly avoids that; this asserts it.
    const codes = Array.from({ length: 2_000 }, () => issueNumericCode(6).token);
    expect(codes.some((code) => code.startsWith('0'))).toBe(true);
  });

  it('hashes to something verifiable', () => {
    const { token, hash } = issueNumericCode();
    expect(verifyToken(token, hash)).toBe(true);
  });
});

describe('issueHumanCode', () => {
  it('is grouped and free of ambiguous characters', () => {
    const { token } = issueHumanCode(3, 4);
    expect(token).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    for (const char of token.replace(/-/g, '')) {
      expect(HUMAN_ALPHABET).toContain(char);
    }
  });
});
