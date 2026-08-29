import { useStore } from 'zustand';
import { networkStatus } from './app-session.js';

/**
 * Binds a screen to the app's one network-status store — the identical
 * shape `use-session.ts` uses for `session.ts`'s vanilla store, and for
 * the same reason: `network-status.ts` stays framework-free.
 */
export function useIsOffline(): boolean {
  return useStore(networkStatus.store, (state) => state.isOffline);
}
