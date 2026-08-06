import { PageIdSchema, type PageId } from '@taskflow/contracts';

/**
 * The Yjs document name <-> page id mapping.
 *
 * A y-websocket client names a document with a single string, which cannot
 * carry the structured `{ orgId, pageId }` shape `apps/realtime`'s
 * `JoinRequest` uses. `page:{pageId}` is the smallest thing that (a) is
 * unambiguous today and (b) leaves room for a second document TYPE later
 * (§10.4-style calendar/timeline surfaces, or a future space-level document)
 * without a breaking rename of every existing one.
 *
 * The org id travels separately, as a `requestParameters` query value — see
 * `auth.ts`. It is client-supplied and that is fine for the identical reason
 * the `x-taskflow-org` header and Phase 4's join-request board id are: it is
 * a lookup key into an authorization check, never a value trusted on its own.
 */

const PAGE_DOCUMENT_PREFIX = 'page:';

export function pageDocumentName(pageId: PageId): string {
  return `${PAGE_DOCUMENT_PREFIX}${pageId}`;
}

/** Parses a document name into a `PageId`, or `null` if it is not one. */
export function parsePageDocumentName(documentName: string): PageId | null {
  if (!documentName.startsWith(PAGE_DOCUMENT_PREFIX)) return null;

  const candidate = documentName.slice(PAGE_DOCUMENT_PREFIX.length);
  const parsed = PageIdSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}
