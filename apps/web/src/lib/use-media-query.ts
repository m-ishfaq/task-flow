import { useSyncExternalStore } from 'react';

/**
 * A CSS media query as a React boolean, kept in sync via `matchMedia`'s own
 * change event rather than a resize listener + manual width comparison —
 * the query is the single source of truth for the breakpoint, so this can
 * never disagree with the Tailwind `md:` classes it's meant to coordinate
 * with (ai/phase-6.5-ui-polish.md Wave 6).
 *
 * `useSyncExternalStore`, not `useState` + `useEffect`: the effect version
 * renders once with the WRONG value (whatever the initial `useState` default
 * was) before the effect runs and corrects it — a real flash of "mobile"
 * layout on a desktop's first paint, or vice versa. `useSyncExternalStore`
 * reads a synchronous snapshot before the first render, so there is no wrong
 * frame to flash.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(query);
      mql.addEventListener('change', onChange);
      return () => {
        mql.removeEventListener('change', onChange);
      };
    },
    () => window.matchMedia(query).matches,
  );
}

/**
 * Tailwind's default `md` breakpoint (768px), restated here as the one place
 * that has to agree with every `md:` class this phase's responsive work
 * added — `styles.css` doesn't override Tailwind's breakpoints, so this is
 * the number itself, not a token reference to one.
 */
export function useIsDesktop(): boolean {
  return useMediaQuery('(min-width: 768px)');
}
