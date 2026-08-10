import { authenticator } from 'otplib';

/**
 * Generates a valid TOTP code for a secret, standing in for the authenticator
 * app a real enrollment would use. Test-only — nothing in the product needs
 * to produce a code, only to verify one (`verifyTotpCode` in `../totp.ts`).
 */
export function generateTotpCode(secret: string): string {
  return authenticator.generate(secret);
}
