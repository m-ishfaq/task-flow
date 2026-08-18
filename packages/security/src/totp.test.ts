import { describe, expect, it } from 'vitest';
import { generateTotpCode } from './testing/totp.js';
import { generateTotpSecret, totpProvisioningUri, verifyTotpCode } from './totp.js';

describe('generateTotpSecret', () => {
  it('produces a distinct base32 secret each time', () => {
    const a = generateTotpSecret();
    const b = generateTotpSecret();

    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Z2-7]+$/);
  });
});

describe('totpProvisioningUri', () => {
  it('embeds the account label, the secret, and the fixed issuer', () => {
    const secret = generateTotpSecret();
    const uri = totpProvisioningUri('alice@example.test', secret);

    expect(uri).toMatch(/^otpauth:\/\/totp\//);
    expect(uri).toContain(encodeURIComponent('alice@example.test'));
    expect(uri).toContain(`secret=${secret}`);
    expect(uri).toContain('issuer=TaskFlow');
  });
});

describe('verifyTotpCode', () => {
  it('accepts the current code for the secret', () => {
    const secret = generateTotpSecret();
    expect(verifyTotpCode(generateTotpCode(secret), secret).valid).toBe(true);
  });

  it('rejects a code generated for a different secret', () => {
    const secret = generateTotpSecret();
    const other = generateTotpSecret();
    expect(verifyTotpCode(generateTotpCode(other), secret).valid).toBe(false);
  });

  it('rejects an arbitrary wrong code', () => {
    const secret = generateTotpSecret();
    const wrong = generateTotpCode(secret) === '000000' ? '111111' : '000000';
    expect(verifyTotpCode(wrong, secret).valid).toBe(false);
  });

  it('normalizes a malformed code to false rather than throwing', () => {
    const secret = generateTotpSecret();
    expect(verifyTotpCode('not-a-code', secret).valid).toBe(false);
    expect(verifyTotpCode('', secret).valid).toBe(false);
  });
});
