import { createPublicKey, verify as verifySignature } from 'node:crypto';

/**
 * Device binding for native sessions (ai/phase-14-mobile.md §4.5).
 *
 * ⚠ HUMAN REVIEW SURFACE (§2.2) — the same tier as `webauthn.ts` and
 * `twilio-signature.ts`: this is a signature the rest of the identity slice
 * trusts to prove "this refresh token is being presented by the one device
 * whose secure enclave / StrongBox minted it."
 *
 * ## What this is not
 *
 * Not WebAuthn. There is no ceremony, no authenticator attestation, no
 * `clientDataJSON`, no origin binding — those all assume a THIRD PARTY
 * (a security key, a platform authenticator UI) mediating between the
 * relying party and the key. Here we control both ends: the mobile app that
 * generates the key and the server that verifies it. So the scheme is the
 * simplest thing that gives the property device binding needs — sign the
 * exact refresh token being redeemed with a hardware-backed P-256 key, and
 * verify it — rather than reusing `webauthn.ts`'s heavier ceremony machinery
 * for a shape it was never built to carry.
 *
 * ## Why signing the refresh token itself, and not a separate nonce
 *
 * A nonce exists to give a signature freshness — proof it was not captured
 * and replayed. `identity.refresh_tokens` already gives every signature that
 * property for free: each token is single-use (`rotated_at` — Phase 1 §8.1),
 * so a signature over a specific token can never be replayed against a LATER
 * refresh, and replaying it against the SAME request is no more possible
 * than replaying the token alone already was. A separate challenge/response
 * round trip would buy nothing here that single-use rotation does not
 * already guarantee, at the cost of a second network round trip on every
 * refresh.
 *
 * ## Why coordinates, never a client-asserted algorithm
 *
 * `DevicePublicKeyCoordinates` carries only `x`/`y` — there is no `alg` or
 * `crv` field for a caller to set. `verifyDeviceSignature` hardcodes
 * `kty: 'EC'`, `crv: 'P-256'` when constructing the key and `'sha256'` when
 * verifying. Accepting any of those from the wire would open exactly the
 * algorithm-confusion class of bug JWT libraries spent years fixing — a
 * caller naming "the check that will pass" instead of the server deciding
 * what a valid proof looks like.
 */

export interface DevicePublicKeyCoordinates {
  /** Base64url, the raw P-256 X coordinate — 32 bytes decoded. */
  readonly x: string;
  /** Base64url, the raw P-256 Y coordinate — 32 bytes decoded. */
  readonly y: string;
}

/** The fixed size of a P-256 field element. Neither coordinate is ever any other length. */
const P256_COORDINATE_BYTES = 32;

/**
 * `Buffer.from(str, 'base64url')` does not throw on invalid input — it drops
 * characters outside the alphabet silently, which would let a coordinate
 * carrying garbage decode to something shorter than 32 bytes and read as
 * merely "the wrong length" rather than as the malformed input it is. The
 * regex is what actually refuses garbage; the length check afterward catches
 * a value that is valid base64url but decodes to the wrong number of bytes.
 */
function isValidCoordinate(value: string): boolean {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return false;
  return Buffer.from(value, 'base64url').length === P256_COORDINATE_BYTES;
}

export function isPlausibleDevicePublicKey(key: DevicePublicKeyCoordinates): boolean {
  return isValidCoordinate(key.x) && isValidCoordinate(key.y);
}

/**
 * Verifies a signature produced by a device's bound P-256 key over `data`.
 *
 * `signature` is base64 DER — the encoding both `SecKeyCreateSignature`
 * (iOS, `.ecdsaSignatureMessageX962SHA256`) and `Signature.getInstance
 * ("SHA256withECDSA")` (Android) produce by default, so nothing on either
 * side re-encodes. Pinned explicitly via `dsaEncoding: 'der'` rather than
 * left to Node's default, the same reasoning `webauthn.ts` pins its
 * algorithm list instead of trusting the library's.
 *
 * Every failure mode — a malformed key, a malformed signature, a signature
 * that verifies against the wrong data — returns `false`. There is nothing
 * here worth telling a caller apart from "no": unlike `PasskeyVerificationError`,
 * this has no ceremony metadata worth losing by collapsing every failure to
 * one answer, and the call site (`identity.service.ts`'s `refresh`) already
 * refuses generically on failure (§4.3's own pattern).
 */
export function verifyDeviceSignature(input: {
  readonly publicKey: DevicePublicKeyCoordinates;
  readonly signature: string;
  readonly data: string;
}): boolean {
  if (!isPlausibleDevicePublicKey(input.publicKey)) return false;

  let key;
  try {
    key = createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: input.publicKey.x,
        y: input.publicKey.y,
      },
      format: 'jwk',
    });
  } catch {
    return false;
  }

  let signatureBuffer: Buffer;
  try {
    signatureBuffer = Buffer.from(input.signature, 'base64');
  } catch {
    return false;
  }
  if (signatureBuffer.length === 0) return false;

  try {
    return verifySignature(
      'sha256',
      Buffer.from(input.data, 'utf8'),
      { key, dsaEncoding: 'der' },
      signatureBuffer,
    );
  } catch {
    // A malformed DER signature throws rather than returning false — Node's
    // ASN.1 parser is not obligated to fail closed on garbage input, so this
    // package is what makes sure the CALLER never has to know that.
    return false;
  }
}
