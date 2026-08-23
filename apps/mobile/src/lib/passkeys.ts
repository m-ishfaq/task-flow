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
 * cryptography of its own, the OS does) was originally imported STATICALLY
 * and directly from the screens that need it (`sign-in.tsx`, `home.tsx`),
 * on the reasoning that there is no orchestration state worth hiding behind
 * a DI seam the way `device-key.ts`/`biometric-gate.ts` needed one. That
 * reasoning covered where the CALLS live, not the IMPORT — a real run found
 * the same bug device binding and the biometric gate already had:
 * `react-native-passkeys`'s own `ReactNativePasskeysModule.js` calls
 * `requireNativeModule('ReactNativePasskeys')` at ITS top level, so a
 * static top-level `import` of the package in either screen threw the
 * moment Metro evaluated that route module, wherever the module isn't
 * linked (Expo Go always — a third-party native module Expo Go can never
 * bundle, unlike an official Expo SDK package; any development build built
 * before this landed). `loadPasskeys` below is the fix: a memoized dynamic
 * `import()`, called from both screens instead of a static one, the same
 * shape `biometric-gate.native.ts`'s `getNative()` already uses for the
 * identical reason. This file stays a plain, Vitest-safe helper regardless
 * — `import type` is erased before anything touches the real package, so
 * nothing here forces `react-native-passkeys`'s Flow-typed dependency
 * chain into a test's module graph the way a value import would.
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
import type * as PasskeysModule from 'react-native-passkeys';

let modulePromise: Promise<typeof PasskeysModule> | undefined;

/**
 * Loads `react-native-passkeys` on first use — see this file's own header
 * for why a static top-level import used to crash the whole app.
 *
 * Declared `async` deliberately, not a plain function returning
 * `import(...)` directly: Metro's dynamic-`import()` transform for React
 * Native does not do real code-splitting, and a module whose top-level code
 * throws (this one always will, wherever it isn't linked — see the header)
 * can throw SYNCHRONOUSLY out of the `import()` call rather than returning
 * a rejected promise. A plain function let that throw escape straight past
 * both callers' `.then()/.catch()` chains — neither is a `try` block —
 * confirmed live: the exact "app boots, then errors" this fix was for.
 * `async` guarantees the opposite by JS semantics: any synchronous throw
 * inside an async function body becomes that function's rejected return
 * value, regardless of how the caller invokes it.
 */
export async function loadPasskeys(): Promise<typeof PasskeysModule> {
  modulePromise ??= import('react-native-passkeys');
  return modulePromise;
}

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
