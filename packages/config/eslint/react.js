import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactRefresh from 'eslint-plugin-react-refresh';

/**
 * React rules for apps/web.
 *
 * ## Why this is composed at the repo root and not inside apps/web
 *
 * ESLint flat config does NOT cascade. `eslint src` resolves the nearest
 * `eslint.config.js` by walking up from the working directory and stops at the
 * first one it finds — so an `apps/web/eslint.config.js` would REPLACE the root
 * config rather than extend it, and the web app would quietly lose every
 * guardrail in security.js: no `dangerouslySetInnerHTML` ban, no `Math.random`
 * ban, no `@taskflow/db` import ban. Lint would still pass, and pass faster.
 *
 * That is the same failure shape security.js warns about at the top of its own
 * file — a later config silently replacing an earlier one rather than merging
 * with it — reached by a different route. So no package owns a config; the root
 * composes all of them.
 *
 * This block carries no `files` scope. The root config attaches it to
 * `apps/web/**`, which is where JSX exists. It also declares no
 * `no-restricted-syntax`, so it cannot replace the guardrail list.
 */
export const react = [
  {
    name: 'taskflow/react',
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      'react-hooks': reactHooks,
      'jsx-a11y': jsxA11y,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,

      /**
       * Accessibility rules, which are load-bearing rather than decorative here.
       *
       * A kanban board is a drag-and-drop surface, and the keyboard-only path
       * through it is the one nobody exercises by accident. dnd-kit ships
       * keyboard sensors (§4.1); these rules are what catch the hand-rolled
       * `<div onClick>` that silently bypasses them.
       */
      ...jsxA11y.flatConfigs.recommended.rules,

      /* A module exporting both a component and a value breaks fast refresh: the
         module remounts wholesale, so in-flight drag state and open dialogs are
         lost on every save. A warning — development ergonomics, not correctness. */
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
];

export default react;
