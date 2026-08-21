import { requireNativeModule } from 'expo-modules-core';

/**
 * The native binding for device key custody (ai/phase-14-mobile.md §4.5).
 *
 * ⚠ UNVERIFIED NATIVE CODE. Nothing in this monorepo's toolchain — `tsc`,
 * ESLint, Vitest, Metro's bundle check — reaches `ios/DeviceKeyModule.swift`
 * or `android/.../DeviceKeyModule.kt`; there is no compiler for either in
 * this environment. Both were written against Apple's Security framework and
 * Android Keystore documentation as carefully as this session could manage,
 * but per this repo's own repeated lesson (CLAUDE.md's Phase 4/6/7/13
 * sections) a control that reads correctly is not the same claim as one that
 * has run. The first `expo prebuild` / EAS development build that includes
 * this module is the first real compile signal either file will ever get —
 * see each native file's own header for the specific things worth checking
 * first (StrongBox availability, the DER signature format, the raw P-256
 * point encoding).
 *
 * `requireNativeModule('DeviceKey')` throws if the native module is not
 * linked — which on Expo Go specifically it always will (§4.4/README: a
 * plain Expo Go install cannot run this app's custom native code at all,
 * only a development build can), and on any development build that predates
 * this module too. That throw is deliberately deferred to first USE
 * (`getNative()`, memoized below) rather than raised at import time: this
 * file sits behind `device-key.native.ts`, which `app-session.ts` — the
 * composition root every route transitively imports — constructs into a
 * module-level singleton at import time. A throw during that construction
 * poisons the whole Metro module graph before `expo-router` ever renders a
 * screen, which surfaces as EVERY route failing with "missing the required
 * default export" and not as the one feature it actually belongs to.
 * `session.ts`'s `adopt()`/`refresh()` already wrap every call into this
 * port in `try`/`catch` precisely so a missing or misbehaving key is
 * best-effort, per §4.5's own "neither a failed registration nor a failed
 * signature blocks a login or a refresh" — but that handling only ever runs
 * if importing this module cannot itself throw. `device-key.native.ts` is
 * the one file that imports this index, kept split from the pure
 * `device-key.ts` port for the same reason `device-secure-store.ts` is
 * split from `secure-store.ts`.
 */
interface DeviceKeyNativeModule {
  /** Returns `null` if `generateKey` has never been called on this device. */
  getPublicKey(): Promise<{ x: string; y: string } | null>;
  /** Generates a NEW non-exportable P-256 key, replacing any previous one. */
  generateKey(): Promise<{ x: string; y: string }>;
  /** DER-encoded ECDSA-P256-SHA256 signature over `data`, base64. Throws if no key exists. */
  sign(data: string): Promise<string>;
}

let native: DeviceKeyNativeModule | undefined;

/** Resolves the native module on first USE, not on import — see header. */
function getNative(): DeviceKeyNativeModule {
  native ??= requireNativeModule<DeviceKeyNativeModule>('DeviceKey');
  return native;
}

export async function ensurePublicKey(): Promise<{ x: string; y: string }> {
  const existing = await getNative().getPublicKey();
  if (existing !== null) return existing;
  return getNative().generateKey();
}

export function sign(data: string): Promise<string> {
  return getNative().sign(data);
}
