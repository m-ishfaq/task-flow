import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

/**
 * Test setup for apps/web.
 *
 * `cleanup` after every test because Testing Library renders into a shared
 * document. Without it, a query like `getByRole('button', { name: 'Save' })`
 * finds the previous test's button and the suite passes for the wrong reason —
 * or fails with "found multiple elements" in whichever test happens to run
 * second, which reads as a bug in that test rather than in the harness.
 */
afterEach(() => {
  cleanup();
});
