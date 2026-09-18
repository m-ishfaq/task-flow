import { errors, unsafeAsId, type OrgId } from '@taskflow/contracts';
import { createEvent, type DomainEvent, type EventBus } from '@taskflow/events';
import type { SessionChannel } from '@taskflow/db';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  fakeVerifyPassword,
  hashPassword,
  hashToken,
  issueToken,
  newId,
  signAccessToken,
  signTotpChallenge,
  verifyDeviceSignature,
  verifyPassword,
  type AccessTokenSigningConfig,
  type BreachResult,
} from '@taskflow/security';
import * as repo from './repository.js';
import * as identityEvents from './events.js';
import { assessImpossibleTravel, countryOfIp } from './geo.js';

/**
 * Identity service (PLAN.md §8.1).
 *
 * ⚠ HUMAN REVIEW SURFACE (§2.2) — this is `apps/api/src/auth` by another name.
 *
 * Three properties hold across everything below, and each is easy to break with
 * a change that looks like a simplification:
 *
 *   1. **No endpoint reveals whether an email is registered.** Registration,
 *      login, and password reset all answer identically for a known and an
 *      unknown address, in both content and roughly in time. For a B2B product
 *      the account list is the customer list.
 *   2. **Credentials are never returned, logged, or put in an event.** Tokens
 *      exist in exactly one response; the database holds hashes.
 *   3. **Every state change emits a domain event** (guardrail 11), so the audit
 *      log is complete without anyone remembering to write to it.
 */

export interface IdentityConfig {
  /** Signs access tokens (RS256) — apps/realtime and apps/collab verify with the public half only. */
  readonly jwtPrivateKey: AccessTokenSigningConfig['privateKey'];
  /** Signs/verifies TOTP challenge, OAuth state and connector state tokens — single-process, stays HS256. */
  readonly jwtStateSecret: Uint8Array;
  readonly refreshTokenTtlMs: number;
  readonly verificationTtlMs: number;
  readonly passwordResetTtlMs: number;
  readonly lockThreshold: number;
  readonly lockDurationMs: number;
  /**
   * What to do when the breached-password service is unreachable.
   *
   * Explicit because it is a real posture decision, not a default: failing
   * closed blocks every registration while a third party is down, failing open
   * silently disables the control. `checkPasswordBreached` returns a three-state
   * result precisely so this choice is made here, where it can be logged.
   */
  readonly onBreachCheckUnavailable: 'allow' | 'deny';
}

export interface IdentityDeps {
  readonly config: IdentityConfig;
  readonly events: EventBus;
  /** Injected so tests need no network. See @taskflow/security's breach module. */
  readonly checkBreached: (password: string) => Promise<BreachResult>;
  /** Delivery of verification and reset links. Mail provider arrives with Phase 1's worker. */
  readonly deliver: (message: DeliverableLink) => Promise<void>;
  /**
   * IP → country for impossible-travel detection (§3.4). Injectable so tests
   * never load the geo database; defaults to `geoip-lite` via `countryOfIp`,
   * which is lazy and never throws.
   */
  readonly lookupCountry?: (ip: string | null) => Promise<string | null>;
  readonly now?: () => Date;
}

export interface DeliverableLink {
  readonly kind:
    | 'verify_email'
    | 'password_reset'
    | 'duplicate_registration'
    | 'impossible_travel'
    | 'password_changed'
    | 'totp_enabled'
    | 'passkey_registered';
  readonly email: string;
  /* Absent for every kind below `password_reset` — none of the security
     notices carry a link, for the same reason `duplicate_registration`
     doesn't: a "click here" in a message an attacker's own action could
     trigger is a phishing shape, not a courtesy. */
  readonly token?: string;
  /** Present only for `impossible_travel`. */
  readonly previousCountry?: string;
  readonly newCountry?: string;
}

export interface RequestMeta {
  readonly ip: string | null;
  readonly userAgent: string | null;
}

export interface TokenPair {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresInSeconds: number;
  readonly sessionId: string;
}

/**
 * What `login()` returns (Phase 12 Wave 2 §3.2).
 *
 * Two shapes, not one, because a confirmed TOTP credential means the
 * password alone is not enough to finish signing in. `'totp_required'`
 * carries a signed challenge — proof the password step already
 * succeeded — redeemable exactly once at `auth.totp.verifyLogin`, which is
 * the only thing that can turn it into a real session. This is also how
 * step-up gets TOTP for free: `StepUpDialog` already re-calls `auth.login`
 * to prove a fresh credential, so an account with TOTP enabled sees the
 * identical challenge there too.
 */
export type LoginResult =
  | { readonly kind: 'session'; readonly pair: TokenPair }
  | { readonly kind: 'totp_required'; readonly challengeToken: string };

const clock = (deps: IdentityDeps): Date => (deps.now ?? (() => new Date()))();

/* -------------------------------------------------------------------------- *
 * Registration
 * -------------------------------------------------------------------------- */

/**
 * Registers an account, or silently does nothing if the address is taken.
 *
 * The return value is identical either way. An endpoint that answers "that email
 * is already registered" is an account-existence oracle that needs no
 * credentials at all, and for a B2B product that enumerates the customer list.
 * The person who genuinely owns the address still finds out — they get mail
 * saying someone tried to sign up, which is also the only way a real duplicate
 * gets noticed.
 */
export async function register(
  deps: IdentityDeps,
  input: { email: string; password: string; name?: string | undefined },
  meta: RequestMeta,
): Promise<{ status: 'verification_sent' }> {
  /* Registration gate — reads the cached system setting. Disabled means the
     operator has turned off new sign-ups via the Config tab. The check runs
     before password validation so an attacker cannot probe password strength
     against a disabled registration. */
  const { getSystemSettings } = await import('../platform-admin/system-settings-cache.js');
  const settings = await getSystemSettings();
  if (!settings.registrationEnabled) {
    throw errors.forbidden('New registrations are temporarily disabled.');
  }

  await assertPasswordAcceptable(deps, input.password);

  const now = clock(deps);
  const userId = newId<'UserId'>();
  const verification = issueToken('emailVerify');

  const created = await repo.createUser({
    id: userId,
    email: input.email,
    /* Trimmed, and a whitespace-only name is NO name — storing '   ' would
       render as an invisible display name that reads as a rendering bug. */
    displayName: input.name?.trim() === '' ? undefined : input.name?.trim(),
    passwordHash: await hashPassword(input.password),
    verification: {
      id: newId<'VerificationId'>(),
      tokenHash: verification.hash,
      expiresAt: new Date(now.getTime() + deps.config.verificationTtlMs),
    },
  });

  if (!created) {
    await deps.deliver({ kind: 'duplicate_registration', email: input.email });
    return { status: 'verification_sent' };
  }

  await deps.deliver({
    kind: 'verify_email',
    email: created.email,
    token: verification.token,
  });

  await deps.events.publish([
    createEvent(
      identityEvents.userRegistered,
      { userId: created.id, email: created.email },
      { orgId: SYSTEM_ORG, actorId: null, occurredAt: now },
    ),
  ]);

  void meta;
  return { status: 'verification_sent' };
}

export async function verifyEmail(
  deps: IdentityDeps,
  input: { token: string },
): Promise<{ status: 'verified' }> {
  const now = clock(deps);
  const consumed = await repo.consumeEmailVerification(hashToken(input.token), now);

  if (!consumed) {
    // Expired, already used, or never existed — one answer for all three. The
    // differences are only useful to someone probing link formats.
    throw errors.notFound('That link is invalid or has expired.');
  }

  await deps.events.publish([
    createEvent(
      identityEvents.emailVerified,
      { userId: consumed.userId, email: consumed.email },
      { orgId: SYSTEM_ORG, actorId: null, occurredAt: now },
    ),
  ]);

  return { status: 'verified' };
}

/**
 * Re-sends the verification link — the door `login` leaves someone at when
 * their original mail never arrived (§8.1 follow-up).
 *
 * Same no-answer shape as `requestPasswordReset`, and for the same reason: a
 * different response for an unregistered address, an already-verified one,
 * or a suspended account is an account-existence oracle. All three return
 * the identical `{ status: 'sent' }` with nothing sent.
 */
export async function resendVerification(
  deps: IdentityDeps,
  input: { email: string },
  meta: RequestMeta,
): Promise<{ status: 'sent' }> {
  const now = clock(deps);
  const user = await repo.findUserByEmail(input.email);

  if (!user) return { status: 'sent' };
  if (user.status !== 'active') return { status: 'sent' };
  if (user.emailVerifiedAt !== null) return { status: 'sent' };

  const verification = issueToken('emailVerify');
  await repo.createEmailVerification({
    id: newId<'VerificationId'>(),
    userId: user.id,
    email: user.email,
    tokenHash: verification.hash,
    expiresAt: new Date(now.getTime() + deps.config.verificationTtlMs),
  });

  await deps.deliver({ kind: 'verify_email', email: user.email, token: verification.token });

  await deps.events.publish([
    createEvent(
      identityEvents.emailVerificationResent,
      { userId: user.id, email: user.email, ip: meta.ip },
      { orgId: SYSTEM_ORG, actorId: null, occurredAt: now },
    ),
  ]);

  return { status: 'sent' };
}

/* -------------------------------------------------------------------------- *
 * Login
 * -------------------------------------------------------------------------- */

export async function login(
  deps: IdentityDeps,
  input: { email: string; password: string },
  meta: RequestMeta,
  /**
   * Which client is signing in — bound onto the session so only its own refresh
   * route may renew it (§4.3). The router passes 'browser'/'native' explicitly;
   * the default exists only so a caller that omits it fails SAFE. Omitting it
   * mints a browser session, whose token the native route then REFUSES — visible
   * breakage of a native client, never a token that crosses a channel it should
   * not. There is no default that exposes; the risky direction is unreachable.
   */
  channel: SessionChannel = 'browser',
): Promise<LoginResult> {
  const now = clock(deps);
  const user = await repo.findUserByEmail(input.email);

  if (!user) {
    // Burn the same work as a real verification. Skipping the hash here answers
    // in ~1 ms instead of ~50 ms, and that gap is a reliable remote oracle for
    // "is this address registered".
    await fakeVerifyPassword(input.password);
    await publishFailure(deps, now, {
      userId: null,
      email: input.email,
      reason: 'no_such_user',
      ip: meta.ip,
    });
    throw invalidCredentials();
  }

  if (user.lockedUntil && user.lockedUntil > now) {
    await fakeVerifyPassword(input.password);
    await publishFailure(deps, now, {
      userId: user.id,
      email: input.email,
      reason: 'locked',
      ip: meta.ip,
    });
    // Same error as a wrong password. Saying "locked" confirms the account
    // exists and tells an attacker their guessing is working.
    throw invalidCredentials();
  }

  if (user.status !== 'active') {
    await fakeVerifyPassword(input.password);
    await publishFailure(deps, now, {
      userId: user.id,
      email: input.email,
      reason: 'suspended',
      ip: meta.ip,
    });
    throw invalidCredentials();
  }

  // A null hash means a passkey-only account (§8.1). It must NOT read as
  // "no password required".
  const correct =
    user.passwordHash === null
      ? await fakeVerifyPassword(input.password)
      : await verifyPassword(input.password, user.passwordHash);

  if (!correct) {
    const state = await repo.recordFailedLogin(
      user.id,
      deps.config.lockThreshold,
      deps.config.lockDurationMs,
      now,
    );

    // Annotated, because inference narrows the array to the first element's
    // event type and then refuses the lockout event appended below.
    const failures: DomainEvent[] = [
      createEvent(
        identityEvents.loginFailed,
        { userId: user.id, email: input.email, reason: 'bad_password' as const, ip: meta.ip },
        { orgId: SYSTEM_ORG, actorId: null, occurredAt: now },
      ),
    ];

    if (state?.lockedUntil && state.lockedUntil > now) {
      failures.push(
        createEvent(
          identityEvents.accountLocked,
          {
            userId: user.id,
            until: state.lockedUntil.toISOString(),
            failedAttempts: state.failedLoginCount,
          },
          { orgId: SYSTEM_ORG, actorId: null, occurredAt: now },
        ),
      );
    }

    await deps.events.publish(failures);
    throw invalidCredentials();
  }

  if (user.emailVerifiedAt === null) {
    await publishFailure(deps, now, {
      userId: user.id,
      email: input.email,
      reason: 'unverified',
      ip: meta.ip,
    });
    // A distinct error, unlike the cases above. The caller has already proven
    // they know the password, so there is nothing left to disclose — and telling
    // them to check their mail is the only useful thing to say.
    throw errors.emailNotVerified();
  }

  /* Phase 12 Wave 2 §3.2. The password step just succeeded — everything
     after this point in the function is what "finish signing in" means for
     an account with no TOTP enrolled. For one that has a CONFIRMED
     credential, the password alone proves only the first factor, so this
     returns a signed challenge instead of a session; `auth.totp.verifyLogin`
     is the only route that can turn it into one. Login failures are not
     recorded for reaching this branch — the password was correct, so
     `publishFailure` (which exists to record wrong GUESSES) does not apply,
     and `clearLoginFailures`/`userLoggedIn` are deferred to the moment a
     session is actually issued, in `totp.service.ts`'s `verifyLogin`. */
  const totp = await repo.getTotpCredential(user.id);
  if (totp?.confirmedAt) {
    const challengeToken = await signTotpChallenge(
      { userId: user.id },
      { secret: deps.config.jwtStateSecret },
    );
    return { kind: 'totp_required', challengeToken };
  }

  const pair = await issueSession(deps, user.id, now, now, meta, channel);

  await deps.events.publish([
    createEvent(
      identityEvents.userLoggedIn,
      {
        userId: user.id,
        sessionId: pair.sessionId,
        method: 'password' as const,
        ip: meta.ip,
        userAgent: meta.userAgent,
      },
      { orgId: SYSTEM_ORG, actorId: null, occurredAt: now },
    ),
  ]);

  await repo.clearLoginFailures(user.id, now);
  return { kind: 'session', pair };
}

/* -------------------------------------------------------------------------- *
 * Refresh — rotation with reuse detection (§8.1)
 * -------------------------------------------------------------------------- */

/**
 * Exchanges a refresh token for a new pair.
 *
 * The reuse branch is the reason this design exists. A refresh token is a bearer
 * credential: whoever holds it is the user. Rotating on every use means a stolen
 * token is only good until the victim's browser refreshes — at which point one
 * of the two parties presents an already-rotated token, and that is a signal no
 * legitimate client can produce.
 *
 * The response is to revoke the WHOLE session, not just refuse the request. At
 * that moment the attacker and the user both hold tokens descended from the same
 * chain and there is no way to tell which is which, so the only safe move is to
 * end it for both and make them re-authenticate.
 */
export async function refresh(
  deps: IdentityDeps,
  input: { refreshToken: string; deviceSignature?: string },
  meta: RequestMeta,
  /**
   * The channel of the route presenting the token; it must match the session's
   * own (§4.3). Defaults to 'browser' for the same fail-safe reason `login`'s
   * does: a caller that omits it enforces the browser channel, which can only
   * over-restrict (a native token refused), never admit a token across a channel.
   */
  expectedChannel: SessionChannel = 'browser',
): Promise<TokenPair> {
  const now = clock(deps);
  const found = await repo.findRefreshToken(hashToken(input.refreshToken));

  if (!found) throw invalidSession();

  /* Channel binding (ai/phase-14-mobile.md §4.3). A token minted on one channel
     may only be refreshed on that channel's route: a browser cookie token is
     refused on the native body-delivery route, and a native token on the
     browser cookie route. Refused generically as an invalid session — the token
     is genuine, only presented on the wrong surface, and a distinct error would
     confirm it exists. Checked BEFORE the reuse/rotation branch so a
     wrong-channel probe can never trigger a family-wide revocation of a real
     user's session. */
  if (found.channel !== expectedChannel) throw invalidSession();

  /* Device binding (§4.5). A session with a bound key requires a signature
     over the PRESENTED token from that key — proof this refresh is being
     redeemed by the one device whose secure enclave / StrongBox minted the
     key, not merely by whoever is holding the token. A session with no key
     bound (predates this feature, or registration has not landed yet) is
     unaffected: `devicePublicKey` is null and this branch does nothing,
     exactly the behaviour before this feature existed.

     Checked before reuse/rotation, same reasoning as the channel check
     immediately above: a token holder who cannot produce a valid signature
     must be refused before the token is treated as spent, or an attacker who
     merely captured a token (never the private key) could burn it and force
     the legitimate device into a reuse-triggered revocation of its own
     session — turning the compensating control into a denial-of-service
     against the user it protects. */
  if (found.devicePublicKey !== null) {
    if (
      input.deviceSignature === undefined ||
      !verifyDeviceSignature({
        publicKey: found.devicePublicKey,
        signature: input.deviceSignature,
        data: input.refreshToken,
      })
    ) {
      throw invalidSession();
    }
  }

  if (found.rotatedAt !== null) {
    await repo.revokeSession(found.sessionId, 'token_reuse', now);
    await deps.events.publish([
      createEvent(
        identityEvents.tokenReuseDetected,
        {
          userId: found.userId,
          sessionId: found.sessionId,
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        { orgId: SYSTEM_ORG, actorId: null, occurredAt: now },
      ),
      createEvent(
        identityEvents.sessionRevoked,
        { userId: found.userId, sessionId: found.sessionId, reason: 'token_reuse' as const },
        { orgId: SYSTEM_ORG, actorId: null, occurredAt: now },
      ),
    ]);
    throw errors.tokenReused();
  }

  if (
    found.sessionRevokedAt !== null ||
    found.tokenExpiresAt <= now ||
    found.sessionExpiresAt <= now
  ) {
    throw invalidSession();
  }

  const next = issueToken('refresh');
  const rotated = await repo.rotateRefreshToken({
    presentedTokenId: found.tokenId,
    sessionId: found.sessionId,
    userId: found.userId,
    next: {
      id: newId<'RefreshTokenId'>(),
      tokenHash: next.hash,
      expiresAt: new Date(now.getTime() + deps.config.refreshTokenTtlMs),
    },
    now,
  });

  // Lost the race against a concurrent refresh carrying the same token. Treated
  // as reuse: the conditional UPDATE is the only thing that can adjudicate, and
  // it already has.
  if (!rotated) throw errors.tokenReused();

  const accessToken = await signAccessToken(
    {
      userId: found.userId,
      sessionId: found.sessionId,
      // NOT advanced. Refreshing is not proof of a credential, and treating it
      // as one would keep a stolen session permanently eligible for step-up
      // protected operations.
      authenticatedAt: Math.floor(found.authenticatedAt.getTime() / 1000),
    },
    { privateKey: deps.config.jwtPrivateKey },
  );

  return {
    accessToken,
    refreshToken: next.token,
    expiresInSeconds: ACCESS_TOKEN_TTL_SECONDS,
    sessionId: found.sessionId,
  };
}

/* -------------------------------------------------------------------------- *
 * Logout
 * -------------------------------------------------------------------------- */

export async function logout(
  deps: IdentityDeps,
  input: { refreshToken: string },
): Promise<{ status: 'ok' }> {
  const now = clock(deps);
  const found = await repo.findRefreshToken(hashToken(input.refreshToken));

  // Always 'ok'. Logging out something that was already gone is not an error
  // worth surfacing, and a distinct response would let an unauthenticated caller
  // probe which tokens are live.
  if (!found) return { status: 'ok' };

  await repo.revokeSession(found.sessionId, 'logout', now);
  await deps.events.publish([
    createEvent(
      identityEvents.sessionRevoked,
      { userId: found.userId, sessionId: found.sessionId, reason: 'logout' as const },
      { orgId: SYSTEM_ORG, actorId: null, occurredAt: now },
    ),
  ]);

  return { status: 'ok' };
}

/**
 * Ends every one of a user's sessions.
 *
 * `reason` defaults to `'logout_all'` — the self-service "sign out of every
 * device" call this originally shipped for — and takes `'admin'` from
 * offboarding automation (ai/phase-15-ai-copilot-and-permissions.md §8): a
 * departing member's own credential should not still work anywhere the
 * moment an admin starts the process, and this is the one path that already
 * does that unconditionally rather than one device at a time.
 *
 * Takes only `events`/`now` — never the full `IdentityDeps` — because it is
 * the one identity mutation a caller OUTSIDE this module needs (the
 * automation executor, which holds none of `config`, `checkBreached`, or
 * `deliver`, and must not be made to fabricate them just to satisfy a wider
 * type it does not use).
 */
export async function logoutEverywhere(
  deps: Pick<IdentityDeps, 'events' | 'now'>,
  input: { userId: string },
  reason: 'logout_all' | 'admin' = 'logout_all',
): Promise<{ revoked: number }> {
  const now = deps.now?.() ?? new Date();
  const sessionIds = await repo.revokeAllSessions(input.userId, reason, now);

  await deps.events.publish(
    sessionIds.map((sessionId) =>
      createEvent(
        identityEvents.sessionRevoked,
        { userId: input.userId, sessionId, reason },
        { orgId: SYSTEM_ORG, actorId: null, occurredAt: now },
      ),
    ),
  );

  return { revoked: sessionIds.length };
}

/* -------------------------------------------------------------------------- *
 * Password reset
 * -------------------------------------------------------------------------- */

/**
 * Starts a password reset. Always reports success.
 *
 * Same reasoning as registration: a different answer for an unknown address is
 * an account-existence oracle available to anyone.
 */
export async function requestPasswordReset(
  deps: IdentityDeps,
  input: { email: string },
  meta: RequestMeta,
): Promise<{ status: 'sent' }> {
  const now = clock(deps);
  const user = await repo.findUserByEmail(input.email);

  if (user?.status !== 'active') return { status: 'sent' };

  const reset = issueToken('passwordReset');
  await repo.createPasswordReset({
    id: newId<'PasswordResetId'>(),
    userId: user.id,
    tokenHash: reset.hash,
    expiresAt: new Date(now.getTime() + deps.config.passwordResetTtlMs),
    ip: meta.ip,
  });

  await deps.deliver({ kind: 'password_reset', email: user.email, token: reset.token });

  await deps.events.publish([
    createEvent(
      identityEvents.passwordResetRequested,
      { userId: user.id, email: user.email, ip: meta.ip },
      { orgId: SYSTEM_ORG, actorId: null, occurredAt: now },
    ),
  ]);

  return { status: 'sent' };
}

/**
 * Completes a reset and revokes every existing session.
 *
 * The revocation is the point, not a courtesy. Someone resetting their password
 * is frequently doing it because they believe their account is compromised, and
 * leaving the attacker's session alive makes the reset theatre.
 */
export async function resetPassword(
  deps: IdentityDeps,
  input: { token: string; password: string },
): Promise<{ status: 'reset' }> {
  await assertPasswordAcceptable(deps, input.password);

  const now = clock(deps);
  const consumed = await repo.consumePasswordReset({
    tokenHash: hashToken(input.token),
    passwordHash: await hashPassword(input.password),
    now,
  });

  if (!consumed) throw errors.notFound('That link is invalid or has expired.');

  const sessionIds = await repo.revokeAllSessions(consumed.userId, 'password_changed', now);

  await deps.events.publish([
    createEvent(
      identityEvents.passwordChanged,
      { userId: consumed.userId, via: 'reset' as const },
      { orgId: SYSTEM_ORG, actorId: null, occurredAt: now },
    ),
    ...sessionIds.map((sessionId) =>
      createEvent(
        identityEvents.sessionRevoked,
        { userId: consumed.userId, sessionId, reason: 'password_changed' as const },
        { orgId: SYSTEM_ORG, actorId: null, occurredAt: now },
      ),
    ),
  ]);

  /* The one-line reset email already warns "using this will sign you out
     everywhere" — this is the confirmation that it actually happened,
     which matters most to the person who did NOT request it: the reset
     email went to whoever asked, but if an attacker asked, this is the
     first thing the real owner ever sees. Best-effort, same reasoning as
     `issueSession`'s impossible-travel send. */
  const user = await repo.findUserById(consumed.userId);
  if (user !== undefined) {
    await deps.deliver({ kind: 'password_changed', email: user.email });
  }

  return { status: 'reset' };
}

/* -------------------------------------------------------------------------- *
 * Internals
 * -------------------------------------------------------------------------- */

/**
 * Placeholder tenant for identity events.
 *
 * Registration and login happen before any organization is known, but the event
 * envelope requires an org id — every consumer partitions by it. A nil UUID says
 * "the platform itself" and is never a real tenant, so these events cannot land
 * in a customer's audit log by accident. Phase 2 revisits this when memberships
 * exist and a login can name the org it was for.
 */
// Annotated rather than inferred: an exported const whose type comes back as
// `Brand<string, 'OrgId'>` cannot be named across the package boundary (TS4023).
export const SYSTEM_ORG: OrgId = unsafeAsId<'OrgId'>('00000000-0000-7000-8000-000000000000');

async function assertPasswordAcceptable(deps: IdentityDeps, password: string): Promise<void> {
  if (password.length < 12) {
    // Length beats composition rules: `P@ssw0rd!` satisfies every character-class
    // policy ever written and is in every breach corpus. The breach check below
    // is what actually does the work.
    throw errors.validation({ password: 'Must be at least 12 characters.' });
  }

  const result = await deps.checkBreached(password);

  if (result.status === 'breached') {
    throw errors.validation({
      password: 'This password has appeared in a data breach. Please choose a different one.',
    });
  }

  if (result.status === 'unavailable' && deps.config.onBreachCheckUnavailable === 'deny') {
    throw errors.serviceUnavailable('Cannot verify password safety right now. Please try again.');
  }
}

/**
 * Creates a session and its first refresh token.
 *
 * Exported because passkey sign-in ends here too. Sharing it is the point: two
 * paths that mint sessions differently is how one of them ends up without
 * rotation, or with `authenticatedAt` set to the wrong thing.
 */
export async function issueSession(
  deps: IdentityDeps,
  userId: string,
  authenticatedAt: Date,
  now: Date,
  meta: RequestMeta,
  /** The channel that minted this session — stored so only its route may refresh it (§4.3). */
  channel: SessionChannel,
): Promise<TokenPair> {
  const sessionId = newId<'SessionId'>();
  const refreshToken = issueToken('refresh');
  const expiresAt = new Date(now.getTime() + deps.config.refreshTokenTtlMs);

  /* Impossible-travel detection (§3.4) — inside `issueSession`, not in the
     four callers, because the codebase's own standing lesson is that paths
     which mint sessions differently are how one of them ends up without the
     control. Runs BEFORE the insert so the flag is written with the row.

     The country is looked up and stored on EVERY login (not just flagged
     ones) — that is what lets the NEXT login compare against this one
     without a fresh lookup. The previous-session read is deferred until the
     new country is actually known, so a login whose IP resolves to nothing
     (private, reserved, unknown) never pays for the database read. */
  let country: string | null = null;
  let impossibleTravelAt: Date | null = null;
  let previousCountry: string | null = null;

  if (meta.ip !== null) {
    const lookup = deps.lookupCountry ?? countryOfIp;
    /* The fail-open lives HERE, at the call site, not only inside the default
       lookup: an informational control is never allowed to sit in the path
       that completes a sign-in, whatever lookup implementation is injected. */
    try {
      country = await lookup(meta.ip);
    } catch {
      country = null;
    }
    if (country !== null) {
      const previous = await repo.mostRecentActiveSession(userId, now);
      if (previous !== undefined && previous.country !== null && previous.country !== country) {
        const flagged = assessImpossibleTravel({
          previous: { country: previous.country, authenticatedAt: previous.authenticatedAt },
          newCountry: country,
          now,
        });
        if (flagged) {
          impossibleTravelAt = now;
          previousCountry = previous.country;
        }
      }
    }
  }

  await repo.createSession({
    sessionId,
    userId,
    authenticatedAt,
    expiresAt,
    ip: meta.ip,
    userAgent: meta.userAgent,
    country,
    impossibleTravelAt,
    channel,
    refreshToken: {
      id: newId<'RefreshTokenId'>(),
      tokenHash: refreshToken.hash,
      expiresAt,
    },
  });

  if (impossibleTravelAt !== null && previousCountry !== null && country !== null) {
    await deps.events.publish([
      createEvent(
        identityEvents.impossibleTravelDetected,
        { userId, sessionId, previousCountry, newCountry: country },
        { orgId: SYSTEM_ORG, actorId: null, occurredAt: now },
      ),
    ]);

    /* The person, not just the audit log — this is the one branch of login
       that a stolen password reaches with no other control in front of it
       (§3.4 is explicit that this flag is informational, never blocking, so
       it does not stop the sign-in itself). Looked up here rather than
       threaded through all four callers of `issueSession`: none of them
       currently carry the user's email this deep, and paying one extra read
       only on the rare flagged path is cheaper than widening every caller's
       signature for a lookup that almost never runs. Best-effort: a mail
       failure here must not turn a successful, already-committed sign-in
       into an error response. */
    const user = await repo.findUserById(userId);
    if (user !== undefined) {
      await deps.deliver({
        kind: 'impossible_travel',
        email: user.email,
        previousCountry,
        newCountry: country,
      });
    }
  }

  const accessToken = await signAccessToken(
    {
      userId,
      sessionId,
      authenticatedAt: Math.floor(authenticatedAt.getTime() / 1000),
    },
    { privateKey: deps.config.jwtPrivateKey },
  );

  return {
    accessToken,
    refreshToken: refreshToken.token,
    expiresInSeconds: ACCESS_TOKEN_TTL_SECONDS,
    sessionId,
  };
}

async function publishFailure(
  deps: IdentityDeps,
  now: Date,
  payload: {
    userId: string | null;
    email: string;
    reason: 'no_such_user' | 'bad_password' | 'locked' | 'unverified' | 'suspended';
    ip: string | null;
  },
): Promise<void> {
  await deps.events.publish([
    createEvent(identityEvents.loginFailed, payload, {
      orgId: SYSTEM_ORG,
      actorId: null,
      occurredAt: now,
    }),
  ]);
}

/** One error for every credential failure. See the comments at each call site. */
function invalidCredentials(): Error {
  return errors.invalidCredentials();
}

function invalidSession(): Error {
  return errors.tokenExpired();
}
