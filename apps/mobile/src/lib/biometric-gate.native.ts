import * as LocalAuthentication from 'expo-local-authentication';
import type { BiometricGate } from './biometric-gate.js';

/**
 * The real device implementation of `BiometricGate` (§4.4). Kept in its own
 * file for the same reason `device-secure-store.ts` is split from
 * `secure-store.ts` — see that port's own header.
 *
 * `disableDeviceFallback` is left at its default (`false`): the device's own
 * passcode is an equally valid "prove you are this device's owner" proof to
 * a fingerprint or a face, and refusing it would strand anyone whose
 * biometric enrollment is temporarily unavailable (a bandage on a finger, a
 * face covering) with an app they otherwise have every right to open.
 */
export function createBiometricGate(): BiometricGate {
  return {
    isAvailable: async () => {
      const [hasHardware, isEnrolled] = await Promise.all([
        LocalAuthentication.hasHardwareAsync(),
        LocalAuthentication.isEnrolledAsync(),
      ]);
      return hasHardware && isEnrolled;
    },
    authenticate: async () => {
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: 'Unlock TaskFlow',
      });
      return result.success;
    },
  };
}
