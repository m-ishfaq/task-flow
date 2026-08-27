import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet } from 'jose';
import { generatePkcePair, verifyPkceChallenge, verifyGoogleIdToken } from './oauth.js';

describe('generatePkcePair', () => {
  it('produces a verifier and its S256 challenge', () => {
    const { verifier, challenge } = generatePkcePair();

    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(verifier).toMatch(/^[A-Za-z0-9\-_]+$/);
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
  });

  it('produces a distinct pair each time', () => {
    const a = generatePkcePair();
    const b = generatePkcePair();
    expect(a.verifier).not.toBe(b.verifier);
  });
});

describe('verifyGoogleIdToken', () => {
  const CLIENT_ID = 'test-client-id.apps.googleusercontent.com';

  async function issuer() {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = await exportJWK(publicKey);
    const kid = 'test-key-1';
    const jwks = createLocalJWKSet({ keys: [{ ...jwk, kid, alg: 'RS256', use: 'sig' }] });

    const sign = (claims: Record<string, unknown>) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid })
        .setIssuer('https://accounts.google.com')
        .setAudience(CLIENT_ID)
        .setIssuedAt()
        .setExpirationTime('10m')
        .sign(privateKey);

    return { sign, jwks };
  }

  it('accepts a real token with a verified email', async () => {
    const { sign, jwks } = await issuer();
    const token = await sign({
      sub: 'google-subject-1',
      email: 'alice@example.test',
      email_verified: true,
    });

    await expect(verifyGoogleIdToken(token, CLIENT_ID, jwks)).resolves.toEqual({
      subject: 'google-subject-1',
      email: 'alice@example.test',
    });
  });

  it('refuses a token whose email is not verified', async () => {
    // The property this function exists to check — a signature alone is not
    // the same claim as "this address belongs to this person".
    const { sign, jwks } = await issuer();
    const token = await sign({
      sub: 'google-subject-2',
      email: 'unverified@example.test',
      email_verified: false,
    });

    await expect(verifyGoogleIdToken(token, CLIENT_ID, jwks)).rejects.toThrow();
  });

  it('refuses a token for a different client id', async () => {
    const { sign, jwks } = await issuer();
    const token = await sign({
      sub: 'google-subject-3',
      email: 'alice@example.test',
      email_verified: true,
    });

    await expect(verifyGoogleIdToken(token, 'a-different-client-id', jwks)).rejects.toThrow();
  });

  it('refuses a token signed by a key not in the published set', async () => {
    const { jwks } = await issuer();
    const { privateKey: otherKey } = await generateKeyPair('RS256');

    const forged = await new SignJWT({
      sub: 'attacker',
      email: 'alice@example.test',
      email_verified: true,
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
      .setIssuer('https://accounts.google.com')
      .setAudience(CLIENT_ID)
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(otherKey);

    await expect(verifyGoogleIdToken(forged, CLIENT_ID, jwks)).rejects.toThrow();
  });
});

describe('verifyPkceChallenge', () => {
  it('accepts the verifier that produced the challenge', () => {
    const { verifier, challenge } = generatePkcePair();
    expect(verifyPkceChallenge(verifier, challenge)).toBe(true);
  });

  it('rejects any other verifier — the whole point of the native binding', () => {
    /* An interceptor holding a redirect can READ the challenge off the signed
       state's JWT payload, exactly as it is readable in the authorization URL.
       What it cannot do is invert SHA-256 to produce this input. */
    const { challenge } = generatePkcePair();
    const other = generatePkcePair();
    expect(verifyPkceChallenge(other.verifier, challenge)).toBe(false);
  });

  it('rejects empty input on either side rather than treating it as a match', () => {
    const { verifier, challenge } = generatePkcePair();
    expect(verifyPkceChallenge('', challenge)).toBe(false);
    expect(verifyPkceChallenge(verifier, '')).toBe(false);
  });

  it('returns false rather than throwing when the lengths differ', () => {
    // `timingSafeEqual` throws on unequal lengths; the guard is what keeps a
    // malformed challenge a refusal instead of a 500.
    const { verifier } = generatePkcePair();
    expect(verifyPkceChallenge(verifier, 'too-short')).toBe(false);
  });
});
