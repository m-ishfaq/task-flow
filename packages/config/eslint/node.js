import globals from 'globals';
import { base } from './base.js';
import { security } from './security.js';

/** Lint config for server apps and Node-targeted packages. */
export const node = [
  ...base,
  ...security,
  {
    name: 'taskflow/node',
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // Server code must not silently swallow async failures.
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/return-await': ['error', 'in-try-catch'],
    },
  },
];

export default node;
