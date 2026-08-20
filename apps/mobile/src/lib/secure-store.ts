/**
 * The one credential-writing seam on mobile (ai/phase-14-mobile.md §4.1, §6.2).
 *
 * The web keeps its refresh token in an httpOnly `__Host-` cookie that script
 * cannot read. A handset has no such primitive, so the rotating refresh token
 * lives in the platform's hardware-backed keystore — Keychain on iOS, the
 * Keystore-backed encrypted store on Android — reached ONLY through this
 * interface. Everything else about token custody depends on that being the sole
 * writer: a `no-restricted-imports` guardrail (added with the Expo-shell
 * increment) flags `AsyncStorage` and any plain file write reached from the
 * session module, so a credential cannot end up in unencrypted storage by
 * accident. This is guardrail 5's "one audited place per sensitive primitive",
 * applied to token storage.
 *
 * The concrete device implementation lives in `device-secure-store.ts`, a
 * SEPARATE file, deliberately — it imports `expo-secure-store`, which
 * transitively pulls in React Native's Flow-typed source. Vitest's transform
 * cannot parse Flow (§11: the platform primitives this phase is about do not
 * exist in a Node/Vitest process at all), and `session.test.ts` needs this
 * file's `createInMemorySecureStore` with no Expo runtime anywhere in the
 * module graph. Splitting the two is what makes that possible, not a
 * workaround — it is the same "keep every port testable with no device"
 * discipline the rest of `src/lib/` already follows, applied to secure-store's
 * own real implementation.
 */
export interface SecureStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  deleteItem(key: string): Promise<void>;
}

/** The key the rotating refresh token is stored under. */
export const REFRESH_TOKEN_KEY = 'taskflow.refreshToken';

/**
 * An in-memory SecureStore, for tests ONLY.
 *
 * It is deliberately not exported as a fallback for the app: a real device
 * always has a keystore, and a silent in-memory fallback would turn "the
 * keystore is unavailable" — a state worth failing on — into "the session
 * quietly does not persist", which is far harder to notice. The session store's
 * unit tests inject this so the credential-custody logic can be exercised with
 * no Expo runtime present.
 */
export function createInMemorySecureStore(): SecureStore {
  const map = new Map<string, string>();
  return {
    getItem: (key) => Promise.resolve(map.get(key) ?? null),
    setItem: (key, value) => {
      map.set(key, value);
      return Promise.resolve();
    },
    deleteItem: (key) => {
      map.delete(key);
      return Promise.resolve();
    },
  };
}
