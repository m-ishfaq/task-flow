import { generateKeyPairSync, sign as signWithKey, type KeyObject } from 'node:crypto';
import type { DevicePublicKeyCoordinates } from '../device-binding.js';

/**
 * A software device key, for tests (mirrors `virtual-authenticator.ts`'s own
 * reasoning). `device-binding.ts`'s whole job is verifying a REAL P-256
 * signature over the presented refresh token; a test that stubs signing
 * proves the call happened, not that a stolen token is actually inert
 * without the matching private key. Exported from `@taskflow/security/testing`
 * rather than the package root, so nothing outside a test can reach it.
 */
export interface TestDeviceKey {
  readonly publicKey: DevicePublicKeyCoordinates;
  readonly privateKey: KeyObject;
}

export function generateTestDeviceKey(): TestDeviceKey {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  if (jwk.x === undefined || jwk.y === undefined) {
    throw new Error('unreachable: an EC JWK always carries x and y');
  }
  return { publicKey: { x: jwk.x, y: jwk.y }, privateKey };
}

/** Signs `data` exactly as the real native module would (DER ECDSA-SHA256). */
export function signWithTestDeviceKey(key: TestDeviceKey, data: string): string {
  return signWithKey('sha256', Buffer.from(data, 'utf8'), key.privateKey).toString('base64');
}
