import { generateKeyPairSync, sign as signWithKey } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  isPlausibleDevicePublicKey,
  verifyDeviceSignature,
  type DevicePublicKeyCoordinates,
} from './device-binding.js';

/**
 * Device binding (ai/phase-14-mobile.md §4.5).
 *
 * Uses real P-256 keypairs and real DER-encoded ECDSA signatures throughout —
 * the same reason `webauthn.ts`'s tests use a real ES256-signing authenticator
 * rather than a stub: this file's whole job is verifying a signature nobody
 * forges by accident, so the round trip has to be the real primitive on both
 * ends, not a mock that agrees with itself.
 */

function generateDeviceKey() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  if (jwk.x === undefined || jwk.y === undefined) throw new Error('unreachable: EC JWK has x/y');
  const coordinates: DevicePublicKeyCoordinates = { x: jwk.x, y: jwk.y };
  return { coordinates, privateKey };
}

function signRefreshToken(
  privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'],
  data: string,
) {
  return signWithKey('sha256', Buffer.from(data, 'utf8'), privateKey).toString('base64');
}

describe('verifyDeviceSignature', () => {
  it('accepts a signature the matching private key produced over the exact data', () => {
    const { coordinates, privateKey } = generateDeviceKey();
    const data = 'tf_rt_0123456789abcdef0123456789abcdef';
    const signature = signRefreshToken(privateKey, data);

    expect(verifyDeviceSignature({ publicKey: coordinates, signature, data })).toBe(true);
  });

  it('refuses a signature over different data — the substitution case', () => {
    const { coordinates, privateKey } = generateDeviceKey();
    const signature = signRefreshToken(privateKey, 'tf_rt_original');

    expect(
      verifyDeviceSignature({ publicKey: coordinates, signature, data: 'tf_rt_substituted' }),
    ).toBe(false);
  });

  it('refuses a signature from a DIFFERENT device key — the stolen-token case', () => {
    const { privateKey: attackerKey } = generateDeviceKey();
    const { coordinates: victimPublicKey } = generateDeviceKey();
    const data = 'tf_rt_stolen_from_victim';
    const signature = signRefreshToken(attackerKey, data);

    // The attacker has the token and can sign with THEIR OWN key, but the
    // session is bound to the victim's public key — this is the entire
    // point of device binding: a copied token is not enough.
    expect(verifyDeviceSignature({ publicKey: victimPublicKey, signature, data })).toBe(false);
  });

  it('refuses a garbage signature rather than throwing', () => {
    const { coordinates } = generateDeviceKey();
    expect(
      verifyDeviceSignature({ publicKey: coordinates, signature: 'not-valid-der', data: 'x' }),
    ).toBe(false);
  });

  it('refuses an empty signature', () => {
    const { coordinates } = generateDeviceKey();
    expect(verifyDeviceSignature({ publicKey: coordinates, signature: '', data: 'x' })).toBe(false);
  });

  it('refuses a public key that is not a valid P-256 point', () => {
    const signature = 'aGVsbG8=';
    expect(
      verifyDeviceSignature({
        publicKey: { x: 'not-base64url-shaped!!', y: 'also-bad!!' },
        signature,
        data: 'x',
      }),
    ).toBe(false);
  });

  it('refuses coordinates of the wrong byte length even if base64url-valid', () => {
    // Valid base64url alphabet, but decodes to far fewer than 32 bytes.
    const short = Buffer.from('short').toString('base64url');
    expect(isPlausibleDevicePublicKey({ x: short, y: short })).toBe(false);
  });
});
