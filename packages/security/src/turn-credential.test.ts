import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { mintTurnCredential } from './turn-credential.js';

/**
 * The properties that only matter if they are asserted.
 *
 * A TURN credential that is subtly malformed does not throw — it is refused by
 * a server in a datacentre, and the browser reports it as "ICE failed", which
 * is indistinguishable from an ordinary NAT problem. So the shape is asserted
 * here, against an independently computed HMAC rather than against the
 * function's own output.
 */

const SECRET = 'coturn-dev-secret';
const AT = new Date('2026-08-10T12:00:00.000Z');

describe('mintTurnCredential', () => {
  it('produces the exact username and credential coturn recomputes', () => {
    const result = mintTurnCredential({
      secret: SECRET,
      identity: 'sess-abc',
      ttlSeconds: 600,
      now: AT,
    });

    // 2026-08-10T12:00:00Z + 600s, as unix seconds.
    const expectedExpiry = Math.floor(AT.getTime() / 1000) + 600;
    expect(result.username).toBe(`${String(expectedExpiry)}:sess-abc`);

    /* Recomputed here the way coturn does, not read back off the function. A
       test that compares the output with itself passes for any implementation,
       including one that returns the username as the credential. */
    const expected = createHmac('sha1', SECRET)
      .update(Buffer.from(result.username, 'utf8'))
      .digest('base64');

    expect(result.credential).toBe(expected);
  });

  it('reports an expiry equal to the second the credential actually dies', () => {
    /* A now() with a fractional second is the case that separates "floor the
       unix value" from "report the unfloored ms". A renewal timer computed from
       a Date up to a second later than coturn's own cutoff fails
       intermittently, which is the worst kind of wrong. */
    const result = mintTurnCredential({
      secret: SECRET,
      identity: 'sess-abc',
      ttlSeconds: 60,
      now: new Date('2026-08-10T12:00:00.750Z'),
    });

    const unixInUsername = Number(result.username.split(':')[0]);
    expect(result.expiresAt.getTime()).toBe(unixInUsername * 1000);
    expect(result.expiresAt.getTime() % 1000).toBe(0);
  });

  it('refuses an empty secret rather than signing under a known key', () => {
    /* An empty HMAC key is a valid HMAC key. Every forged credential would
       verify against a coturn misconfigured the same way, and nothing would
       look wrong from either side. */
    expect(() => mintTurnCredential({ secret: '', identity: 'sess-abc', ttlSeconds: 600 })).toThrow(
      /empty/i,
    );
  });

  it('refuses an identity containing a colon', () => {
    /* coturn splits the username on the FIRST colon. An identity carrying one
       moves the boundary, so the value this function wrote and the value coturn
       reads are different — the classic delimiter-injection shape. */
    expect(() =>
      mintTurnCredential({ secret: SECRET, identity: '1:evil', ttlSeconds: 600 }),
    ).toThrow(/identity/i);
  });

  it.each([0, -1, 1.5, Number.NaN])('refuses a ttl of %s', (ttlSeconds) => {
    expect(() => mintTurnCredential({ secret: SECRET, identity: 'sess-abc', ttlSeconds })).toThrow(
      /ttlSeconds/i,
    );
  });

  it('produces different credentials for different identities', () => {
    const a = mintTurnCredential({ secret: SECRET, identity: 'sess-a', ttlSeconds: 600, now: AT });
    const b = mintTurnCredential({ secret: SECRET, identity: 'sess-b', ttlSeconds: 600, now: AT });

    expect(a.credential).not.toBe(b.credential);
  });
});
