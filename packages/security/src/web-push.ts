/**
 * Web Push (VAPID + RFC 8291 message encryption) — Phase 9 Wave 2,
 * ai/phase-9-notifications.md §3.7.
 *
 * ## One file per primitive, per guardrail 5
 *
 * PLAN.md §5's provider table had no push row; this phase adds one, and the
 * row's value is that the SIGNING and ENCRYPTION live here, in the one
 * package the crypto ban allows, rather than in apps/api behind a push
 * library. `apps/api` calls these functions; nothing here knows about
 * `platform.push_subscriptions` or the preferences matrix.
 *
 * ## Two different cryptographic jobs, deliberately separate
 *
 *   - VAPID (`vapidAuthorization`) proves to the PUSH SERVICE that this
 *     message came from the application server — the JWT is checked by
 *     FCM/Mozilla/whatever endpoint the subscription names, never by the
 *     browser. The browser trusts the push service, so a valid VAPID
 *     signature is what lets a message through the door.
 *   - RFC 8291 (`encryptPushPayload`) proves to the BROWSER that this
 *     message came from the application server — the payload is encrypted to
 *     the subscription's own P-256 key, so the push service itself cannot
 *     read or forge it. The VAPID key and the ECDH key are DIFFERENT keys:
 *     one signs, the other encrypts, and mixing them would let a push
 *     service forward ciphertext it can also decrypt.
 *
 * ## ECDSA signatures are JWS format, not DER
 *
 * VAPID's JWT uses ES256, and JWS defines an ECDSA signature as the raw
 * `r || s` concatenation (64 bytes). Node's `crypto.sign` returns DER
 * (34-35 bytes with structure), so `derToJws` below does the conversion —
 * the one place in this file where "obviously correct" input handling would
 * have been wrong.
 */

import {
  createCipheriv,
  createECDH,
  createHmac,
  createPrivateKey,
  sign,
  type KeyObject,
} from 'node:crypto';
import { secureBytes } from './random.js';

/** 65-byte uncompressed point form starts with 0x04. */
const UNCOMPRESSED_PREFIX = 0x04;

/** RFC 8188 record size — 4096, the Web Push ceiling (§4 of RFC 8291). */
const RECORD_SIZE = 4096;

/** How long a VAPID JWT stays valid, per RFC 8292 (12 hours). */
const VAPID_TTL_SECONDS = 12 * 60 * 60;

export interface VapidKeyPair {
  /** base64url, P-256 public key in uncompressed point form (65 bytes). */
  readonly publicKey: string;
  /** base64url, P-256 private key (32 bytes). */
  readonly privateKey: string;
}

/**
 * Generates a fresh VAPID key pair. Call once, store, reuse.
 *
 * `ecdh.getPrivateKey()` returns the scalar as a big-endian integer with NO
 * fixed length: about 1 in 256 keys have a zero top byte, and Node returns
 * that buffer one byte short rather than zero-padded — the identical failure
 * mode `toJwsInteger` below already exists to fix for a DER-decoded
 * signature integer. Left-padding here reuses that same function rather than
 * re-solving it, so `keyObjectFromBase64Url`'s `length !== 32` check (and
 * every caller downstream of it) never sees a generated key it refuses.
 */
export function generateVapidKeys(): VapidKeyPair {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    publicKey: Buffer.from(ecdh.getPublicKey()).toString('base64url'),
    privateKey: toJwsInteger(Buffer.from(ecdh.getPrivateKey())).toString('base64url'),
  };
}

/**
 * A `KeyObject` for a raw 32-byte base64url EC private key.
 *
 * `createPrivateKey` with `format: 'der', type: 'pkcs8'` REJECTS a bare
 * 32-byte key — it is not PKCS#8. Wrapping it by hand means getting the DER
 * layout exactly right; deriving the public point with ECDH and handing
 * Node the JWK form is the same amount of code and cannot be malformed.
 */
function keyObjectFromBase64Url(privateKey: string): KeyObject {
  const raw = Buffer.from(privateKey, 'base64url');
  if (raw.length !== 32) throw new Error('web-push: VAPID private key must be 32 bytes');

  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(raw);
  const point = ecdh.getPublicKey(); // 65 bytes, uncompressed

  return createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: point.subarray(1, 33).toString('base64url'),
      y: point.subarray(33, 65).toString('base64url'),
      d: privateKey,
    },
    format: 'jwk',
  });
}

/** The 65-byte uncompressed public point matching a raw 32-byte private key. */
function publicPointFromBase64Url(privateKey: string): Buffer {
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(Buffer.from(privateKey, 'base64url'));
  const point = ecdh.getPublicKey();
  if (point.length !== 65 || point[0] !== UNCOMPRESSED_PREFIX) {
    // Cannot happen for a valid P-256 key; guards the header layout below.
    throw new Error('web-push: derived public key not in uncompressed form');
  }
  return point;
}

/**
 * Builds the `Authorization: vapid t=..., k=...` header value.
 *
 * `audience` must be the ORIGIN of the subscription endpoint — RFC 8292 §2.1:
 * the JWT's `aud` is the push service's origin, and a service receiving a
 * token naming another origin refuses it. Deriving it from the endpoint
 * (`new URL(endpoint).origin`) at the call site keeps it honest; passing a
 * caller-supplied audience here would let the signature say anything.
 */
export function vapidAuthorization(input: {
  readonly subject: string;
  readonly privateKey: string;
  readonly audience: string;
  /** Injectable for tests; defaults to 12 hours. */
  readonly expiresAt?: number;
}): { readonly authorization: string; readonly publicKey: string } {
  const header = base64UrlJson({ typ: 'JWT', alg: 'ES256' });
  const now = Math.floor(Date.now() / 1000);
  const payload = base64UrlJson({
    aud: input.audience,
    exp: input.expiresAt ?? now + VAPID_TTL_SECONDS,
    sub: input.subject,
  });

  const protectedSegment = `${header}.${payload}`;
  const signature = sign(
    'sha256',
    Buffer.from(protectedSegment, 'utf8'),
    keyObjectFromBase64Url(input.privateKey),
  );

  const publicKey = publicPointFromBase64Url(input.privateKey);

  return {
    authorization: `vapid t=${protectedSegment}.${derToJws(signature).toString('base64url')}, k=${publicKey.toString('base64url')}`,
    publicKey: publicKey.toString('base64url'),
  };
}

function base64UrlJson(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

/**
 * Converts a DER ECDSA signature to the raw `r || s` form JWS requires.
 *
 * Node's `crypto.sign` returns DER: `0x30 <len> 0x02 <rlen> <r> 0x02 <slen> <s>`,
 * where each integer is minimal-length and may carry a leading 0x00 when its
 * high bit is set. JWS wants exactly 32 bytes each, left-padded. A naive
 * `Buffer.concat([r, s])` on DER integers is wrong twice: it drops the
 * padding a short `r` needs, and it keeps the 0x00 sign byte a full-length
 * `r` carries.
 */
function derToJws(der: Buffer): Buffer {
  if (der.length < 8 || der[0] !== 0x30) {
    throw new Error('web-push: not a DER ECDSA signature');
  }

  /* A length byte that is undefined would mean the buffer ended mid-structure,
     which the length check above already rules out — but under
     `noUncheckedIndexedAccess` the compiler still sees `number | undefined`,
     so each read is checked rather than asserted away. */
  let offset = 2; // sequence tag + length
  if (der[offset] !== 0x02) throw new Error('web-push: malformed DER (r tag)');
  const rLen = der[offset + 1];
  if (rLen === undefined) throw new Error('web-push: malformed DER (r length)');
  const r = der.subarray(offset + 2, offset + 2 + rLen);
  offset += 2 + rLen;
  if (der[offset] !== 0x02) throw new Error('web-push: malformed DER (s tag)');
  const sLen = der[offset + 1];
  if (sLen === undefined) throw new Error('web-push: malformed DER (s length)');
  const s = der.subarray(offset + 2, offset + 2 + sLen);

  return Buffer.concat([toJwsInteger(r), toJwsInteger(s)]);
}

/** Strips a DER integer's sign byte and left-pads to 32 bytes. */
function toJwsInteger(value: Buffer): Buffer {
  let bytes = value;
  if (bytes.length > 32 && bytes[0] === 0) bytes = bytes.subarray(1);
  if (bytes.length > 32) throw new Error('web-push: signature integer exceeds 32 bytes');
  const out = Buffer.alloc(32);
  bytes.copy(out, 32 - bytes.length);
  return out;
}

export interface EncryptedPushPayload {
  /** The full aes128gcm body: 86-byte header + ciphertext. POST this verbatim. */
  readonly body: Buffer;
  /** The 65-byte uncompressed ephemeral public key, base64url. */
  readonly ephemeralPublicKey: string;
}

/**
 * Encrypts a message for one subscription (RFC 8291 + RFC 8188 aes128gcm).
 *
 * The algorithm, for the review that will read this line:
 *
 *   1. ECDH between a fresh ephemeral key and the subscription's p256dh
 *      yields the shared secret.
 *   2. HKDF-SHA256 combines it with the subscription's `auth` secret using
 *      `key_info = "WebPush: info" || 0x00 || ua_public || as_public`.
 *   3. RFC 8188 derives CEK (16 bytes) and NONCE (12 bytes) from that IKM
 *      with the two `Content-Encoding: ...` info strings.
 *   4. AES-128-GCM encrypts the plaintext plus a trailing 0x02 padding
 *      delimiter (single record, RFC 8291 §4) with an EMPTY AAD — RFC 8188
 *      §5.2 defines the aes128gcm AAD as the empty string, not the header.
 *      (This is easy to get wrong: the header shares its first bytes with
 *      the body, and a round-trip test against your own decryptor passes
 *      with either choice. The RFC 8291 vector is what distinguishes them —
 *      see `web-push.test.ts`.)
 *
 * The header is `salt (16) || rs (4, big-endian) || idlen (1) || keyid`,
 * where the keyid is the ephemeral public key — per RFC 8291 §3.1, not a
 * separate `Crypto-Key` header.
 *
 * `p256dh` and `auth` are the base64url values the browser handed to the
 * subscription; `plaintext` must be UTF-8 text. Throws on a malformed
 * subscription key — the caller validates at registration time, and this is
 * the second line of defense.
 */
export function encryptPushPayload(
  subscription: { readonly p256dh: string; readonly auth: string },
  plaintext: string,
): EncryptedPushPayload {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  // Buffer.from on both: @types/node types getPrivateKey as a bare
  // Uint8Array, and secureBytes deliberately returns Uint8Array too.
  return encryptWithFixedInputs(subscription, plaintext, {
    ephemeralPrivateKey: Buffer.from(ecdh.getPrivateKey()),
    salt: Buffer.from(secureBytes(16)),
  });
}

/**
 * The deterministic core, with the ephemeral key and salt supplied.
 *
 * Exported from this module (NOT from the package index) so the RFC 8291
 * Appendix A vector can be verified byte-for-byte — the only test that can
 * prove the ECDH/HKDF/AES composition is right rather than merely
 * round-tripping against itself.
 */
export function encryptWithFixedInputs(
  subscription: { readonly p256dh: string; readonly auth: string },
  plaintext: string,
  fixed: { readonly ephemeralPrivateKey: Buffer; readonly salt: Buffer },
): EncryptedPushPayload {
  const uaPublic = decodeUncompressedPoint(subscription.p256dh, 'p256dh');
  const authSecret = Buffer.from(subscription.auth, 'base64url');
  if (authSecret.length !== 16) {
    throw new Error('web-push: auth secret must be 16 bytes');
  }
  if (fixed.salt.length !== 16) {
    throw new Error('web-push: salt must be 16 bytes');
  }

  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(fixed.ephemeralPrivateKey);
  const asPublic = ecdh.getPublicKey();
  if (asPublic.length !== 65 || asPublic[0] !== UNCOMPRESSED_PREFIX) {
    throw new Error('web-push: ephemeral key not in uncompressed form');
  }

  const ecdhSecret = ecdh.computeSecret(uaPublic);

  // HKDF-Extract(auth_secret, ecdh_secret) then one Expand to 32 bytes.
  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info', 'utf8'),
    Buffer.from([0x00]),
    uaPublic,
    asPublic,
  ]);
  const ikm = hkdf(ecdhSecret, authSecret, keyInfo, 32);

  const cek = hkdf(ikm, fixed.salt, Buffer.from('Content-Encoding: aes128gcm\x00', 'utf8'), 16);
  const nonce = hkdf(ikm, fixed.salt, Buffer.from('Content-Encoding: nonce\x00', 'utf8'), 12);

  const header = Buffer.concat([
    fixed.salt,
    uint32Be(RECORD_SIZE),
    Buffer.from([asPublic.length]),
    asPublic,
  ]);

  // Single record: plaintext followed by the 0x02 padding delimiter.
  const record = Buffer.concat([Buffer.from(plaintext, 'utf8'), Buffer.from([0x02])]);
  // Empty AAD — see the doc comment above on why this is NOT the header.
  const cipher = createCipheriv('aes-128-gcm', cek, nonce, { authTagLength: 16 });
  const ciphertext = Buffer.concat([cipher.update(record), cipher.final(), cipher.getAuthTag()]);

  return {
    body: Buffer.concat([header, ciphertext]),
    ephemeralPublicKey: asPublic.toString('base64url'),
  };
}

/** HKDF-SHA256 with a single Expand step (RFC 5869). */
function hkdf(ikm: Buffer, salt: Buffer, info: Buffer, length: number): Buffer {
  const prk = createHmac('sha256', salt).update(ikm).digest();
  const output = createHmac('sha256', prk)
    .update(Buffer.concat([info, Buffer.from([0x01])]))
    .digest();
  // Buffer.from, not subarray: @types/node types Buffer#subarray as a plain
  // Uint8Array, and the caller needs a real Buffer.
  return Buffer.from(output.subarray(0, length));
}

function uint32Be(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value, 0);
  return out;
}

/** Decodes a base64url 65-byte uncompressed P-256 point and checks its shape. */
function decodeUncompressedPoint(value: string, name: string): Buffer {
  const raw = Buffer.from(value, 'base64url');
  if (raw.length !== 65 || raw[0] !== UNCOMPRESSED_PREFIX) {
    throw new Error(`web-push: ${name} must be a 65-byte uncompressed P-256 point`);
  }
  return raw;
}

/** Whether a subscription's keys are structurally valid before we store them. */
export function isValidSubscriptionKeys(input: {
  readonly p256dh: string;
  readonly auth: string;
}): boolean {
  try {
    decodeUncompressedPoint(input.p256dh, 'p256dh');
    return Buffer.from(input.auth, 'base64url').length === 16;
  } catch {
    return false;
  }
}

/** The RFC 8291 Appendix A test vector, exported for the test that verifies it. */
export const RFC8291_VECTOR = {
  plaintext: 'When I grow up, I want to be a watermelon',
  uaPublic:
    'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  /** The 86-byte aes128gcm header the RFC prints. */
  expectedHeader:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  expectedCiphertext:
    '8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ',
};
