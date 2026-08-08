import { describe, expect, it } from 'vitest';
import {
  signTwilioRequest,
  twilioSignaturePayload,
  verifyTwilioSignature,
} from './twilio-signature.js';

/**
 * The vector below is Twilio's OWN published worked example
 * (https://www.twilio.com/docs/usage/security), copied verbatim — URL, params,
 * auth token, and expected signature.
 *
 * That matters more here than a self-generated round trip would. A test that
 * signs with this module and then verifies with this module passes even if the
 * concatenation order, the separator, or the hash algorithm is wrong, because
 * both halves are wrong together — and the failure would surface as every
 * genuine Twilio webhook being rejected in production, which is the shape of
 * bug that gets "fixed" by disabling verification for a path.
 *
 * Twilio's docs recommend using their SDK helper rather than implementing this.
 * We implement it because guardrail 5 wants one auditable file per primitive
 * rather than a crypto call graph inside a vendor package — and this vector is
 * the price of that choice: if Twilio ever changes the algorithm, this test
 * fails rather than a forged request succeeding.
 */
const VECTOR = {
  url: 'https://example.com/myapp.php?foo=1&bar=2',
  authToken: '12345',
  params: {
    CallSid: 'CA1234567890ABCDE',
    Caller: '+14158675310',
    Digits: '1234',
    From: '+14158675310',
    To: '+18005551212',
  },
  signature: 'L/OH5YylLD5NRKLltdqwSvS0BnU=',
} as const;

describe('twilioSignaturePayload', () => {
  it('concatenates the URL with sorted key+value pairs and no separators', () => {
    expect(twilioSignaturePayload(VECTOR.url, VECTOR.params)).toBe(
      'https://example.com/myapp.php?foo=1&bar=2' +
        'CallSidCA1234567890ABCDE' +
        'Caller+14158675310' +
        'Digits1234' +
        'From+14158675310' +
        'To+18005551212',
    );
  });

  it('sorts by key, not by insertion order', () => {
    const reversed = { To: 'b', CallSid: 'a' };
    expect(twilioSignaturePayload('https://x/', reversed)).toBe('https://x/CallSidaTob');
  });

  it('sorts case-sensitively, uppercase before lowercase', () => {
    // ASCII order, which is what Twilio uses. `localeCompare` would put 'a'
    // before 'B' in most locales and produce a signature that verifies on the
    // developer's machine and fails on the server's.
    expect(twilioSignaturePayload('https://x/', { a: '1', B: '2' })).toBe('https://x/B2a1');
  });
});

describe('verifyTwilioSignature', () => {
  it("accepts Twilio's own published example", () => {
    expect(
      verifyTwilioSignature({
        url: VECTOR.url,
        signature: VECTOR.signature,
        params: VECTOR.params,
        authToken: VECTOR.authToken,
      }),
    ).toBe(true);
  });

  it('rejects a tampered parameter value', () => {
    // The whole point of the control: a forwarded call whose `To` has been
    // rewritten to a premium-rate number must not verify.
    expect(
      verifyTwilioSignature({
        url: VECTOR.url,
        signature: VECTOR.signature,
        params: { ...VECTOR.params, To: '+19005550000' },
        authToken: VECTOR.authToken,
      }),
    ).toBe(false);
  });

  it('rejects an added parameter', () => {
    expect(
      verifyTwilioSignature({
        url: VECTOR.url,
        signature: VECTOR.signature,
        params: { ...VECTOR.params, Extra: 'x' },
        authToken: VECTOR.authToken,
      }),
    ).toBe(false);
  });

  it('rejects a different URL, including a changed query string', () => {
    expect(
      verifyTwilioSignature({
        url: 'https://example.com/myapp.php?foo=1&bar=3',
        signature: VECTOR.signature,
        params: VECTOR.params,
        authToken: VECTOR.authToken,
      }),
    ).toBe(false);
  });

  it('rejects the wrong auth token', () => {
    expect(
      verifyTwilioSignature({
        url: VECTOR.url,
        signature: VECTOR.signature,
        params: VECTOR.params,
        authToken: '12346',
      }),
    ).toBe(false);
  });

  it('rejects an empty signature rather than comparing against one', () => {
    expect(
      verifyTwilioSignature({
        url: VECTOR.url,
        signature: '',
        params: VECTOR.params,
        authToken: VECTOR.authToken,
      }),
    ).toBe(false);
  });

  it('agrees with signTwilioRequest, and that signer reproduces the published vector', () => {
    /* Asserted against the PUBLISHED signature, not just round-tripped: a
       signer and verifier that are wrong together agree perfectly. */
    expect(
      signTwilioRequest({
        url: VECTOR.url,
        params: VECTOR.params,
        authToken: VECTOR.authToken,
      }),
    ).toBe(VECTOR.signature);
  });

  it('rejects an empty auth token, which would otherwise be a valid HMAC key', () => {
    /* The failure being prevented is a misconfigured environment, not an
       attacker: with `authToken: ''` every request could be signed by anyone
       who knows the algorithm, and each one would verify perfectly. */
    const forged = verifyTwilioSignature({
      url: VECTOR.url,
      signature: 'anything',
      params: VECTOR.params,
      authToken: '',
    });
    expect(forged).toBe(false);
  });
});
