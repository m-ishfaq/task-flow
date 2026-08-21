import { ensurePublicKey, sign } from '../../modules/device-key/index.js';
import type { DeviceKeyPort } from './device-key.js';

/**
 * The real device implementation of `DeviceKeyPort` (ai/phase-14-mobile.md
 * §4.5). Kept in its own file rather than alongside the interface — the
 * same reason `device-secure-store.ts` is split from `secure-store.ts`: this
 * module reaches `modules/device-key`, a local Expo Module whose native code
 * (⚠ UNVERIFIED — see that module's own `index.ts` header) Vitest's transform
 * cannot touch and Expo Go cannot run at all.
 */
export function createDeviceKey(): DeviceKeyPort {
  return { ensurePublicKey, sign };
}
