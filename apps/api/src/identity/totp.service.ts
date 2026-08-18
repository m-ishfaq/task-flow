import { errors, unsafeAsId } from '@taskflow/contracts';
import { createEvent } from '@taskflow/events';
import {
  decryptString,
  encryptString,
  generateTotpSecret,
  hashPassword,
  identityFieldAad,
  issueHumanCode,
  totpProvisioningUri,
  verifyPassword,
  verifyTotpChallenge,
  verifyTotpCode,
} from '@taskflow/security';
import * as repo from './repository.js';
import * as identityEvents from './events.js';
import { SYSTEM_ORG, issueSession, type IdentityDeps, type TokenPair } from './identity.service.js';

/**
 * TOTP as a second factor (Phase 12 Wave 2 §3.2, ai/phase-12-wave2.md).
 *
 * ⚠ HUMAN REVIEW SURFACE (§2.2) — a new way into an account.
 *
 * ## Enrollment is two calls, not one
 *
 * `startEnrollment` generates a secret and stores it UNCONFIRMED —
 * `confirmed_at IS NULL`. `confirmEnrollment` is the only thing that can set
 * it, and only after a real code from the authenticator app checks out. An
 * unconfirmed row is unusable for login or step-up (every read below checks
 * `confirmedAt !== null`), which is what stops an enrollment interrupted
 * mid-flow — network drop, browser closed after scanning but before typing
 * the first code — from silently locking someone out of an account they
 * never finished securing.
 *
 * ## The secret is encrypted, not hashed
 *
 * Unlike a password, a TOTP secret has to be read back to VERIFY a future
 * code — Argon2id (one-way) cannot do that. It is encrypted under the
 * identity-scoped data key (`packages/security`'s `identityFieldAad`,
 * `main.ts`'s boot-time unwrap), the first real `KeyProvider` consumer in
 * this codebase — see `ai/phase-12-wave2.md` §1 for why that key is
 * identity-scoped rather than per-org.
 *
 * `identityDataKey` is threaded as a SIBLING of `identity: IdentityDeps`
 * rather than folded into `IdentityDeps` itself — `IdentityDeps` is
 * constructed synchronously (`deps.ts`'s `buildIdentityDeps`) from env
 * alone, and unwrapping the data key needs a real database read at boot
 * (`main.ts`). Extending the shared type would mean every existing
 * `IdentityDeps` construction site — every test fixture included — now owes
 * it a value it does not otherwise need.
 */

export interface TotpDeps {
  readonly identity: IdentityDeps;
  readonly identityDataKey: Uint8Array;
}

const clock = (deps: TotpDeps): Date => (deps.identity.now ?? (() => new Date()))();

/**
 * Records a refused second factor.
 *
 * Its own helper rather than an inline `publish` at each site for the reason
 * `identity.service.ts`'s `publishFailure` is: there are three refusal paths
 * here (locked, wrong code, wrong recovery code) and every one of them must
 * leave the same trace. A branch that forgets is invisible — the caller still
 * gets its refusal, and only the audit chain is quietly thinner.
 */
async function publishSecondFactorFailure(
  deps: TotpDeps,
  now: Date,
  payload: {
    readonly userId: string;
    readonly method: 'totp' | 'recovery';
    readonly reason: 'bad_code' | 'locked';
    readonly ip: string | null;
  },
): Promise<void> {
  await deps.identity.events.publish([
    createEvent(identityEvents.secondFactorFailed, payload, {
      orgId: SYSTEM_ORG,
      actorId: null,
      occurredAt: now,
    }),
  ]);
}

function aadFor(userId: string): string {
  return identityFieldAad({
    table: 'totp_credentials',
    column: 'secret_encrypted',
    rowId: userId,
  });
}

export async function startEnrollment(
  deps: TotpDeps,
  input: { userId: string; email: string },
): Promise<{ secret: string; otpauthUrl: string }> {
  const secret = generateTotpSecret();
  const encrypted = Buffer.from(encryptString(deps.identityDataKey, secret, aadFor(input.userId)));

  await repo.upsertPendingTotp(input.userId, encrypted);

  return { secret, otpauthUrl: totpProvisioningUri(input.email, secret) };
}

export interface ConfirmEnrollmentResult {
  readonly recoveryCodes: readonly string[];
}

export async function confirmEnrollment(
  deps: TotpDeps,
  input: { userId: string; code: string },
): Promise<ConfirmEnrollmentResult> {
  const now = clock(deps);
  const credential = await repo.getTotpCredential(input.userId);

  if (!credential) {
    throw errors.validation({
      code: 'No TOTP enrollment in progress. Start enrollment first.',
    });
  }

  const secret = decryptString(
    deps.identityDataKey,
    credential.secretEncrypted,
    aadFor(input.userId),
  );

  /* Enrollment deliberately does NOT retire the step. Confirming an
     enrollment proves possession of the authenticator; it is not a login, and
     spending the step here would refuse the very next real sign-in if it
     happened within the same 30 seconds — which is exactly what a person
     finishing setup does. Replay of a confirmation code buys nothing: the
     credential is already confirmed after the first one. */
  if (!verifyTotpCode(input.code, secret).valid) {
    throw errors.validation({
      code: 'That code is not valid. Check the time on your device and try again.',
    });
  }

  await repo.confirmTotp(input.userId, now);

  /* Ten codes, issued exactly once — the same "shown once, gone forever"
     discipline a passkey's own secret already gets. Argon2id, the same
     primitive as `users.passwordHash`, deliberately NOT `issueHumanCode`'s
     own SHA-256 hash: a recovery code is short enough (12 characters from a
     32-symbol alphabet) that a fast hash would be brute-forceable offline if
     the hash ever leaked, unlike the 256-bit bearer tokens SHA-256 is used
     for elsewhere in this module. */
  const codes = Array.from({ length: 10 }, () => issueHumanCode().token);
  const hashes = await Promise.all(codes.map((code) => hashPassword(code)));
  await repo.insertRecoveryCodes(input.userId, hashes);

  await deps.identity.events.publish([
    createEvent(
      identityEvents.totpEnrolled,
      { userId: input.userId },
      { orgId: SYSTEM_ORG, actorId: unsafeAsId<'UserId'>(input.userId), occurredAt: now },
    ),
  ]);

  /* Security-relevant account change, told to the person it happened to —
     the same reasoning `issueSession`'s impossible-travel send gives.
     Best-effort: a mail failure must not undo a TOTP enrollment that
     already succeeded. */
  const user = await repo.findUserById(input.userId);
  if (user !== undefined) {
    await deps.identity.deliver({ kind: 'totp_enabled', email: user.email });
  }

  return { recoveryCodes: codes };
}

export async function disable(deps: TotpDeps, input: { userId: string }): Promise<void> {
  await repo.deleteTotp(input.userId);

  await deps.identity.events.publish([
    createEvent(
      identityEvents.totpDisabled,
      { userId: input.userId },
      { orgId: SYSTEM_ORG, actorId: unsafeAsId<'UserId'>(input.userId), occurredAt: clock(deps) },
    ),
  ]);
}

/**
 * Whether this account has a CONFIRMED credential — the account page's own
 * question, distinct from every other read in this file. `getTotpCredential`
 * returns an unconfirmed row too (an enrollment interrupted mid-flow, §"the
 * secret is encrypted, not hashed" above), and the UI must not read that as
 * "enabled": doing so would show a Disable button for a factor that cannot
 * actually complete a login, and the secret it would disable was already
 * unusable. Deliberately does not decrypt or return the secret — this is a
 * status probe, not an enrollment read.
 */
export async function status(input: { userId: string }): Promise<{ enabled: boolean }> {
  const credential = await repo.getTotpCredential(input.userId);
  return { enabled: credential?.confirmedAt != null };
}

/**
 * Completes a login or step-up held by `identity.login()`'s
 * `totp_required` challenge — a 6-digit code from the app, or a recovery
 * code, either one redeemable exactly once (a recovery code cannot
 * authenticate twice; a TOTP code's own 30-second step makes a REPLAY of
 * the same code within the window the one gap this function does not close,
 * the identical trade `otplib`'s own verification window accepts for clock
 * drift — see `packages/security/src/totp.ts`).
 */
export async function verifyLogin(
  deps: TotpDeps,
  input: {
    challengeToken: string;
    credential: { kind: 'totp'; code: string } | { kind: 'recovery'; code: string };
  },
  meta: { ip: string | null; userAgent: string | null },
): Promise<TokenPair> {
  const { userId } = await verifyTotpChallenge(input.challengeToken, {
    secret: deps.identity.config.jwtSecret,
  });
  const now = clock(deps);

  const credential = await repo.getTotpCredential(userId);
  if (!credential?.confirmedAt) {
    // The account disabled TOTP between issuing the challenge and redeeming
    // it — the challenge is now meaningless, not merely stale.
    throw errors.validation({
      credential: 'Two-factor authentication is no longer enabled on this account.',
    });
  }

  const method = input.credential.kind === 'totp' ? ('totp' as const) : ('recovery' as const);

  /* A locked account stays locked at the second factor too — the same
     reasoning `passkey.service.ts` gives for its own copy of this check. The
     lockout exists because an account is under attack, and a challenge minted
     before the lock landed must not outlive it. `login()` refuses to issue a
     NEW challenge for a locked account, so without this the 5-minute window on
     an already-issued one was the gap. */
  const user = await repo.findUserById(userId);
  if (user?.lockedUntil && user.lockedUntil > now) {
    await publishSecondFactorFailure(deps, now, { userId, method, reason: 'locked', ip: meta.ip });
    throw errors.validation({ code: 'That code is not valid.' });
  }

  /* One code, one use (migration 0077).

     `verifyTotpCode` reports WHICH time-step matched, and `claimTotpStep`
     retires it with a conditional UPDATE. Both halves are needed: otplib
     accepts a ±1-step window, so a code stays cryptographically valid for up
     to 90 seconds, and nothing here recorded that it had been spent. A code
     captured from a shoulder-surf, a phishing relay, or a request body that
     reached a log could be replayed for the rest of that window.

     The claim is conditional rather than read-then-write because two requests
     replaying one code arrive together by construction — that is what a replay
     is — and a service-side comparison would let both pass before either
     wrote. Recovery codes need none of this: `claimRecoveryCode` already
     spends them exactly once. */
  let ok: boolean;
  if (input.credential.kind === 'totp') {
    const verification = verifyTotpCode(
      input.credential.code,
      decryptString(deps.identityDataKey, credential.secretEncrypted, aadFor(userId)),
    );
    ok = verification.valid && (await repo.claimTotpStep(userId, verification.step));
  } else {
    ok = await verifyRecoveryCode(userId, input.credential.code, now);
  }

  if (!ok) {
    /* The counter, the lockout and the audit trail — none of which this branch
       had. The password factor has all three (`identity.service.ts`'s own
       `!correct` branch), so an attacker holding a phished password faced a
       5-per-15-minutes lockout on the first factor and an unlimited, silent
       guessing loop on the second. Six digits with otplib's ±1 window is three
       valid codes in a million; at the volumetric limit alone that is a real
       chance per account per day, and it left nothing in the audit chain.

       `recordFailedLogin` is shared with the password and passkey paths on
       purpose: a lock earned at any door closes all of them. */
    const state = await repo.recordFailedLogin(
      userId,
      deps.identity.config.lockThreshold,
      deps.identity.config.lockDurationMs,
      now,
    );

    await publishSecondFactorFailure(deps, now, {
      userId,
      method,
      reason: 'bad_code',
      ip: meta.ip,
    });

    if (state?.lockedUntil && state.lockedUntil > now) {
      await deps.identity.events.publish([
        createEvent(
          identityEvents.accountLocked,
          {
            userId,
            until: state.lockedUntil.toISOString(),
            failedAttempts: state.failedLoginCount,
          },
          { orgId: SYSTEM_ORG, actorId: null, occurredAt: now },
        ),
      ]);
    }

    throw errors.validation({ code: 'That code is not valid.' });
  }

  const pair = await issueSession(deps.identity, userId, now, now, meta);

  await deps.identity.events.publish([
    createEvent(
      identityEvents.userLoggedIn,
      {
        userId,
        sessionId: pair.sessionId,
        method: 'totp' as const,
        ip: meta.ip,
        userAgent: meta.userAgent,
      },
      { orgId: SYSTEM_ORG, actorId: null, occurredAt: now },
    ),
  ]);

  await repo.clearLoginFailures(userId, now);
  return pair;
}

async function verifyRecoveryCode(userId: string, code: string, now: Date): Promise<boolean> {
  const candidates = await repo.findUnusedRecoveryCodes(userId);

  /* Sequential, deliberately: Argon2id is slow by design, and running these
     concurrently would multiply CPU cost per login attempt by up to ten for
     no benefit — recovery-code lookups are rare and never on a hot path. */
  for (const candidate of candidates) {
    if (await verifyPassword(code, candidate.codeHash)) {
      return repo.claimRecoveryCode(candidate.id, now);
    }
  }

  return false;
}
