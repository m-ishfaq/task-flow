import { describe, expect, it } from 'vitest';
import {
  signSlackRequest,
  slackSignaturePayload,
  verifySlackSignature,
} from './slack-signature.js';

/**
 * The vector below is Slack's OWN published worked example
 * (https://api.slack.com/authentication/verifying-requests-from-slack),
 * copied verbatim — signing secret, timestamp, body, and expected signature.
 *
 * That matters more here than a self-generated round trip would. A test that
 * signs with this module and then verifies with this module passes even if the
 * concatenation order, the digest encoding, or the hash algorithm is wrong,
 * because both halves are wrong together — and the failure would surface as
 * every genuine Slack webhook being rejected in production, which is the shape
 * of bug that gets "fixed" by disabling verification for a path.
 */
const VECTOR = {
  signingSecret: '8f742231b10e8888abcd99yyyzzz85a5',
  timestamp: '1531420618',
  body:
    'token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow' +
    '&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA' +
    '&user_name=roadrunner&command=%2Fwebhook-collect&text=' +
    '&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554' +
    '%2F96rGlfmibIGlgcZRskXaIFfN' +
    '&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c',
  signature: 'v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503',
} as const;

const verify = (overrides: Partial<Parameters<typeof verifySlackSignature>[0]> = {}) =>
  verifySlackSignature({ ...VECTOR, now: Number(VECTOR.timestamp), ...overrides });

describe('slackSignaturePayload', () => {
  it('concatenates version, timestamp and body with colons, in that order', () => {
    expect(slackSignaturePayload(VECTOR.timestamp, VECTOR.body)).toBe(
      `v0:${VECTOR.timestamp}:${VECTOR.body}`,
    );
  });
});

describe('verifySlackSignature', () => {
  it("accepts Slack's own published example", () => {
    expect(verify()).toBe(true);
  });

  it('rejects a tampered body — the signature covers the exact bytes', () => {
    expect(
      verify({
        body: VECTOR.body.replace('text=', 'text=hello'),
      }),
    ).toBe(false);
  });

  it('rejects a stale timestamp even though the signature is valid', () => {
    /* The whole point of the freshness window: a captured request carries a
       PERFECTLY VALID signature forever — the timestamp is inside the signed
       string — and the window is what makes it worthless. Five minutes plus
       one second must refuse. */
    expect(verify({ now: Number(VECTOR.timestamp) + 301 })).toBe(false);
  });

  it('accepts a timestamp at the edge of the window', () => {
    expect(verify({ now: Number(VECTOR.timestamp) + 300 })).toBe(true);
  });

  it('rejects the wrong signing secret', () => {
    expect(verify({ signingSecret: 'a'.repeat(32) })).toBe(false);
  });

  it('rejects a non-v0 header shape', () => {
    expect(verify({ signature: VECTOR.signature.replace('v0=', 'v1=') })).toBe(false);
  });

  it('rejects an empty signing secret, which would otherwise be a valid HMAC key', () => {
    /* The failure being prevented is a misconfigured environment, not an
       attacker: with an empty secret every request could be signed by anyone
       who knows the algorithm, and each one would verify perfectly. */
    expect(verify({ signingSecret: '' })).toBe(false);
  });

  it('rejects a non-numeric timestamp header', () => {
    expect(verify({ timestamp: 'soon' })).toBe(false);
  });

  it('rejects an empty signature rather than comparing against one', () => {
    expect(verify({ signature: '' })).toBe(false);
  });

  it('agrees with signSlackRequest, and that signer reproduces the published vector', () => {
    /* Asserted against the PUBLISHED signature, not just round-tripped: a
       signer and verifier that are wrong together agree perfectly. */
    expect(
      signSlackRequest({
        timestamp: VECTOR.timestamp,
        body: VECTOR.body,
        signingSecret: VECTOR.signingSecret,
      }),
    ).toBe(VECTOR.signature);
  });
});
