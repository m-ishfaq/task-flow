import { describe, expect, it } from 'vitest';
import { PhoneNumberSchema } from '@taskflow/contracts';
import { describeTelephonyProviderContract } from './contract-test.js';
import { FakeTelephonyProvider } from './fake.js';

describeTelephonyProviderContract('FakeTelephonyProvider', () => new FakeTelephonyProvider());

describe('FakeTelephonyProvider', () => {
  it('reports itself as not live', () => {
    // Tests that assert "no real money was spent" need to be able to prove they
    // were talking to test credentials, rather than assume it.
    expect(new FakeTelephonyProvider().isLive).toBe(false);
  });

  it('refuses a destination the geo allowlist denies', async () => {
    /* The fake enforces this so that a test asserting "the gate blocked it"
       cannot pass against a gate that is not wired up: without this, a missing
       gate would show as a successfully "placed" call to a premium Caribbean
       number and the test would go green. */
    const provider = new FakeTelephonyProvider();
    const account = await provider.createSubaccount({ friendlyName: 'org' });

    await expect(
      provider.placeCall({
        subaccountSid: account.sid,
        from: PhoneNumberSchema.parse('+14155550199'),
        to: PhoneNumberSchema.parse('+18095550100'),
        instructionsUrl: 'https://example.test/voice',
        statusCallbackUrl: 'https://example.test/status',
      }),
    ).rejects.toThrow(/disallowed destination/);

    expect(provider.calls).toHaveLength(0);
  });

  it('tracks spend so a test can assert nothing was spent', async () => {
    const provider = new FakeTelephonyProvider();
    expect(provider.spentCents).toBe(0);

    const account = await provider.createSubaccount({ friendlyName: 'org' });
    await provider.sendSms({
      subaccountSid: account.sid,
      from: PhoneNumberSchema.parse('+14155550199'),
      to: PhoneNumberSchema.parse('+14155550100'),
      body: 'hi',
      statusCallbackUrl: 'https://example.test/status',
    });

    expect(provider.spentCents).toBeGreaterThan(0);
  });

  it('approves the fixed verification code and nothing else', async () => {
    const provider = new FakeTelephonyProvider();
    const to = PhoneNumberSchema.parse('+14155550100');
    await provider.startVerification({ to, channel: 'sms' });

    expect((await provider.checkVerification({ to, code: '123456' })).approved).toBe(true);
    expect((await provider.checkVerification({ to, code: '654321' })).approved).toBe(false);
  });

  it('does not approve a code for a number no verification was started for', async () => {
    const provider = new FakeTelephonyProvider();
    const check = await provider.checkVerification({
      to: PhoneNumberSchema.parse('+14155550111'),
      code: '123456',
    });
    expect(check.approved).toBe(false);
  });
});
