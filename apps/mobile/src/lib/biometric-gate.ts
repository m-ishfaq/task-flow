/**
 * Biometric app-lock (ai/phase-14-mobile.md §4.4).
 *
 * "This is a LOCAL gate, not a second server factor — it never replaces
 * `can()` or the token." Nothing here talks to the server, and nothing here
 * lives in `session.ts`'s token-exchange logic on purpose: gating the
 * refresh EXCHANGE itself would mean prompting Face ID on every ordinary
 * mid-session access-token renewal (every ~15 minutes), which is not what
 * "gates reading the stored refresh token after a cold start" means. The
 * gate instead sits in `app/_layout.tsx`, ABOVE `session.restore()` — it
 * decides WHETHER cold-start restoration is allowed to run at all, once,
 * per launch. `session.ts` stays exactly what it was: pure token lifecycle,
 * with one new read-only addition (`hasStoredCredential`) so the gate can
 * decide there is nothing to protect before ever prompting.
 *
 * Split from its real implementation the same way `secure-store.ts` and
 * `device-key.ts` are: the real backing (`biometric-gate.native.ts`) imports
 * `expo-local-authentication`, which pulls in React Native's Flow-typed
 * source Vitest's transform cannot parse.
 */
export interface BiometricGate {
  /** Whether the device has usable biometrics (or a device passcode fallback) enrolled at all. */
  isAvailable(): Promise<boolean>;
  /**
   * Prompts the platform's Face ID / fingerprint / passcode ceremony.
   * Resolves `false` on a wrong biometric, a cancellation, or any failure —
   * there is nothing more specific worth telling apart here, the same "one
   * answer" reasoning `PasskeyVerificationError` uses server-side.
   */
  authenticate(): Promise<boolean>;
}
