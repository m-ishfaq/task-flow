import { createHash, timingSafeEqual } from 'node:crypto';
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

/**
 * Verifies a caller-supplied `verifier` against a previously recorded S256
 * `challenge` — the same transform `generatePkcePair` applies, checked rather
 * than generated.
 *
 * ## What this is for, and why it is not the PKCE above
 *
 * `generatePkcePair`'s pair secures the leg between this SERVER and the
 * identity provider: the verifier never leaves the server (it rides inside
 * the signed OAuth state), so it proves nothing about WHICH CLIENT is
 * redeeming a callback. On the native channel that gap is exploitable
 * (ai/phase-14-mobile.md §4.4): the redirect lands on a plain custom scheme
 * (`taskflow://oauth-callback`), which on Android any installed app may also
 * register an intent filter for, and `auth.native.oauth.callback` is a public
 * route that mints a full session for whoever presents a valid `(code,
 * state)`. An interceptor needs no verifier, because the server already holds
 * it — so RFC 7636's protection, present and correct, cannot defend this leg.
 *
 * This is the second, CLIENT-held half that closes it, exactly as RFC 8252
 * §8.1 prescribes for a native app on a custom scheme: the app generates a
 * verifier, sends only its S256 challenge to `start` (which the server binds
 * into the signed state), and must present the plaintext at `callback`. An
 * intercepted `(code, state)` is then inert — the challenge is readable off
 * the state's own JWT payload, as it is in the authorization URL, and
 * inverting SHA-256 is the work it is meant to be.
 *
 * Constant-time despite the challenge not being secret: the comparison costs
 * the same either way, and a future caller passing something that IS secret
 * should not have to notice this distinction to stay safe. Lengths are
 * compared first because `timingSafeEqual` throws on a mismatch — the same
 * guard `blind-index.ts` documents for its own equality check.
 */
export function verifyPkceChallenge(verifier: string, challenge: string): boolean {
  if (verifier.length === 0 || challenge.length === 0) return false;

  const computed = Buffer.from(createHash('sha256').update(verifier).digest('base64url'), 'utf8');
  const expected = Buffer.from(challenge, 'utf8');
  if (computed.length !== expected.length) return false;

  return timingSafeEqual(computed, expected);
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
