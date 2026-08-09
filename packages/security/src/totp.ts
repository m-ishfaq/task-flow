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

/**
 * Verifies a 6-digit code against a secret.
 *
 * `otplib`'s default window (±1 step, 30 seconds each side) absorbs ordinary
 * clock drift between the server and the phone without widening the replay
 * window enough to matter — a code is single-use in practice because the
 * next real code differs, not because this function tracks used codes.
 */
export function verifyTotpCode(code: string, secret: string): boolean {
  try {
    return authenticator.check(code, secret);
  } catch {
    // A malformed code (wrong length, non-digits) throws inside otplib rather
    // than returning false — normalized here so callers have one shape to
    // handle, not two.
    return false;
  }
}
