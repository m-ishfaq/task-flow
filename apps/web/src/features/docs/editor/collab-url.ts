import type { OrgId, PageId } from '@taskflow/contracts';

/**
 * The Yjs document name for a page, mirroring
 * `apps/collab/src/document-name.ts`'s `pageDocumentName` exactly — the two
 * must agree on the wire format, so this is a restatement of that file's
 * contract on the client side rather than a shared import (`apps/collab` is
 * a server package apps/web has no dependency path to).
 */
export function pageDocumentName(pageId: PageId): string {
  return `page:${pageId}`;
}

/**
 * The same-origin `/collab` WebSocket URL for a page (ai/phase-6-docs.md
 * §3.2, §3.3).
 *
 * Same-origin for the identical reason `lib/socket.ts` connects to
 * `/socket.io` rather than `apps/realtime`'s own origin: `apps/collab`'s
 * `onAuthenticate` checks the connection's `Origin` header against
 * `WEB_ORIGIN` (`auth.ts`'s `originAllowed`), and keeping the browser and
 * the gateway on one origin in development (via `vite.config.ts`'s
 * `/collab` proxy) is what makes that check see the same thing it sees in
 * production, rather than something that only happens to pass locally.
 *
 * The org id travels as a `?orgId=` query parameter, read server-side as
 * `requestParameters.get('orgId')` (`document-name.ts`'s own header) — it is
 * a lookup key into `authorizeConnect`'s authorization check, never trusted
 * on its own, the identical convention the `x-taskflow-org` HTTP header and
 * Phase 4's join-request board id already use.
 */
export function collabWebsocketUrl(orgId: OrgId): string {
  const isSecureContext = window.location.protocol === 'https:';
  const scheme = isSecureContext ? 'wss:' : 'ws:';
  return `${scheme}//${window.location.host}/collab?orgId=${encodeURIComponent(orgId)}`;
}
