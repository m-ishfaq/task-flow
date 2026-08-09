import { defineConfig } from 'vitest/config';

/**
 * jsdom, not the node default: every test here renders a Radix compound
 * component and asserts on the DOM Radix produces (portals, `data-state`,
 * focus). `apps/web`'s own vitest.config.ts uses the same environment for the
 * same reason.
 */
export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/testing/setup.ts'],
    css: false,
  },
});
