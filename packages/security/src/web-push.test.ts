import { describe, expect, it } from 'vitest';
import {
  createDecipheriv,
  createECDH,
  createHmac,
  createPublicKey,
  verify,
} from 'node:crypto';
import {
  RFC8291_VECTOR,
  encryptPushPayload,
  encryptWithFixedInputs,
  generateVapidKeys,
  isValidSubscriptionKeys,
  vapidAuthorization,
} from './web-push.js';

/**
 * Web Push crypto (Phase 9 Wave 2, ai/phase-9-notifications.md §3.7).
 *
 * The first test is the important one: it runs the RFC 8291 Appendix A
 * vector through `encryptWithFixedInputs` and asserts the output byte-for-
 * byte against the published intermediate values. A composition of ECDH,
 * two HKDF layers and AES-GCM can round-trip against itself while being
 * wrong in every direction a push service would reject it; only a published
 * vector can prove the composition is the actual protocol.
 *
 * The third test implements the RECEIVER side (the browser) over the public
 * random path, so `encryptPushPayload` — the code that will actually run —
 * is proven to decrypt on the other end, not just to produce bytes.
 */

describe('RFC 8291 Appendix A vector', () => {
  it('reproduces the published header and ciphertext byte-for-byte', () => {
    const result = encryptWithFixedInputs(
      { p256dh: RFC8291_VECTOR.uaPublic, auth: RFC8291_VECTOR.authSecret },
      RFC8291_VECTOR.plaintext,
      {
        ephemeralPrivateKey: Buffer.from(RFC8291_VECTOR.asPrivate, 'base64url'),
        salt: Buffer.from(RFC8291_VECTOR.salt, 'base64url'),
      },
    );

    const header = result.body.subarray(0, 86);
    const ciphertext = result.body.subarray(86);

    expect(header.toString('base64url')).toBe(RFC8291_VECTOR.expectedHeader);
    expect(ciphertext.toString('base64url')).toBe(RFC8291_VECTOR.expectedCiphertext);
    // 86-byte header + 41-byte plaintext + 1 padding delimiter + 16 GCM tag.
    expect(result.body.length).toBe(86 + 41 + 1 + 16);
    // The ephemeral public key inside the header matches the vector's as_public.
    expect(result.ephemeralPublicKey).toBe(
      'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
    );
  });
});

describe('encryptPushPayload (the random path that actually runs)', () => {
  /** The browser side: derive the keys from the subscription's PRIVATE key. */
  function decryptAsReceiver(subscription: {
    readonly p256dh: string;
    readonly uaPrivate: string;
    readonly auth: string;
  }, body: Buffer): string {
    // aes128gcm header: salt(16) || rs(4) || idlen(1) || keyid(idlen).
    const salt = body.subarray(0, 16);
    const idlen = body[20]!;
    const keyid = body.subarray(21, 21 + idlen);
    const ciphertext = body.subarray(21 + idlen);

    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(Buffer.from(subscription.uaPrivate, 'base64url'));
    const ecdhSecret = ecdh.computeSecret(keyid);

    const hkdf = (ikm: Buffer, saltBuf: Buffer, info: Buffer, length: number): Buffer => {
      const prk = createHmac('sha256', saltBuf).update(ikm).digest();
      const out = createHmac('sha256', prk)
        .update(Buffer.concat([info, Buffer.from([0x01])]))
        .digest();
      return out.subarray(0, length);
    };

    const keyInfo = Buffer.concat([
      Buffer.from('WebPush: info', 'utf8'),
      Buffer.from([0x00]),
      Buffer.from(subscription.p256dh, 'base64url'),
      keyid,
    ]);
    const ikm = hkdf(ecdhSecret, Buffer.from(subscription.auth, 'base64url'), keyInfo, 32);
    const cek = hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\x00', 'utf8'), 16);
    const nonce = hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\x00', 'utf8'), 12);

    // Empty AAD — RFC 8188 §5.2; the vector test is what pins this down.
    const decipher = createDecipheriv('aes-128-gcm', cek, nonce, { authTagLength: 16 });
    decipher.setAuthTag(ciphertext.subarray(-16));
    const plaintext = Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);

    // Trailing 0x02 padding delimiter, per RFC 8291 §4.
    expect(plaintext[plaintext.length - 1]).toBe(0x02);
    return plaintext.subarray(0, -1).toString('utf8');
  }

  it('decrypts on the receiver side to the original plaintext', () => {
    const subscription = {
      p256dh: RFC8291_VECTOR.uaPublic,
      uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
      auth: RFC8291_VECTOR.authSecret,
    };

    const { body } = encryptPushPayload(subscription, 'hello, board: the launch moved');
    expect(decryptAsReceiver(subscription, body)).toBe('hello, board: the launch moved');
  });

  it('produces a fresh salt and ephemeral key every call', () => {
    const subscription = { p256dh: RFC8291_VECTOR.uaPublic, auth: RFC8291_VECTOR.authSecret };
    const first = encryptPushPayload(subscription, 'x');
    const second = encryptPushPayload(subscription, 'x');

    // A static salt or a reused ephemeral key would let a push service link
    // messages; the point of the random wrapper is that neither repeats.
    expect(first.body.subarray(0, 16).equals(second.body.subarray(0, 16))).toBe(false);
    expect(first.ephemeralPublicKey).not.toBe(second.ephemeralPublicKey);
  });

  it('rejects a malformed subscription key', () => {
    expect(() =>
      encryptPushPayload({ p256dh: 'not-a-point', auth: RFC8291_VECTOR.authSecret }, 'x'),
    ).toThrow(/p256dh/);
    expect(() =>
      encryptPushPayload({ p256dh: RFC8291_VECTOR.uaPublic, auth: 'short' }, 'x'),
    ).toThrow(/auth/);
  });
});

describe('VAPID', () => {
  it('generates a 65-byte uncompressed public key', () => {
    const { publicKey, privateKey } = generateVapidKeys();
    const decoded = Buffer.from(publicKey, 'base64url');
    expect(decoded.length).toBe(65);
    expect(decoded[0]).toBe(0x04);
    expect(Buffer.from(privateKey, 'base64url').length).toBe(32);
  });

  it('builds an ES256 JWT the matching public key verifies', () => {
    const keys = generateVapidKeys();
    const audience = 'https://fcm.googleapis.com';
    const { authorization, publicKey } = vapidAuthorization({
      subject: 'mailto:no-reply@taskflow.local',
      privateKey: keys.privateKey,
      audience,
    });

    const prefix = `vapid t=`;
    expect(authorization.startsWith(prefix)).toBe(true);
    expect(authorization).toContain(', k=');
    // The k= half is the same key the client was told about at subscribe time.
    expect(publicKey).toBe(keys.publicKey);

    const token = authorization.slice(prefix.length, authorization.indexOf(', k='));
    const [header, payload, signature] = token.split('.') as [string, string, string];
    const headerJson = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as {
      alg: string;
      typ: string;
    };
    expect(headerJson).toEqual({ alg: 'ES256', typ: 'JWT' });

    const payloadJson = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      aud: string;
      exp: number;
      sub: string;
    };
    expect(payloadJson.aud).toBe(audience);
    expect(payloadJson.sub).toBe('mailto:no-reply@taskflow.local');
    expect(payloadJson.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));

    // The signature is JWS format (64 raw bytes). Node's verify() expects DER
    // by default, so it gets the dsaEncoding that accepts raw r||s — which is
    // exactly the format browsers check, so this proves the wire format is
    // verifiable as-is.
    const publicKeyObject = createKeyObjectFromPoint(publicKey);
    const verified = verify(
      'sha256',
      Buffer.from(`${header}.${payload}`),
      { key: publicKeyObject, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signature, 'base64url'),
    );
    expect(verified).toBe(true);
  });

  it('rejects a private key that is not 32 bytes', () => {
    expect(() =>
      vapidAuthorization({
        subject: 'mailto:x@y.test',
        privateKey: 'too-short',
        audience: 'https://example.com',
      }),
    ).toThrow(/32 bytes/);
  });
});

describe('isValidSubscriptionKeys', () => {
  it('accepts the vector keys and rejects everything else', () => {
    expect(
      isValidSubscriptionKeys({ p256dh: RFC8291_VECTOR.uaPublic, auth: RFC8291_VECTOR.authSecret }),
    ).toBe(true);
    expect(isValidSubscriptionKeys({ p256dh: 'garbage', auth: 'garbage' })).toBe(false);
    expect(
      isValidSubscriptionKeys({ p256dh: RFC8291_VECTOR.uaPublic, auth: 'garbage' }),
    ).toBe(false);
    expect(isValidSubscriptionKeys({ p256dh: 'garbage', auth: RFC8291_VECTOR.authSecret })).toBe(
      false,
    );
  });
});

/** Rebuilds a KeyObject from a 65-byte uncompressed point, for signature check. */
function createKeyObjectFromPoint(point: string) {
  const raw = Buffer.from(point, 'base64url');
  return createPublicKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: raw.subarray(1, 33).toString('base64url'),
      y: raw.subarray(33, 65).toString('base64url'),
    },
    format: 'jwk',
  });
}
