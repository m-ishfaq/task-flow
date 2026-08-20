import { base } from '@taskflow/config/eslint/base';
import { security } from '@taskflow/config/eslint/security';
import { react } from '@taskflow/config/eslint/react';

/**
 * Root lint config — applies the shared base plus every architectural guardrail
 * across the whole workspace.
 *
 * Guardrail configs in security.js use `files` / `ignores` globs relative to the
 * repo root, so they must be composed here rather than per-package.
 *
 * There is deliberately NO per-package `eslint.config.js` anywhere in this
 * repository, and adding one is how the guardrails get switched off by accident:
 * flat config does not cascade, so `eslint src` run inside a package finds that
 * file first and never reaches this one. Framework-specific rules are composed
 * here with a `files` scope instead — see the react block below and the header
 * comment in packages/config/eslint/react.js.
 */
export default [
  ...base,
  ...security,

  /* React rules, scoped to the app that renders plus `packages/ui`
     (ai/phase-6.5-ui-polish.md Wave 3) — the design system extracted from it,
     which is JSX too and gets the same hooks/a11y rules for the same reason.
     `packages/client` joins them for an identical reason (ai/phase-14-mobile.md
     §12 decision 4): `useOptimistic` is a real React hook, extracted out of
     apps/web, and the rules-of-hooks check that would have caught a misuse in
     apps/web must not silently stop applying just because the hook moved.
     Safe to place after the guardrails because the block sets no
     `no-restricted-syntax` of its own — the option array security.js builds
     would otherwise be replaced wholesale for every file this matches. */
  ...react.map((config) => ({
    ...config,
    files: ['apps/web/**/*.{ts,tsx}', 'packages/ui/**/*.{ts,tsx}', 'packages/client/**/*.{ts,tsx}'],
  })),

  {
    ignores: ['**/dist/**', '**/build/**', '**/coverage/**', '**/.turbo/**', 'docs/**'],
  },
];
