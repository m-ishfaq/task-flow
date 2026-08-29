import { createStore, type StoreApi } from 'zustand/vanilla';
import type * as NetInfoModule from '@react-native-community/netinfo';

export interface NetworkStatusState {
  readonly isOffline: boolean;
}

export interface NetworkStatus {
  readonly store: StoreApi<NetworkStatusState>;
}

/**
 * `@react-native-community/netinfo` resolves its own native module at the
 * package's own top level, the identical failure mode `biometric-gate.
 * native.ts`'s own header documents at length for `expo-local-
 * authentication` — a static top-level `import` here would throw during
 * Metro's module evaluation wherever the module is not yet linked (Expo Go
 * always; any build made before this dependency existed), poisoning the
 * whole app since `app-session.ts` builds this file's singleton at module
 * load, above `session.restore()`. Loaded lazily instead, memoized the
 * same `async () => import(...)` shape `getModule()` in that file uses —
 * see its header for why `async` specifically, not just a function
 * returning `import(...)` directly.
 */
let modulePromise: Promise<typeof NetInfoModule> | undefined;

async function getModule(): Promise<typeof NetInfoModule> {
  modulePromise ??= import('@react-native-community/netinfo');
  return modulePromise;
}

/**
 * Tracks whether the device currently has no network connection (ai/
 * phase-14-mobile.md's own "offline" gap, found live: every failed
 * mutation read the same generic "Something went wrong" regardless of
 * whether the device had no connection at all).
 *
 * Defaults to `isOffline: false` — "connected" — and stays there if the
 * native module never loads. That is the safe direction: failing to
 * detect offline costs nothing beyond the generic message this exists to
 * sharpen; wrongly telling a connected user they are offline would be a
 * new, worse failure this store must never introduce. The same reasoning
 * is why a `null` `isConnected` (NetInfo's own "don't know yet" state) is
 * folded into `false` below rather than treated as offline.
 *
 * A vanilla `zustand/vanilla` store, not the `create()` hook form — the
 * same split `session.ts` uses, for the same reason: this file stays
 * framework-free and unit-testable with no React renderer, and
 * `use-network-status.ts` is the one binding for it.
 */
export function createNetworkStatus(): NetworkStatus {
  const store = createStore<NetworkStatusState>(() => ({ isOffline: false }));

  void (async () => {
    try {
      const netInfo = (await getModule()).default;
      netInfo.addEventListener((state) => {
        store.setState({ isOffline: state.isConnected === false });
      });
    } catch {
      // Native module unavailable — see this function's own header.
    }
  })();

  return { store };
}
