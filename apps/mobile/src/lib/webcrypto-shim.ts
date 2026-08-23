import 'react-native-get-random-values';

/**
 * The `isomorphic-webcrypto/src/react-native` replacement `metro.config.js`
 * redirects to — found live, not anticipated: `npx expo export` failed to
 * bundle the moment `yjs` (added for `use-doc-page.ts`'s live Docs
 * connection) reached a real device target. `yjs`'s own randomness,
 * `lib0/random`'s `getRandomValues`, resolves through `lib0`'s package
 * `exports` map to `lib0/dist/webcrypto.react-native.cjs` on this platform —
 * a real, load-bearing choice by `lib0` itself, not a Metro quirk — and that
 * file unconditionally `require`s `isomorphic-webcrypto/src/react-native`, a
 * package this app does not (and, per its own dependency on the retired
 * `@unimodules/*`/`expo-random` packages, cannot cleanly) install on a
 * modern Expo SDK.
 *
 * This is what that module is contractually required to export: an object
 * (read as `.default` by `_interopDefaultLegacy`'s fallback branch, which
 * this file's real `export default` also satisfies directly) carrying a
 * no-arg `ensureSecure()`, a `subtle` property, and a `getRandomValues`
 * method — see `dist/webcrypto.react-native.cjs`'s own three lines for the
 * exact contract. `lib0/random.js`'s only actual call is `getRandomValues`
 * (for `Y.Doc`'s client id and similar identifiers, never a security token —
 * nothing this codebase's own `@taskflow/security` module boundary governs,
 * since that guardrail targets THIS app's code, not a third-party
 * dependency's internal RNG choice), so `subtle` is present only to satisfy
 * the shape and is never expected to be called.
 *
 * `react-native-get-random-values` is the real source of randomness: a
 * native module (`SecRandomCopyBytes` on iOS, `SecureRandom` on Android)
 * that polyfills the global `crypto.getRandomValues` the same way it does
 * for every other RN app needing a CSPRNG (`uuid`, `jose`, and this
 * project's own dependency tree already pull it in transitively for
 * exactly that reason). Importing it for its side effect is what makes
 * `crypto.getRandomValues` below real rather than absent.
 *
 * A NATIVE MODULE, though — found live, the same way `use-call.ts`'s own
 * header already documents for `react-native-webrtc`: JS-only Fast Refresh
 * cannot link new native code into a dev client built before this
 * dependency existed. The underlying `NativeModules.RNGetRandomValues`
 * lookup throws its own bare `Error('Native module not found')` with
 * nothing pointing at the actual fix, so it is caught and rethrown here
 * with one — see README.md's "A native dependency, and the dev client that
 * predates it" for the full account and the exact rebuild command.
 */
export default {
  ensureSecure: () => undefined,
  getRandomValues: (array: Parameters<typeof crypto.getRandomValues>[0]) => {
    try {
      return crypto.getRandomValues(array);
    } catch (cause) {
      throw new Error(
        'react-native-get-random-values needs a native rebuild — this dev client predates it. ' +
          'Run `npx eas-cli build --profile development --platform android` (or `ios`), install ' +
          'the result, then `pnpm --filter @taskflow/mobile start --dev-client`. See ' +
          'apps/mobile/README.md, "A native dependency, and the dev client that predates it".',
        { cause },
      );
    }
  },
  subtle: crypto.subtle,
};
