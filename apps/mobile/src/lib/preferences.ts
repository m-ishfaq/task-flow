import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Preferences } from './session.js';

/**
 * The real device implementation of `Preferences` (ai/phase-14-mobile.md §5,
 * §7) — plain `AsyncStorage`, deliberately NOT the keystore.
 *
 * `org-gate.ts`'s own header makes the argument: the remembered org id is not a
 * credential and confers nothing on its own — it becomes the
 * attacker-controllable `x-taskflow-org` header, a WHERE filter against the
 * caller's OWN memberships, never a value written to `app.org_id`. So ordinary
 * on-disk storage is the right amount of protection, the same reasoning
 * apps/web gives for `localStorage`.
 *
 * This file is deliberately NOT `session.ts` or `secure-store.ts` — the two
 * files the credential-seam guardrail (`packages/config/eslint/security.js`)
 * bans `AsyncStorage` on. Keeping this wrapper in its own module is what makes
 * that ban meaningful: importing `AsyncStorage` here is fine, and the guardrail
 * only fires where a credential could reach it.
 */
export function createPreferences(): Preferences {
  return {
    getItem: (key) => AsyncStorage.getItem(key),
    setItem: (key, value) => AsyncStorage.setItem(key, value),
    removeItem: (key) => AsyncStorage.removeItem(key),
  };
}
