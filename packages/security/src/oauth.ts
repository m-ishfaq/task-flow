import { createHash } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { secureToken } from './random.js';

/**
 * OAuth sign-in primitives (Phase 12 Wave 2 §3.3).
 *
 * ⚠ HUMAN REVIEW SURFACE (§2.2) — a new way into an account, the same
 * severity class as password, passkey, and TOTP auth.
 *
 * Hand-rolled, not a library — the same call PLAN.md §4.2 already makes for
 * password/passkey auth. `jose` (already a dependency) verifies Google's ID
 * token against Google's published JWKS; GitHub issues no ID token, so its
 * half of `oauth.service.ts` calls the REST API directly with a plain
 * `fetch` instead.
 */

/* -------------------------------------------------------------------------- *
 * PKCE (RFC 7636)
 * -------------------------------------------------------------------------- */

export interface PkcePair {
  readonly verifier: string;
  readonly challenge: string;
}

/**
 * A fresh `code_verifier`/`code_challenge` pair, S256 method.
 *
 * 32 random bytes base64url-encode to 43 characters — the minimum RFC 7636
 * allows and comfortably inside its 43-128 range — from an alphabet
 * (`[A-Za-z0-9-_]`) that is a subset of the spec's "unreserved" characters,
 * so it needs no further escaping.
 */
export function generatePkcePair(): PkcePair {
  const verifier = secureToken(32);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/* -------------------------------------------------------------------------- *
 * Google — OIDC ID token verification
 * -------------------------------------------------------------------------- */

export interface GoogleIdentity {
  readonly subject: string;
  readonly email: string;
}

/* Constructed once, at module load, rather than per call: `jose`'s remote
   JWKS caches the fetched key set and re-fetches only when a `kid` it does
   not recognize shows up (a real key rotation), so building a fresh one per
   login would throw that caching away and fetch on every sign-in. */
const googleJwks = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

/**
 * Verifies a Google-issued ID token against Google's published JWKS and
 * extracts a VERIFIED email.
 *
 * `email_verified` is checked explicitly and is not optional: Google issues
 * ID tokens for accounts with an unverified email too (a freshly created
 * Google Workspace account, for instance), and trusting the address without
 * that flag would let someone claim any address they merely entered, which
 * is exactly the guarantee `identity.users.emailVerifiedAt` exists to make
 * expensive to fake.
 *
 * `keySource` defaults to Google's real JWKS and exists to be overridden in
 * tests — `oauth.test.ts` signs tokens against a locally generated key pair
 * and injects a `createLocalJWKSet` view of its public half, so the whole
 * verification path (signature, issuer, audience, expiry) runs for real
 * without a network call to Google.
 */
export async function verifyGoogleIdToken(
  idToken: string,
  clientId: string,
  keySource: JWTVerifyGetKey = googleJwks,
): Promise<GoogleIdentity> {
  const { payload } = await jwtVerify(idToken, keySource, {
    issuer: ['https://accounts.google.com', 'accounts.google.com'],
    audience: clientId,
  });

  const { sub, email, email_verified: emailVerified } = payload;
  if (typeof sub !== 'string' || typeof email !== 'string' || emailVerified !== true) {
    throw new Error('Google ID token has no verified email.');
  }

  return { subject: sub, email };
}
