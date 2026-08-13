import { describe, expect, it } from 'vitest';
import { signGitHubRequest, verifyGitHubSignature } from './github-signature.js';

/**
 * The vector below is a KNOWN-ANSWER test, pinned at development time:
 *
 *   secret = 'github-signature-test-secret'
 *   body   = '{"action":"opened","repository":{"full_name":"acme/todo"}}'
 *   sha256 = HMAC-SHA256(secret, body) hex
 *
 * computed with `node -e "require('crypto').createHmac('sha256', secret)
 * .update(body).digest('hex')"` and asserted here as a constant.
 *
 * GitHub's own documentation (securing-your-webhooks) walks through the
 * algorithm but publishes no fixed worked example, so unlike the Twilio and
 * Slack suites there is no vendor vector to copy verbatim. A pinned
 * known-answer is the honest substitute: it proves the digest encoding and
 * the `sha256=` framing against a fixed output rather than against the
 * module's own signer — a signer and verifier that are wrong together agree
 * perfectly, which is the failure this constant exists to rule out.
 *
 * The shared-secret rounds below use the module's own signer for their
 * positive case, which is acceptable because the fixed constant above already
 * pins the algorithm; the negative cases are what carry the test's weight.
 */
const VECTOR = {
  secret: 'github-signature-test-secret',
  body: '{"action":"opened","repository":{"full_name":"acme/todo"}}',
  signature: 'sha256=d8f6f3d413803e9f96d374b69c89939a28ff2aba1807deb62a7ff66ac98b573d',
} as const;

describe('verifyGitHubSignature', () => {
  it('accepts the pinned known-answer vector', () => {
    expect(
      verifyGitHubSignature({
        signature: VECTOR.signature,
        body: VECTOR.body,
        secret: VECTOR.secret,
      }),
    ).toBe(true);
  });

  it('rejects a tampered body — the signature covers the exact bytes', () => {
    expect(
      verifyGitHubSignature({
        signature: VECTOR.signature,
        body: VECTOR.body.replace('"opened"', '"closed"'),
        secret: VECTOR.secret,
      }),
    ).toBe(false);
  });

  it('rejects the wrong secret', () => {
    expect(
      verifyGitHubSignature({
        signature: VECTOR.signature,
        body: VECTOR.body,
        secret: 'another-secret',
      }),
    ).toBe(false);
  });

  it('rejects a header without the lowercase sha256= prefix', () => {
    expect(
      verifyGitHubSignature({
        signature: VECTOR.signature.replace('sha256=', 'SHA256='),
        body: VECTOR.body,
        secret: VECTOR.secret,
      }),
    ).toBe(false);
  });

  it('rejects an empty secret, which would otherwise be a valid HMAC key', () => {
    /* The failure being prevented is a misconfigured environment, not an
       attacker: with an empty secret every request could be signed by anyone
       who knows the algorithm, and each one would verify perfectly. */
    expect(
      verifyGitHubSignature({ signature: VECTOR.signature, body: VECTOR.body, secret: '' }),
    ).toBe(false);
  });

  it('rejects an empty signature rather than comparing against one', () => {
    expect(verifyGitHubSignature({ signature: '', body: VECTOR.body, secret: VECTOR.secret })).toBe(
      false,
    );
  });

  it('round-trips through signGitHubRequest', () => {
    /* The fixed constant above pins the algorithm; this proves the signer and
       verifier agree on a fresh body. */
    const signature = signGitHubRequest({ secret: VECTOR.secret, body: VECTOR.body });
    expect(signature).toBe(VECTOR.signature);
    expect(verifyGitHubSignature({ signature, body: VECTOR.body, secret: VECTOR.secret })).toBe(
      true,
    );
  });
});
