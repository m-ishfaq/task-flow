import { base } from '@taskflow/config/eslint/base';
import { security } from '@taskflow/config/eslint/security';

/**
 * Root lint config — applies the shared base plus every architectural guardrail
 * across the whole workspace.
 *
 * Guardrail configs in security.js use `files` / `ignores` globs relative to the
 * repo root, so they must be composed here rather than per-package. Individual
 * apps may append framework-specific rules in their own eslint.config.js, but
 * must never remove a guardrail.
 */
export default [
  ...base,
  ...security,
  {
    ignores: ['**/dist/**', '**/build/**', '**/coverage/**', '**/.turbo/**', 'docs/**'],
  },
];
