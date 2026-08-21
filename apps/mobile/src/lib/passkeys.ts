/**
 * Passkeys, the pure half (ai/phase-14-mobile.md §4.4) — the one Wave 1b
 * item genuinely gated on external infrastructure that does not exist yet
 * (a production domain hosting `.well-known/apple-app-site-association` and
 * `assetlinks.json`, a real signing certificate). See the README's own
 * "Passkeys" section for the deployment checklist; nothing here is
 * incomplete CODE, only incomplete INFRASTRUCTURE.
 *
 * `react-native-passkeys` (a thin wrapper over `ASAuthorizationController`
 * on iOS and Android's `CredentialManager` — it implements no WebAuthn
 * cryptography of its own, the OS does) is imported directly from the
 * screens that need it (`sign-in.tsx`, `home.tsx`), mirroring `oauth.ts`'s
 * own precedent: there is no orchestration state worth hiding behind a DI
 * seam the way `device-key.ts`/`biometric-gate.ts` needed one, so this file
 * stays a plain, Vitest-safe helper rather than a fourth `.native.ts` split.
 *
 * The one piece of real logic — and the one place a client/server shape
 * mismatch could hide, the same bug class CLAUDE.md's own Phase 3 section
 * documents for TipTap's extra attributes — is `toRegistrationResponse`:
 * the library's `create()` result carries a `getPublicKey()` METHOD the
 * server's `.strict()` Zod schema has no field for. `JSON.stringify` would
 * silently drop it before it ever reached the wire, but relying on that
 * implicitly is exactly the kind of trust this codebase's guardrails argue
 * against — so it is dropped explicitly, once, here.
 */

/** The shape `react-native-passkeys`' `create()` resolves to — structural, not imported, so this file needs no native module in its graph. */
export interface PasskeyCreationResult {
  readonly id: string;
  readonly rawId: string;
  readonly response: {
    readonly clientDataJSON: string;
    readonly attestationObject: string;
    readonly transports?: readonly string[];
    readonly publicKeyAlgorithm?: number;
    readonly publicKey?: string;
    readonly authenticatorData?: string;
  };
  readonly authenticatorAttachment?: string;
  readonly clientExtensionResults: Record<string, unknown>;
  readonly type: 'public-key';
}

/**
 * Strips the library's `getPublicKey()` convenience method, leaving exactly
 * what `packages/security`'s `RegistrationResponse` Zod schema (`.strict()`
 * on `response`) accepts.
 */
export function toRegistrationResponse(result: PasskeyCreationResult): PasskeyCreationResult {
  return {
    id: result.id,
    rawId: result.rawId,
    response: {
      clientDataJSON: result.response.clientDataJSON,
      attestationObject: result.response.attestationObject,
      ...(result.response.transports === undefined
        ? {}
        : { transports: result.response.transports }),
      ...(result.response.publicKeyAlgorithm === undefined
        ? {}
        : { publicKeyAlgorithm: result.response.publicKeyAlgorithm }),
      ...(result.response.publicKey === undefined ? {} : { publicKey: result.response.publicKey }),
      ...(result.response.authenticatorData === undefined
        ? {}
        : { authenticatorData: result.response.authenticatorData }),
    },
    ...(result.authenticatorAttachment === undefined
      ? {}
      : { authenticatorAttachment: result.authenticatorAttachment }),
    clientExtensionResults: result.clientExtensionResults,
    type: result.type,
  };
}
