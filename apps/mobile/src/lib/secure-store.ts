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
 * The concrete device implementation (`expo-secure-store`) lands with the Expo
 * shell. It MUST set the accessibility class explicitly:
 * `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY` — readable after the first unlock so a
 * push-woken background refresh works, `THIS_DEVICE_ONLY` so a backup restored
 * onto another handset does not carry a live session. The default (available
 * before first unlock, included in device backups) is the wrong one, and the
 * only way it gets set correctly is deliberately.
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
