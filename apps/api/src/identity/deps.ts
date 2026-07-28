import { InMemoryEventBus, type EventBus } from '@taskflow/events';
import { checkPasswordBreached, relyingPartyFrom } from '@taskflow/security';
import type { Env } from '../config/env.js';
import type { DeliverableLink, IdentityDeps } from './identity.service.js';
import type { PasskeyDeps } from './passkey.service.js';

/**
 * Wiring for the identity service.
 *
 * The values here are the ones with security consequences, so each carries the
 * reasoning for the number rather than just the number.
 */

/** 30 days (§8.1). Bounded by rotation: a stolen token is dead at the next refresh. */
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * 24 hours for a verification link.
 *
 * Long enough to survive a mail delay and a night's sleep; short enough that a
 * link sitting in an abandoned inbox is not a permanent account takeover.
 */
const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * One hour for a password reset.
 *
 * Much shorter than verification, because the capability is much larger: this
 * link IS the credential. It is also single-use and revokes every session on
 * completion.
 */
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;

/**
 * Five failures, then fifteen minutes.
 *
 * A tension with no clean answer: lockout stops online guessing and hands an
 * attacker a denial-of-service against a known account. The compromise is a
 * SHORT, automatically-expiring lock rather than one an administrator must
 * clear, so the worst case is fifteen minutes of inconvenience instead of a
 * support ticket. Per-IP rate limiting handles the distributed case and lands
 * with the gateway.
 */
const LOCK_THRESHOLD = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000;

export interface BuildIdentityDepsOptions {
  readonly env: Env;
  readonly events?: EventBus;
  /**
   * How verification and reset links reach a user.
   *
   * REQUIRED rather than defaulted, because the default would have to construct
   * a mail queue that something else then has to drain on shutdown — and an
   * owner nobody can name is an owner that never closes it. `buildServer`
   * constructs the real one and registers its shutdown.
   */
  readonly deliver: (message: DeliverableLink) => Promise<void>;
}

export function buildIdentityDeps(options: BuildIdentityDepsOptions): IdentityDeps {
  return {
    config: {
      jwtSecret: new Uint8Array(Buffer.from(options.env.JWT_SECRET, 'base64')),
      refreshTokenTtlMs: REFRESH_TOKEN_TTL_MS,
      verificationTtlMs: VERIFICATION_TTL_MS,
      passwordResetTtlMs: PASSWORD_RESET_TTL_MS,
      lockThreshold: LOCK_THRESHOLD,
      lockDurationMs: LOCK_DURATION_MS,

      /**
       * Fail OPEN when HIBP is unreachable, and this is a deliberate choice
       * rather than a default.
       *
       * Failing closed means a third-party outage blocks every registration and
       * every password change — including the change someone is making BECAUSE
       * they were just breached. The control is valuable but not load-bearing:
       * Argon2id, rate limiting, and lockout all still apply to a reused
       * password. The `unavailable` result is emitted as an event so the gap is
       * visible rather than silent.
       */
      onBreachCheckUnavailable: 'allow',
    },

    events: options.events ?? new InMemoryEventBus(),
    checkBreached: (password) => checkPasswordBreached(password),

    deliver: options.deliver,
  };
}

/**
 * User-visible relying party name.
 *
 * Shown by the authenticator when the user picks a passkey — "Use your passkey
 * for TaskFlow?" — so it has to be the product name a person recognizes, not a
 * hostname.
 */
const RELYING_PARTY_NAME = 'TaskFlow';

/**
 * Adds the WebAuthn relying party to the identity dependencies.
 *
 * Derived from `WEB_ORIGIN` at boot, once. That is the anti-phishing property of
 * WebAuthn made concrete: the origin a ceremony is checked against comes from
 * configuration, and there is no code path by which a request can influence it.
 */
export function buildPasskeyDeps(identity: IdentityDeps, env: Env): PasskeyDeps {
  return { ...identity, relyingParty: relyingPartyFrom(env.WEB_ORIGIN, RELYING_PARTY_NAME) };
}
