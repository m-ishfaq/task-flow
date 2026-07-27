import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importX from 'eslint-plugin-import-x';
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

/**
 * Base lint config shared by every workspace package.
 *
 * Type-aware linting is ON (`projectService`). It is slower, but the rules that
 * actually catch bugs — no-floating-promises, no-misused-promises,
 * no-unnecessary-condition — are all type-aware. Do not disable it to speed up CI;
 * cache instead.
 */
export const base = tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/.turbo/**',
      '**/node_modules/**',
      '**/*.tsbuildinfo',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: process.cwd(),
      },
      globals: { ...globals.node },
    },
    plugins: { 'import-x': importX },
    settings: {
      // import-x v4 dropped the legacy `import-x/resolver: { typescript: true }`
      // shape — it loads but reports "invalid interface loaded as resolver" on
      // every file. The resolver-next API is the supported form.
      'import-x/resolver-next': [
        createTypeScriptImportResolver({
          alwaysTryTypes: true,
          project: ['packages/*/tsconfig.json', 'apps/*/tsconfig.json', 'tsconfig.json'],
          // A monorepo legitimately has many tsconfigs; the suggested single
          // config with references would couple every package's build graph.
          noWarnOnMultipleProjects: true,
        }),
      ],
    },
    rules: {
      /* --- Correctness --------------------------------------------------- */
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'warn',
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],

      /* --- Escape hatches are the whole problem (guardrail 7) ------------- */
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/ban-ts-comment': [
        'error',
        {
          'ts-expect-error': { descriptionFormat: '^: TF-\\d+ .+$' },
          'ts-ignore': true,
          'ts-nocheck': true,
          'ts-check': false,
        },
      ],

      /* --- Import hygiene ------------------------------------------------ */
      'import-x/no-cycle': ['error', { maxDepth: 4 }],
      'import-x/no-self-import': 'error',
      'import-x/no-extraneous-dependencies': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],

      /* --- Unused ---------------------------------------------------------*/
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },

  /* Config files and scripts are exempt from type-aware rules. */
  {
    files: ['**/*.config.{js,ts,mjs}', '**/scripts/**/*.{js,ts}', 'eslint.config.js'],
    ...tseslint.configs.disableTypeChecked,
    rules: { 'no-console': 'off' },
  },

  prettier,
);

export default base;
