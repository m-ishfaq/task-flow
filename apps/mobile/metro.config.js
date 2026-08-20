// @ts-check
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

/** @type {import('metro-resolver').CustomResolver} */
resolver.resolveRequest = (context, moduleName, platform) => {
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

  return defaultResolveRequest
    ? defaultResolveRequest(context, moduleName, platform)
    : context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
