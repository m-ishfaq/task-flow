import { describe, expect, it, afterEach, vi } from 'vitest';
import type { OrgId, PageId } from '@taskflow/contracts';
import { collabWebsocketUrl, pageDocumentName } from './collab-url.js';

/**
 * The collab URL/document-name helpers (ai/phase-6-docs.md §3.2, Wave 2).
 *
 * `pageDocumentName` and `collabWebsocketUrl` are the two client-side halves
 * of the handshake contract `apps/collab`'s `auth.ts` enforces: the document
 * name must be exactly `page:{pageId}` (else `parsePageDocumentName` refuses
 * the connection) and the org must arrive as a `?orgId=` query value on the
 * WebSocket URL (else `authenticateConnection` throws `invalid_org`). These
 * tests pin the wire format so a rename on either side fails loudly here
 * instead of as a connection that nobody can explain.
 */

const ORG_ID = '019faee8-0000-7000-8000-0000000000f0' as OrgId;
const PAGE_ID = '019faee8-0000-7000-8000-000000000002' as PageId;

function stubLocation(protocol: string, host: string): void {
  /* jsdom's `window.location` is configurable, so a plain assignment would be
     a navigation attempt; defineProperty is the standard way to substitute a
     fake one for a test that only reads protocol/host. */
  Object.defineProperty(window, 'location', {
    value: { protocol, host },
    configurable: true,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  /* Put the real location object back so later tests in the same file (or
     other files sharing this jsdom) do not inherit the stub. */
  Object.defineProperty(window, 'location', {
    value: window.location,
    configurable: true,
  });
});

describe('pageDocumentName', () => {
  it('prefixes the page id with "page:"', () => {
    expect(pageDocumentName(PAGE_ID)).toBe(`page:${PAGE_ID}`);
  });
});

describe('collabWebsocketUrl', () => {
  it('builds a ws:// URL against the current host for an http origin', () => {
    stubLocation('http:', 'localhost:5173');
    expect(collabWebsocketUrl(ORG_ID)).toBe(`ws://localhost:5173/collab?orgId=${ORG_ID}`);
  });

  it('uses wss:// for an https origin', () => {
    stubLocation('https:', 'app.example.com');
    expect(collabWebsocketUrl(ORG_ID)).toBe(`wss://app.example.com/collab?orgId=${ORG_ID}`);
  });

  it('URL-encodes the org id', () => {
    stubLocation('http:', 'localhost:5173');
    const url = collabWebsocketUrl('org with spaces' as OrgId);
    expect(url).toContain('?orgId=org%20with%20spaces');
  });
});
