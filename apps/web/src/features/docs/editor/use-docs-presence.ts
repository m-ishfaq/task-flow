import { useEffect, useState } from 'react';
import type { HocuspocusProvider } from '@hocuspocus/provider';

/**
 * Who else is here — live presence from the shared awareness map.
 *
 * CollaborationCaret publishes `{ name, color, userId }` under each client's
 * awareness state, so everyone connected to the same page is visible here —
 * the same Yjs awareness channel the caret labels ride on. Cheap (an event
 * subscription, no polling).
 *
 * Deduplicated by `userId`, not by connection: the same person open in two
 * tabs is two awareness entries but one person. A viewer with no resolvable
 * identity falls back to `client:<clientId>`.
 *
 * A HOOK, not a component — `docs-page.tsx`'s `PagePanel` uses this to build
 * both the "N people here now" text and the avatar discs from the same data.
 * `provider` is nullable because `PagePanel` only has one once `DocsEditor`'s
 * `onReady` has fired.
 */
export function useDocsPresence(
  provider: HocuspocusProvider | null,
): readonly { readonly userId: string; readonly label: string }[] {
  const [others, setOthers] = useState<
    readonly { readonly userId: string; readonly label: string }[]
  >([]);

  useEffect(() => {
    if (provider === null) return;
    const awareness = provider.awareness;
    if (awareness === null) return;

    const update = () => {
      const local = awareness.clientID;
      const byKey = new Map<string, string>();
      for (const [clientId, state] of awareness.getStates()) {
        if (clientId === local) continue;
        const user = state['user'] as Record<string, unknown> | undefined;
        const name = typeof user?.['name'] === 'string' ? user['name'] : 'Someone';
        const key =
          typeof user?.['userId'] === 'string' ? user['userId'] : `client:${String(clientId)}`;
        byKey.set(key, name);
      }
      setOthers([...byKey.entries()].map(([userId, label]) => ({ userId, label })));
    };

    awareness.on('change', update);
    update();
    return () => {
      awareness.off('change', update);
    };
  }, [provider]);

  return others;
}
