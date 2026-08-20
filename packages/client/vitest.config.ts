import { defineConfig } from 'vitest/config';

/**
 * jsdom: `optimistic.test.ts` exercises `useOptimistic` via
 * `@testing-library/react`'s `renderHook`, which needs a DOM-ish environment
 * to mount into even though nothing here renders visible markup — the same
 * reasoning `packages/ui`'s own vitest config gives.
 */
export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/testing/setup.ts'],
    css: false,
  },
});
