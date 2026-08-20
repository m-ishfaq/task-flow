import * as ExpoSecureStore from 'expo-secure-store';
import type { SecureStore } from './secure-store.js';

/**
 * The real device implementation of `SecureStore` (ai/phase-14-mobile.md §4.1,
 * §6.2): Keychain on iOS, the Keystore-backed encrypted store on Android, via
 * `expo-secure-store`. Kept in its own file rather than alongside the
 * interface — see `secure-store.ts`'s own header for why (this module
 * transitively pulls in React Native, which Vitest's transform cannot parse).
 *
 * `keychainAccessible` is not the library default, and getting it wrong is the
 * whole risk this function exists to close: `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`
 * is readable once the device has been unlocked at least once since boot — so
 * a push-woken background token refresh works even if the screen is still
 * locked — and `THIS_DEVICE_ONLY` excludes the value from an iCloud/device
 * backup, so restoring a backup onto a second handset does not carry a live
 * session onto it. The library default (`WHEN_UNLOCKED`, included in backups)
 * is wrong on both counts for a long-lived credential.
 */
export function createSecureStore(): SecureStore {
  return {
    getItem: (key) => ExpoSecureStore.getItemAsync(key),
    setItem: (key, value) =>
      ExpoSecureStore.setItemAsync(key, value, {
        keychainAccessible: ExpoSecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
      }),
    deleteItem: (key) => ExpoSecureStore.deleteItemAsync(key),
  };
}
