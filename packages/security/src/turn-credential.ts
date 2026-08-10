import { createHmac } from 'node:crypto';

/**
 * TURN credentials, coturn's `use-auth-secret` REST scheme
 * (ai/phase-13-webrtc.md §3.3).
 *
 * ⚠ HUMAN REVIEW SURFACE. This mints a capability to relay arbitrary bytes
 * through infrastructure this deployment pays for.
 *
 * ## Why a shared secret and an HMAC rather than a TURN user account
 *
 * A long-term TURN username/password has to reach the browser to be useful, and
 * anything that reaches the browser is public. The REST scheme's answer is that
 * the browser never learns the secret at all: the server hands out a
 * `(username, credential)` pair that the TURN server can VERIFY without any
 * shared state, because it recomputes the same HMAC from the same static secret.
 * The username carries its own expiry, so a leaked pair stops working on a
 * schedule instead of when someone notices.
 *
 *   username   = "<unix-expiry>:<identity>"
 *   credential = base64(HMAC-SHA1(static-auth-secret, username))
 *
 * ## SHA-1 is not a choice made here
 *
 * It is what coturn computes when `use-auth-secret` is on, and a "hardened"
 * SHA-256 version would produce credentials no TURN server accepts — a
 * fail-closed outcome, and therefore one that gets fixed under time pressure by
 * turning the credential check off. The security argument is HMAC's (a keyed
 * MAC, where SHA-1's collision weakness does not apply), not SHA-1's.
 *
 * ## The identity is opaque, and that is deliberate
 *
 * coturn logs the username on every allocation, and TURN logs are operational
 * data with a different retention and a different audience from this database.
 * So the caller passes a per-session opaque id, never an email, never a raw user
 * id — see `apps/api/src/rtc/turn.service.ts`, which passes the session id.
 * The database already records who was issued what (`rtc.turn_issuance`); the
 * TURN server does not need to know, and giving it the information anyway would
 * put a user identifier in a log nobody in this codebase controls.
 */

/** The characters coturn's username field tolerates without quoting. */
const IDENTITY_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

export interface TurnCredential {
  /** `<unix-expiry>:<identity>` — sent to the browser verbatim. */
  readonly username: string;
  /** base64(HMAC-SHA1(secret, username)). */
  readonly credential: string;
  /** When it stops working, as a Date, for the caller to report and record. */
  readonly expiresAt: Date;
}

export interface MintTurnCredentialOptions {
  /** coturn's `static-auth-secret`. Never shipped to a client. */
  readonly secret: string;
  /** An OPAQUE per-session identifier. See the header on why. */
  readonly identity: string;
  readonly ttlSeconds: number;
  /** Injected so a test can assert an exact username. Defaults to now. */
  readonly now?: Date;
}

/**
 * Mints a time-limited TURN credential.
 *
 * Throws rather than returning a degraded value on bad input. Every argument
 * here comes from this server's own configuration or from a value it just
 * derived, so a violation is a deployment or programming error — and the
 * failure mode of "return something anyway" is a credential that either does
 * not work (a support ticket) or works forever (a bill).
 */
export function mintTurnCredential(options: MintTurnCredentialOptions): TurnCredential {
  /* An empty secret produces a perfectly valid HMAC under a known key, so every
     forged credential would verify against a coturn configured the same way.
     This is the shape of a misconfigured environment, not of an attacker, which
     is why it is checked rather than assumed — the same check
     `verifyTwilioSignature` makes for the same reason. */
  if (options.secret.length === 0) {
    throw new Error('TURN static-auth-secret is empty; refusing to mint a credential.');
  }

  /* A colon in the identity would move the boundary coturn parses the expiry
     at, so `1:2:user` reads as expiry 1 with identity "2:user" — an attacker
     who controlled the identity could mint themselves an already-expired-looking
     username that coturn reads differently from the way this function wrote it.
     The pattern excludes ':' along with everything else non-obvious. */
  if (!IDENTITY_PATTERN.test(options.identity)) {
    throw new Error('TURN credential identity must be 1-64 chars of [A-Za-z0-9_.-].');
  }

  if (!Number.isInteger(options.ttlSeconds) || options.ttlSeconds <= 0) {
    throw new Error('TURN credential ttlSeconds must be a positive integer.');
  }

  const now = options.now ?? new Date();
  const expiresAtMs = now.getTime() + options.ttlSeconds * 1000;

  /* Seconds, floored. coturn parses the field as an integer and a fractional
     value simply fails to parse — which reads as "TURN rejects our credentials"
     rather than as a formatting bug. */
  const expiryUnix = Math.floor(expiresAtMs / 1000);
  const username = `${String(expiryUnix)}:${options.identity}`;

  const credential = createHmac('sha1', options.secret)
    .update(Buffer.from(username, 'utf8'))
    .digest('base64');

  /* Rebuilt from the FLOORED unix value rather than from `expiresAtMs`, so the
     Date this returns is the same instant coturn will enforce. Reporting the
     unfloored one would put an expiry in the UI up to a second later than the
     credential actually stops working — small, and exactly the kind of skew a
     renewal timer computed from it turns into an intermittent failure. */
  return { username, credential, expiresAt: new Date(expiryUnix * 1000) };
}
