import { z } from 'zod';
import { defineEvent } from '@taskflow/events';

/**
 * Identity domain events — guardrail 11 (PLAN.md §2.1, §8.6).
 *
 * Registered by the slice that owns them rather than in a central list, so the
 * registry cannot drift from what the code actually emits.
 *
 * Note what is NOT in any payload here: no password, no token, no token hash.
 * Events are consumed by the audit log, the notification worker, and eventually
 * an analytics pipeline — three places a credential should never reach. Keeping
 * them out at the schema means a future consumer cannot accidentally log one.
 */

const userRef = z.object({ userId: z.string(), email: z.string() }).strict();

export const userRegistered = defineEvent('user.registered', userRef);

export const emailVerified = defineEvent(
  'user.email_verified',
  z.object({ userId: z.string(), email: z.string() }).strict(),
);

export const userLoggedIn = defineEvent(
  'user.logged_in',
  z
    .object({
      userId: z.string(),
      sessionId: z.string(),
      method: z.enum(['password', 'passkey', 'totp', 'oauth']),
      ip: z.string().nullable(),
      userAgent: z.string().nullable(),
    })
    .strict(),
);

/**
 * A failed attempt, emitted even when the account does not exist.
 *
 * `userId` is null in that case, and the event still carries the email that was
 * tried. Without it, credential-stuffing against non-existent accounts is
 * invisible — which is exactly the reconnaissance phase you most want to see.
 */
export const loginFailed = defineEvent(
  'user.login_failed',
  z
    .object({
      userId: z.string().nullable(),
      email: z.string(),
      reason: z.enum(['no_such_user', 'bad_password', 'locked', 'unverified', 'suspended']),
      ip: z.string().nullable(),
    })
    .strict(),
);

export const accountLocked = defineEvent(
  'user.account_locked',
  z.object({ userId: z.string(), until: z.string(), failedAttempts: z.number() }).strict(),
);

export const sessionRevoked = defineEvent(
  'session.revoked',
  z
    .object({
      userId: z.string(),
      sessionId: z.string(),
      reason: z.enum(['logout', 'logout_all', 'token_reuse', 'password_changed', 'admin']),
    })
    .strict(),
);

/**
 * A refresh token was presented twice.
 *
 * The highest-signal event in the system. It means a token left the browser it
 * was issued to, and by the time it fires the session has already been revoked
 * — the alert exists so a human finds out, not so anything is decided.
 */
export const tokenReuseDetected = defineEvent(
  'session.token_reuse_detected',
  z
    .object({
      userId: z.string(),
      sessionId: z.string(),
      ip: z.string().nullable(),
      userAgent: z.string().nullable(),
    })
    .strict(),
);

export const passwordChanged = defineEvent(
  'user.password_changed',
  z.object({ userId: z.string(), via: z.enum(['reset', 'change']) }).strict(),
);

export const passwordResetRequested = defineEvent(
  'user.password_reset_requested',
  z.object({ userId: z.string(), email: z.string(), ip: z.string().nullable() }).strict(),
);

/* -------------------------------------------------------------------------- *
 * Passkeys (§8.1)
 * -------------------------------------------------------------------------- */

/**
 * A passkey was enrolled.
 *
 * Worth an event of its own rather than folding into a generic "settings
 * changed": adding an authenticator is adding a way into the account, so it is
 * the single most useful line in a compromise investigation. `deviceType` and
 * `backedUp` are here because a synced credential means the key exists on
 * whatever else that provider account can reach.
 *
 * The credential id is not a secret — an authenticator hands it to any site with
 * the right origin — but the public key and the sign counter are omitted anyway,
 * because nothing downstream needs them.
 */
export const passkeyRegistered = defineEvent(
  'user.passkey_registered',
  z
    .object({
      userId: z.string(),
      credentialId: z.string(),
      deviceType: z.enum(['singleDevice', 'multiDevice']),
      backedUp: z.boolean(),
    })
    .strict(),
);

export const passkeyRemoved = defineEvent(
  'user.passkey_removed',
  z.object({ userId: z.string(), credentialRecordId: z.string() }).strict(),
);

/**
 * A passkey sign-in that did not succeed.
 *
 * Separate from `loginFailed` because it carries no email — a passkey ceremony
 * never asks for one, so there is none to record. `unknown_credential` is the
 * interesting value: a valid-looking assertion for a credential this system has
 * never seen means someone is replaying a ceremony captured elsewhere.
 */
export const passkeyLoginFailed = defineEvent(
  'user.passkey_login_failed',
  z
    .object({
      userId: z.string().nullable(),
      reason: z.enum(['unknown_credential', 'bad_signature', 'locked', 'suspended']),
      ip: z.string().nullable(),
    })
    .strict(),
);

/** TOTP enrolled or removed (Phase 12 Wave 2 §3.2) — a new way into an account either way. */
export const totpEnrolled = defineEvent(
  'user.totp_enrolled',
  z.object({ userId: z.string() }).strict(),
);

export const totpDisabled = defineEvent(
  'user.totp_disabled',
  z.object({ userId: z.string() }).strict(),
);

/**
 * An OAuth provider identity linked or unlinked (Phase 12 Wave 2 §3.3).
 *
 * Fires for all three link paths — direct sign-in creating a fresh account,
 * auto-link to an existing account by verified email, and an explicit "link
 * a new provider" from account settings — because all three are the same
 * fact from an audit standpoint: this provider identity can now sign into
 * this account. `oauthLinked` alone does not distinguish which path created
 * it; a brand-new account also gets its own `user.registered`.
 */
export const oauthLinked = defineEvent(
  'user.oauth_linked',
  z.object({ userId: z.string(), provider: z.enum(['google', 'github']) }).strict(),
);

export const oauthUnlinked = defineEvent(
  'user.oauth_unlinked',
  z.object({ userId: z.string(), provider: z.enum(['google', 'github']) }).strict(),
);

export { userRef };
