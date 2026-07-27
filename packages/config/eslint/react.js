import globals from 'globals';
import { base } from './base.js';
import { security } from './security.js';

/**
 * Lint config for apps/web.
 *
 * React-specific plugins (react-hooks, jsx-a11y, react-refresh) are added in
 * Phase 3 when apps/web gains real components — installing them now would add
 * dependencies with nothing to lint.
 */
export const react = [
  ...base,
  ...security,
  {
    name: 'taskflow/react',
    languageOptions: {
      globals: { ...globals.browser },
    },
  },
];

export default react;
