import { describe, expect, it } from 'vitest';
import { buildWebhookSignature, verifyWebhookSignature } from './webhook-signing.js';

/**
 * Outbound webhook signing (ai/phase-10-automation.md §5).
 *
 * The RECEIVER'S check is the whole point, so the verify side here uses the
 * real primitive rather than a stub: a signing test whose verify is mocked
 * asserts that signing works on trusted input, which is the one case it is
 * not defending against. `verifyWebhookSignature` exists for exactly this
 * reason — see its own header.
 */

const SECRET = 'tf_whs_0123456789abcdef0123456789abcdef';
const BODY = JSON.stringify({
  eventId: '0195ee30-0000-7000-8000-0000000000aa',
  eventName: 'card.status_changed',
  orgId: '0195ee30-0000-7000-8000-0000000000bb',
  occurredAt: '2026-08-11T12:00:00.000Z',
  payload: { cardId: '0195ee30-0000-7000-8000-0000000000cc' },
});

describe('buildWebhookSignature / verifyWebhookSignature', () => {
  it('round-trips: a receiver with the secret and the raw body accepts it', () => {
    const signature = buildWebhookSignature(SECRET, BODY);

    /* The timestamp defaults to now, so verify with a fresh window. This is
       the shape of the receiver's own call. */
    expect(verifyWebhookSignature({ secret: SECRET, body: BODY, signature, maxAgeSeconds: 300 })).toBe(
      true,
    );
  });

  it('refuses a body the sender did not sign — the tamper case', () => {
    const signature = buildWebhookSignature(SECRET, BODY);
    expect(
      verifyWebhookSignature({
        secret: SECRET,
        body: BODY.replace('card.status_changed', 'card.deleted'),
        signature,
        maxAgeSeconds: 300,
      }),
    ).toBe(false);
  });

  it('refuses a signature made with a different secret', () => {
    const signature = buildWebhookSignature('tf_whs_another-secret-entirely', BODY);
    expect(verifyWebhookSignature({ secret: SECRET, body: BODY, signature, maxAgeSeconds: 300 })).toBe(
      false,
    );
  });

  it('refuses a stale timestamp — replay of an old signed body', () => {
    /* Signed an hour ago, verified now: the receiver must refuse, because a
       captured (signature, body) pair would otherwise be replayable forever. */
    const old = Math.floor(Date.now() / 1000) - 3_600;
    const signature = buildWebhookSignature(SECRET, BODY, old);

    expect(verifyWebhookSignature({ secret: SECRET, body: BODY, signature, maxAgeSeconds: 300 })).toBe(
      false,
    );
  });

  it('refuses a signature for the future — the clock-drift mirror of stale', () => {
    const future = Math.floor(Date.now() / 1000) + 3_600;
    const signature = buildWebhookSignature(SECRET, BODY, future);
    expect(verifyWebhookSignature({ secret: SECRET, body: BODY, signature, maxAgeSeconds: 300 })).toBe(
      false,
    );
  });

  it('refuses a malformed header outright', () => {
    for (const garbage of ['', 'not-a-signature', 't=abc,v1=xyz', 'v1=deadbeef']) {
      expect(
        verifyWebhookSignature({ secret: SECRET, body: BODY, signature: garbage, maxAgeSeconds: 300 }),
      ).toBe(false);
    }
  });

  it('the timestamp in the header is the one the digest covers', () => {
    /* A receiver recomputes the digest over the timestamp FROM the header —
       the `t=` value is not metadata, it is part of what is authenticated.
       A sender must therefore never reuse a timestamp with a different body,
       and this pins the format. */
    const at = 1_752_000_000;
    const signature = buildWebhookSignature(SECRET, BODY, at);
    expect(signature.startsWith(`t=${String(at)},v1=`)).toBe(true);
    expect(verifyWebhookSignature({ secret: SECRET, body: BODY, signature, maxAgeSeconds: 300, now: at })).toBe(
      true,
    );
  });
});
