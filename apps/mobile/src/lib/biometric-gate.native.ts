import type * as LocalAuthenticationModule from 'expo-local-authentication';
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
 *
 * `expo-local-authentication` resolves ITS OWN native module
 * (`ExpoLocalAuthentication`) at the package's own top level — a plain
 * `requireNativeModule('ExpoLocalAuthentication')` at import time, not
 * something this file's code controls. `app-session.ts` builds
 * `createBiometricGate()`'s result into a module-level singleton that
 * `app/_layout.tsx` imports statically, ABOVE `session.restore()` per this
 * port's own header — so a static top-level `import` of the package here
 * would throw during Metro's module evaluation whenever it isn't linked
 * (Expo Go always; any development build built before this landed),
 * poisoning the whole app the exact way `modules/device-key/index.ts` used
 * to before its own fix (see that file's header for the full mechanism —
 * this is the same failure, just triggered by a package we don't own
 * rather than one we wrote). Loaded lazily instead, and both calls below
 * already catch a failed load the same way they catch every other failure:
 * `isAvailable()` folds "can't even check" into "nothing enrolled", and
 * `authenticate()` folds it into the "resolve `false`, never throw"
 * contract `BiometricGate`'s own header already documents.
 */
let modulePromise: Promise<typeof LocalAuthenticationModule> | undefined;

function getModule(): Promise<typeof LocalAuthenticationModule> {
  modulePromise ??= import('expo-local-authentication');
  return modulePromise;
}

export function createBiometricGate(): BiometricGate {
  return {
    isAvailable: async () => {
      try {
        const LocalAuthentication = await getModule();
        const [hasHardware, isEnrolled] = await Promise.all([
          LocalAuthentication.hasHardwareAsync(),
          LocalAuthentication.isEnrolledAsync(),
        ]);
        return hasHardware && isEnrolled;
      } catch {
        return false;
      }
    },
    authenticate: async () => {
      try {
        const LocalAuthentication = await getModule();
        const result = await LocalAuthentication.authenticateAsync({
          promptMessage: 'Unlock TaskFlow',
        });
        return result.success;
      } catch {
        return false;
      }
    },
  };
}
