import { useStore } from 'zustand';
import { session } from './app-session.js';
import type { SessionState } from './session.js';

/**
 * Binds a screen to the app's one session store (ai/phase-14-mobile.md §7).
 *
 * `session.store` is a vanilla Zustand store (`createStore` from
 * `zustand/vanilla`, in `session.ts`) rather than the `create()` hook form —
 * deliberately, so `session.ts` stays framework-free and unit-testable with no
 * React renderer (§11). `useStore` is Zustand's own binding for exactly this
 * split: a vanilla store built once, subscribed to from as many components as
 * need it.
 */
export function useSession<T>(selector: (state: SessionState) => T): T {
  return useStore(session.store, selector);
}
