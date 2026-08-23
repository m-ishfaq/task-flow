// @ts-check
const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

/**
 * Metro config (ai/phase-14-mobile.md §5, §10).
 *
 * Every relative import in this app writes a `.js` extension against a `.ts`
 * source file — `import { session } from '../../src/lib/app-session.js'` —
 * the same NodeNext-style convention `apps/api`, `apps/web` and every
 * `packages/*` use throughout this repo (`tsconfig`'s `moduleResolution`
 * rewrites it for `tsc` and Vitest). Metro's own resolver does not do that
 * rewrite: left at its default, EVERY route in `app/` fails to bundle with
 * "Unable to resolve module ... None of these files exist" — a failure
 * `tsc --noEmit` and `eslint` cannot see, because both already understand
 * the convention Metro does not. Confirmed by actually running
 * `expo export` before this file existed; every screen failed identically.
 *
 * The fix is narrow on purpose: only a RELATIVE import (`./`, `../`) ending
 * in `.js` gets the rewrite attempt, and only after trying `.ts`/`.tsx` does
 * it fall back to Metro's own default resolution — so an import that
 * genuinely means a literal `.js` file (a third-party package, a real `.js`
 * asset) is unaffected. `require('expo/metro-config')`'s CommonJS form is
 * required here: Metro loads this file directly with Node, before any of
 * this project's own ESM/TypeScript tooling is available to it.
 */
const config = getDefaultConfig(__dirname);

const { resolver } = config;
const { resolveRequest: defaultResolveRequest } = resolver;

/**
 * Forces `react` and `@tanstack/react-query` to a single physical copy
 * across the whole bundle — found live, not anticipated: opening a card
 * threw `[Error: No QueryClient set, use QueryClientProvider to set one]`
 * from inside `@taskflow/client`'s `useOptimistic` (`packages/client/src/
 * optimistic.ts`), despite `app/_layout.tsx` genuinely wrapping the whole
 * tree in `QueryClientProvider`.
 *
 * The cause: Metro resolves a bare specifier starting from the NEAREST
 * `node_modules` above the IMPORTING FILE, not from this app's root. This
 * app pins `react` to an EXACT version (`19.2.3`, Expo SDK 57's own
 * requirement — not a version to change casually); `packages/client`'s
 * `package.json` separately devDependency-pins a newer `react` range for
 * ITS OWN test suite. Because `@tanstack/react-query` has a peer dependency
 * on `react`, pnpm resolves that difference into two PHYSICALLY SEPARATE
 * copies of `@tanstack/react-query` in the pnpm store — confirmed by
 * `readlink -f` on each package's `node_modules/@tanstack/react-query`,
 * which pointed at two different `.pnpm/@tanstack+react-query@…_react@…`
 * directories. `optimistic.ts`, physically inside `packages/client/`, gets
 * the copy resolved against ITS package's own `react`; `app/_layout.tsx`,
 * physically inside this app, gets the copy resolved against THIS app's
 * `react`. Two module instances means two distinct `React.createContext()`
 * objects for `QueryClientContext` — the Provider from one instance is
 * invisible to `useQueryClient()` from the other, which is exactly what
 * "No QueryClient set" means despite a provider genuinely being mounted.
 *
 * `resolver.extraNodeModules` was the first thing tried here and does
 * NOT work: Expo's default config sets `unstable_enablePackageExports:
 * true`, and `@tanstack/react-query`/`react` both ship a `package.json`
 * `exports` map, so Metro resolves them through THAT mechanism, which does
 * not consult `extraNodeModules` at all — confirmed by rebuilding with
 * `--source-maps` and grepping the emitted map's `sources` for both pnpm
 * variant directories; both were still present after the extraNodeModules
 * attempt. `PINNED_SINGLETONS` below intercepts these two bare specifiers
 * BEFORE Metro's own resolution strategy runs at all, by rewriting
 * `context.originModulePath` to a fixed file inside THIS app and calling
 * Metro's real resolver from there — which forces whichever resolution
 * strategy Metro picks (package-exports or the legacy walk) to start from
 * this app's own `node_modules`, regardless of which package's file
 * actually contained the `import`. Re-verified the same way after
 * switching to this approach: the rebuilt sourcemap contains exactly one
 * `@tanstack+react-query@…` directory.
 *
 * `apps/web`'s separate Vite build is untouched by this file entirely, so
 * this fixes the bug where it was found without touching the platform
 * where it was not.
 */
const PINNED_SINGLETONS = new Set(['react', '@tanstack/react-query']);
/** A real file inside this app, used only as the fixed resolution root below — never actually imported. */
const APP_ROOT_MODULE = path.join(__dirname, 'package.json');

/**
 * `yjs` (added for `use-doc-page.ts`'s live Docs connection) pulls in
 * `lib0`, whose own package `exports` map sends `lib0/webcrypto` through
 * `dist/webcrypto.react-native.cjs` on this platform — a real, load-bearing
 * choice `lib0` itself makes, not a Metro default — and that file
 * unconditionally `require`s `isomorphic-webcrypto/src/react-native`, a
 * package this app does not install (its own react-native path depends on
 * the retired `@unimodules/*`/`expo-random` packages, incompatible with a
 * modern Expo SDK — see `webcrypto-shim.ts`'s own header for the full
 * account). `expo export --platform android` failed to bundle at all until
 * this redirect existed; `resolver.extraNodeModules` cannot be the fix here
 * for the identical reason the singleton pin above cannot use it — this is
 * exactly one more bare specifier resolved through Metro's custom resolver,
 * this time to a real file rather than to a different root.
 */
const WEBCRYPTO_SHIM_SPECIFIER = 'isomorphic-webcrypto/src/react-native';
const WEBCRYPTO_SHIM_PATH = path.join(__dirname, 'src', 'lib', 'webcrypto-shim.ts');

/** @type {import('metro-resolver').CustomResolver} */
resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === WEBCRYPTO_SHIM_SPECIFIER) {
    return { type: 'sourceFile', filePath: WEBCRYPTO_SHIM_PATH };
  }

  const isRelative = moduleName.startsWith('./') || moduleName.startsWith('../');

  if (isRelative && moduleName.endsWith('.js')) {
    const withoutExtension = moduleName.slice(0, -'.js'.length);

    for (const candidateExtension of ['.ts', '.tsx']) {
      try {
        return context.resolveRequest(
          context,
          `${withoutExtension}${candidateExtension}`,
          platform,
        );
      } catch {
        // Not this extension — fall through to the next candidate, then to
        // Metro's own resolution of the original (still `.js`) specifier.
      }
    }
  }

  // A bare specifier (`react`) or one of its subpaths (`react/jsx-runtime`)
  // — never a scoped subpath of an unrelated package, so this only ever
  // matches the two packages actually observed to split (see this file's
  // own header for why forcing every shared dependency this way would be
  // an unverified, broader change than the bug that was found).
  const singleton = [...PINNED_SINGLETONS].find(
    (name) => moduleName === name || moduleName.startsWith(`${name}/`),
  );
  if (singleton !== undefined) {
    return context.resolveRequest(
      { ...context, originModulePath: APP_ROOT_MODULE },
      moduleName,
      platform,
    );
  }

  return defaultResolveRequest
    ? defaultResolveRequest(context, moduleName, platform)
    : context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
