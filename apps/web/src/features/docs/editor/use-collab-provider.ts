import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { HocuspocusProvider, WebSocketStatus } from '@hocuspocus/provider';
import * as Y from 'yjs';
import type { OrgId, PageId } from '@taskflow/contracts';
import { accessToken } from '../../../lib/session.js';
import { collabWebsocketUrl, pageDocumentName } from './collab-url.js';

/**
 * The collaborative connection for one open page (ai/phase-6-docs.md §3.2,
 * Wave 2).
 *
 * One `HocuspocusProvider` (and its `Y.Doc`) per mounted editor, torn down
 * on unmount or whenever `pageId` changes — `docs-page.tsx` already
 * `key={search.page}`-remounts `PagePanel` per page, so this hook does not
 * additionally need to reset an existing provider's document; a page switch
 * always means a fresh mount here rather than a `provider.setConfiguration`
 * hand-off. Two open pages are two independent connections, exactly as two
 * open boards are two independent Socket.io rooms.
 *
 * `token` is a function, not a resolved string, and re-invoked on every
 * (re)connection attempt (the provider's own `getToken()` calls it) —
 * `accessToken()` is the same single-flight, auto-refreshing function every
 * tRPC request and `lib/socket.ts` use, so a token that expired while this
 * tab was idle is renewed transparently on reconnect rather than failing
 * the handshake with a stale one.
 *
 * ## Why `provider` is an external store, not a `useState`
 *
 * The provider opens a WebSocket, so it can only be constructed as an effect
 * — never during render — and the effect body may not call setState
 * synchronously (react-hooks/set-state-in-effect, the same rule that shapes
 * `use-board-room.ts`). The React-sanctioned way to make a value created by
 * a side effect observable to render is `useSyncExternalStore` over a
 * one-slot store the effect writes to: `provider` is `null` for the one
 * render between mount and the effect running, and the store notifies React
 * the moment the effect has a provider to show. `docs-editor.tsx` renders a
 * connecting state for that render instead of assuming a provider always
 * exists.
 *
 * The store lives in a ref, not a `useState` object: the effect mutates it
 * after mount, and `react-hooks/immutability` treats a value handed out by
 * `useState` as owned by React. `react-hooks/refs` is satisfied because the
 * only read happens inside `useSyncExternalStore`'s `getSnapshot` — the one
 * place the React docs themselves sanction reading a ref during render.
 */

export type CollabStatus = 'connecting' | 'connected' | 'disconnected';

export interface CollabConnection {
  readonly provider: HocuspocusProvider | null;
  readonly status: CollabStatus;
  readonly synced: boolean;
}

/** The one-slot store `useSyncExternalStore` reads the provider from. */
interface ProviderStore {
  provider: HocuspocusProvider | null;
  listeners: Set<() => void>;
}

function toCollabStatus(status: WebSocketStatus): CollabStatus {
  switch (status) {
    case WebSocketStatus.Connected:
      return 'connected';
    case WebSocketStatus.Connecting:
      return 'connecting';
    case WebSocketStatus.Disconnected:
      return 'disconnected';
  }
}

export function useCollabProvider(orgId: OrgId, pageId: PageId): CollabConnection {
  const [status, setStatus] = useState<CollabStatus>('connecting');
  const [synced, setSynced] = useState(false);

  /* The store object is created once per mount — held in a ref, mutated by
     the effect below, and read by `useSyncExternalStore`'s `getSnapshot`,
     the one ref read the compiler rules sanction during render. A lazy
     `useState` initializer was the first draft and is exactly what
     `react-hooks/immutability` forbids the effect to touch afterwards. */
  const storeRef = useRef<ProviderStore>({ provider: null, listeners: new Set() });

  const subscribe = useCallback((listener: () => void) => {
    storeRef.current.listeners.add(listener);
    return () => storeRef.current.listeners.delete(listener);
  }, []);

  const provider = useSyncExternalStore(subscribe, () => storeRef.current.provider);

  /* Connection state resets when the page identity changes, during render
     rather than in the effect below — the documented pattern for "clear
     derived state when a prop changes", and the identical shape
     `use-board-room.ts` and `use-channel-room.ts` use for their presence
     reset. A fresh mount already starts with these defaults; this covers the
     caller that does not remount us per page. */
  const connectionKey = `${orgId}:${pageId}`;
  const [lastConnectionKey, setLastConnectionKey] = useState(connectionKey);
  if (connectionKey !== lastConnectionKey) {
    setLastConnectionKey(connectionKey);
    setStatus('connecting');
    setSynced(false);
  }

  useEffect(() => {
    /* Snapshot the store for the effect's whole lifetime — its identity is
       stable for the mount, and reading `storeRef.current` inside the
       cleanup would trip exhaustive-deps' "ref will have changed" warning.
       The provider is what changes, never the store. */
    const store = storeRef.current;

    const created = new HocuspocusProvider({
      url: collabWebsocketUrl(orgId),
      name: pageDocumentName(pageId),
      document: new Y.Doc(),
      token: () => accessToken().then((value) => value ?? ''),
      onStatus: ({ status: nextStatus }) => {
        setStatus(toCollabStatus(nextStatus));
      },
      onSynced: ({ state }) => {
        setSynced(state);
      },
    });

    store.provider = created;
    for (const listener of store.listeners) listener();

    return () => {
      created.destroy();
      created.document.destroy();
      store.provider = null;
      for (const listener of store.listeners) listener();
    };
  }, [orgId, pageId]);

  return { provider, status, synced };
}
