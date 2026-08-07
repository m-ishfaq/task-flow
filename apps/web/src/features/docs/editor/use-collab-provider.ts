import { useEffect, useState } from 'react';
import { HocuspocusProvider, type WebSocketStatus } from '@hocuspocus/provider';
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
 * `provider` is `null` for the one render between mount and the effect
 * below running — genuinely, not papered over with a cast — because the
 * `Y.Doc`/provider pair has to be constructed as an effect (it opens a
 * WebSocket, a side effect) rather than during render. `docs-editor.tsx`
 * renders a connecting state for that render instead of assuming a
 * provider always exists.
 */

export type CollabStatus = 'connecting' | 'connected' | 'disconnected';

export interface CollabConnection {
  readonly provider: HocuspocusProvider | null;
  readonly status: CollabStatus;
  readonly synced: boolean;
}

function toCollabStatus(status: WebSocketStatus): CollabStatus {
  switch (status) {
    case 'connected':
      return 'connected';
    case 'connecting':
      return 'connecting';
    case 'disconnected':
      return 'disconnected';
    default:
      return 'disconnected';
  }
}

export function useCollabProvider(orgId: OrgId, pageId: PageId): CollabConnection {
  const [status, setStatus] = useState<CollabStatus>('connecting');
  const [synced, setSynced] = useState(false);
  const [provider, setProvider] = useState<HocuspocusProvider | null>(null);

  useEffect(() => {
    setStatus('connecting');
    setSynced(false);

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

    setProvider(created);

    return () => {
      created.destroy();
      created.document.destroy();
      setProvider(null);
    };
  }, [orgId, pageId]);

  return { provider, status, synced };
}
