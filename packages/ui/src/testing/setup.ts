import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

/** Same reasoning as apps/web/src/testing/setup.ts: one shared document, so
    a leftover node from the previous test makes the next query ambiguous. */
afterEach(() => {
  cleanup();
});
