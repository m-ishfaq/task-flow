import { describe, expect, it } from 'vitest';
import { unsafeAsId } from '@taskflow/contracts';
import { pageDocumentName, parsePageDocumentName } from './document-name.js';

describe('page document names', () => {
  const pageId = unsafeAsId<'PageId'>('0195ff10-0000-7000-8000-000000000001');

  it('round-trips a page id through its document name', () => {
    expect(parsePageDocumentName(pageDocumentName(pageId))).toBe(pageId);
  });

  it('rejects a name with no page: prefix', () => {
    expect(parsePageDocumentName('0195ff10-0000-7000-8000-000000000001')).toBeNull();
    expect(parsePageDocumentName(`space:${pageId}`)).toBeNull();
    expect(parsePageDocumentName('')).toBeNull();
  });

  it('rejects a page: prefix whose remainder is not a well-formed id', () => {
    // Otherwise an arbitrary string flows into `loadPage` as though it were a
    // uuid, which is a database error rather than a clean refusal.
    expect(parsePageDocumentName('page:not-a-uuid')).toBeNull();
    expect(parsePageDocumentName('page:')).toBeNull();
  });
});
