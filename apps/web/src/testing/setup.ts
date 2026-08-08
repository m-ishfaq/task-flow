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

/**
 * jsdom implements no layout engine, so it implements no `matchMedia` either
 * — there is no viewport for a media query to evaluate against. Every
 * existing test in this suite was written against desktop behaviour (the
 * sidebar's rail collapse, both list/detail panes visible at once), so this
 * always reports a match: `useIsDesktop` (`lib/use-media-query.ts`,
 * ai/phase-6.5-ui-polish.md Wave 6) sees `isDesktop: true` here exactly as it
 * would in a real desktop browser, and no existing test's behaviour changes
 * by this file existing. A future test that specifically wants the MOBILE
 * branch of a responsive component needs to override this per-test — this
 * global default deliberately does not try to guess which one a given test
 * wants.
 */
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string): MediaQueryList => ({
    matches: true,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  });
}
