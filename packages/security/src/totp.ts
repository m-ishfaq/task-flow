import { authenticator } from 'otplib';

/**
 * TOTP — time-based one-time codes as a second factor (Phase 12 Wave 2 §3.2,
 * PLAN.md §4.2's own tech-stack choice: `otplib`).
 *
 * ⚠ HUMAN REVIEW SURFACE (§2.2) — a new way into an account, the same
 * severity class as password and passkey auth.
 *
 * `otplib`'s defaults (30-second step, 6 digits, SHA-1 per RFC 6238) are used
 * unchanged — SHA-1 is the algorithm every authenticator app (Google
 * Authenticator, Authy, 1Password) actually implements; a "stronger" hash
 * here would just fail to scan.
 */

/** A fresh, random TOTP secret, base32-encoded per RFC 4648 (what authenticator apps expect). */
export function generateTotpSecret(): string {
  return authenticator.generateSecret();
}

/**
 * The `otpauth://` URI an authenticator app scans as a QR code.
 *
 * `accountLabel` is the user's email — what the app shows under the entry.
 * `issuer` is fixed to `'TaskFlow'` rather than taking a parameter: every
 * account in this system enrolls against the same issuer, and a caller-
 * supplied issuer string would let a bug (or a compromised caller) forge an
 * entry that LOOKS like it belongs to a different service.
 */
export function totpProvisioningUri(accountLabel: string, secret: string): string {
  return authenticator.keyuri(accountLabel, 'TaskFlow', secret);
}

/** The 30-second step TOTP counts in, per RFC 6238's default. */
const STEP_SECONDS = 30;

/** A verdict plus the time-step it applies to, so a caller can retire that step. */
export interface TotpVerification {
  readonly valid: boolean;
  /**
   * The step the code matched, or the current step when it did not.
   *
   * Only meaningful when `valid` — a caller stores it as `last_used_step` and
   * refuses anything at or below it next time.
   */
  readonly step: number;
}

/**
 * Verifies a 6-digit code against a secret, and says WHICH time-step matched.
 *
 * ## Why this returns a step rather than a boolean
 *
 * `otplib`'s default window is ±1 step, so a code is valid for up to 90
 * seconds. This function used to return a boolean and its comment claimed "a
 * code is single-use in practice because the next real code differs" — which
 * is not what single-use means: within that window the SAME code verified
 * every time it was submitted, so a code captured once was replayable.
 *
 * RFC 6238 §5.2 requires the verifier to refuse a second use of one time-step,
 * and the only way a caller can enforce that is to know which step it just
 * accepted. So the step comes back, the caller compares it against the last
 * one it stored, and `identity.totp_credentials.last_used_step` (migration
 * 0077) is where that comparison lives.
 *
 * The step is checked from the newest candidate downward, so a code valid at
 * two steps (possible only if the secret produces a collision) resolves to the
 * later one — the conservative direction, since storing the later step retires
 * both.
 */
export function verifyTotpCode(code: string, secret: string): TotpVerification {
  const current = Math.floor(Date.now() / 1000 / STEP_SECONDS);

  try {
    /* `checkDelta` returns how many steps off `now` the code matched, or null.
       Used rather than a hand-rolled search over the ±1-step window because
       it is otplib's own answer to the question, computed with the same
       window the library applies inside `check()` — a second implementation
       here could drift from the one actually accepting codes, and the two
       disagreeing is precisely how a replay check ends up guarding a step
       that was never the one accepted. */
    const delta = authenticator.checkDelta(code, secret);
    if (delta === null) return { valid: false, step: current };
    return { valid: true, step: current + delta };
  } catch {
    // A malformed code (wrong length, non-digits) or secret throws inside
    // otplib rather than returning null — normalized here so callers have one
    // shape to handle, not two.
    return { valid: false, step: current };
  }
}
