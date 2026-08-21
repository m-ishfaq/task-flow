/**
 * Device binding, the client half (ai/phase-14-mobile.md §4.5).
 *
 * The compensating control for the one property native genuinely lost by not
 * having httpOnly cookies (§4.2): a P-256 keypair generated in the secure
 * enclave / StrongBox, whose private half never leaves that hardware — not
 * even to this app's own JS. `session.ts`'s `adopt()`/`refresh()` are the two
 * callers: the first registers this device's public key against a freshly
 * minted session, the second signs the refresh token being redeemed so a
 * copied token is inert without the matching hardware.
 *
 * Split from its real implementation the same way `secure-store.ts` is split
 * from `device-secure-store.ts`: the real backing is a local Expo Module
 * (`modules/device-key`), which pulls in native code Vitest's transform
 * cannot touch. This file stays Expo-free so `session.test.ts` can exercise
 * the orchestration — "adopt registers a key", "refresh signs when one
 * exists", "neither ever fails the caller" — with no device and no native
 * module in the graph at all.
 *
 * `node:crypto` is banned everywhere in `apps/mobile` (guardrail 5) — the fake
 * below is not a real signature and must never be mistaken for one; it exists
 * only to give the in-memory port SOMETHING to return.
 */
export interface DevicePublicKeyCoordinates {
  readonly x: string;
  readonly y: string;
}

export interface DeviceKeyPort {
  /**
   * Returns this device's persisted public key, generating one on first call.
   * Idempotent and safe to call before every refresh: the hardware key is
   * one per app install, not one per session — a session that never
   * registered it is unaffected, since the server only requires a signature
   * for a session it was actually told about.
   */
  ensurePublicKey(): Promise<DevicePublicKeyCoordinates>;
  /** Signs `data` with the hardware-backed private key. */
  sign(data: string): Promise<string>;
}

/**
 * An in-memory `DeviceKeyPort`, for tests ONLY — not backed by real hardware
 * and not cryptographically meaningful, the same caveat
 * `createInMemorySecureStore` carries. A real device always has a secure
 * enclave / StrongBox; this exists so `session.ts`'s orchestration logic is
 * testable with no native module present.
 */
export function createInMemoryDeviceKey(): DeviceKeyPort {
  let publicKey: DevicePublicKeyCoordinates | null = null;
  return {
    ensurePublicKey: () => {
      publicKey ??= { x: 'test-x', y: 'test-y' };
      return Promise.resolve(publicKey);
    },
    sign: (data) => Promise.resolve(`test-signature:${data}`),
  };
}
