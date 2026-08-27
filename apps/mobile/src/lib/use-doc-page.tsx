import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  HocuspocusProvider,
  WebSocketStatus,
  type HocuspocusProviderConfiguration,
} from '@hocuspocus/provider';
import * as Y from 'yjs';
import { CLIENT_HEADER, MOBILE_CLIENT } from '@taskflow/contracts';
import { collabBaseUrl, session } from './app-session.js';
import { collabWebsocketUrl, pageDocumentName } from './docs-collab.js';

/**
 * The live collaborative connection for one open Docs page — the native
 * counterpart of `apps/web/src/features/docs/editor/use-collab-provider
 * .ts`, whose own header is the one to read first: the `useSyncExternalStore`
 * shape below is not a stylistic choice, it is what React's own rules
 * require once a `HocuspocusProvider` (which opens a WebSocket) can only be
 * constructed as an effect, never during render.
 *
 * ## The one real difference from web: the WebSocket itself
 *
 * A browser's `WebSocket` cannot have custom headers set on it — the
 * platform simply does not expose that — which is why web's own
 * `collabWebsocketUrl` leans on the browser attaching a real `Origin`
 * automatically instead. React Native's `WebSocket` is not that
 * constructor: it is RN's own implementation, and its 3rd constructor
 * argument accepts `{ headers }`, threaded down to the native networking
 * layer. `NativeCollabSocket` below is a thin subclass that always adds
 * `CLIENT_HEADER: MOBILE_CLIENT` — the identical marker `socket.ts`'s
 * `extraHeaders` already sends the Socket.IO connections, now sent here
 * too — and is handed to `HocuspocusProvider` as its `WebSocketPolyfill`
 * (a real, documented Hocuspocus option; the provider constructs it with
 * only a URL, so a plain subclass is the only way to inject the header
 * without forking the library). `apps/collab/src/auth.ts`'s own
 * `isNativeClient`/`isSelfOrigin` — ported from `apps/realtime/src/auth
 * .ts` for exactly this connection — is the other half; see that file's
 * own header for why both are required together.
 *
 * `WebSocketPolyfill: any` in Hocuspocus's own types is why this needs a
 * `// eslint-disable` nowhere — the subclass itself is fully typed, only
 * the library's own option accepts anything.
 *
 * Two narrower type gaps, both in ambient declarations this codebase does
 * not own, rather than in anything above:
 *
 * TypeScript's only `WebSocket` ambient type in scope is `lib.dom`'s browser
 * one — React Native ships `Libraries/WebSocket/WebSocket.js` as plain Flow,
 * with no `.d.ts`, so `tsc` has no way to see its real 3-argument
 * constructor. `NativeWebSocketConstructor` restates that real signature so
 * the subclass below can call it; the cast is of the ambient CONSTRUCTOR
 * TYPE, not of any value this file computes.
 *
 * `HocuspocusProviderConfiguration`'s `url`-branch (used below, exactly as
 * web's own `use-collab-provider.ts` uses it) only re-exposes `url` and
 * `preserveTrailingSlash` from the websocket-level config it forwards to —
 * `WebSocketPolyfill` lives there too at runtime (`HocuspocusProvider`
 * passes this same object straight to `new HocuspocusProviderWebsocket(...)`
 * when no `websocketProvider` is supplied), but the published type omits it
 * from that branch. `ProviderConfiguration` restates the field the library
 * already reads, rather than switching to the `websocketProvider` branch —
 * that branch skips the constructor's own `if (this.manageSocket) this
 * .attach()` wiring, which would need reimplementing by hand for no benefit.
 */

type NativeWebSocketConstructor = new (
  url: string,
  protocols: undefined,
  options: { headers: Record<string, string> },
) => WebSocket;

class NativeCollabSocket extends (WebSocket as unknown as NativeWebSocketConstructor) {
  constructor(url: string) {
    super(url, undefined, { headers: { [CLIENT_HEADER]: MOBILE_CLIENT } });
  }
}

type ProviderConfiguration = HocuspocusProviderConfiguration & {
  readonly WebSocketPolyfill: NativeWebSocketConstructor;
};

export type DocPageStatus = 'connecting' | 'connected' | 'disconnected';

export interface DocPageConnection {
  readonly doc: Y.Doc | null;
  readonly status: DocPageStatus;
  readonly synced: boolean;
}

interface ProviderStore {
  provider: HocuspocusProvider | null;
  listeners: Set<() => void>;
}

function toDocPageStatus(status: WebSocketStatus): DocPageStatus {
  switch (status) {
    case WebSocketStatus.Connected:
      return 'connected';
    case WebSocketStatus.Connecting:
      return 'connecting';
    case WebSocketStatus.Disconnected:
      return 'disconnected';
  }
}

/**
 * One page's live connection, read-only — nothing here ever calls
 * `provider.document`'s own mutation methods; see `docs.ts`'s own header
 * for why writing stays out of this pass.
 *
 * `orgId` is nullable for the identical reason `use-board-room.ts`'s own
 * `useBoardRoom` takes `string | null`: `useSession((state) => state.orgId)`
 * is the caller's only source for it, and stays typed that way everywhere
 * in this app even though every screen that reaches this hook is already
 * behind the org gate. The effect below no-ops rather than connecting with
 * an empty org id.
 */
export function useDocPage(orgId: string | null, pageId: string): DocPageConnection {
  const [status, setStatus] = useState<DocPageStatus>('connecting');
  const [synced, setSynced] = useState(false);

  const storeRef = useRef<ProviderStore>({ provider: null, listeners: new Set() });

  const subscribe = useCallback((listener: () => void) => {
    storeRef.current.listeners.add(listener);
    return () => storeRef.current.listeners.delete(listener);
  }, []);

  const provider = useSyncExternalStore(subscribe, () => storeRef.current.provider);

  const connectionKey = `${orgId ?? ''}:${pageId}`;
  const [lastConnectionKey, setLastConnectionKey] = useState(connectionKey);
  if (connectionKey !== lastConnectionKey) {
    setLastConnectionKey(connectionKey);
    setStatus('connecting');
    setSynced(false);
  }

  useEffect(() => {
    if (orgId === null) return undefined;

    const store = storeRef.current;

    const config: ProviderConfiguration = {
      url: collabWebsocketUrl(collabBaseUrl, orgId),
      name: pageDocumentName(pageId),
      document: new Y.Doc(),
      WebSocketPolyfill: NativeCollabSocket,
      token: () => session.accessToken().then((value) => value ?? ''),
      onStatus: ({ status: nextStatus }) => {
        setStatus(toDocPageStatus(nextStatus));
      },
      onSynced: ({ state }) => {
        setSynced(state);
      },
    };
    const created = new HocuspocusProvider(config);

    store.provider = created;
    for (const listener of store.listeners) listener();

    return () => {
      created.destroy();
      created.document.destroy();
      store.provider = null;
      for (const listener of store.listeners) listener();
    };
  }, [orgId, pageId]);

  return { doc: provider?.document ?? null, status, synced };
}
