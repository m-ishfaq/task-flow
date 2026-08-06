import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { unsafeAsId, type PageId } from '@taskflow/contracts';
import { extractInternalLinks } from './backlinks.js';

/**
 * Internal-link extraction (ai/phase-6-docs.md §3.10), against plain `Y.Doc`
 * fixtures — no database, no relay. `backlinks.relay.test.ts` covers the
 * claim/rewrite/dispatch mechanics against real Postgres.
 */

const SOURCE = unsafeAsId<'PageId'>('0195ee30-0000-7000-8000-000000000001');
const TARGET_A = unsafeAsId<'PageId'>('0195ee30-0000-7000-8000-0000000000a1');
const TARGET_B = unsafeAsId<'PageId'>('0195ee30-0000-7000-8000-0000000000b1');

function pageLink(pageId: PageId, label: string): Y.XmlElement {
  const el = new Y.XmlElement('pageLink');
  el.setAttribute('pageId', pageId);
  el.setAttribute('label', label);
  return el;
}

function paragraph(...children: (Y.XmlElement | Y.XmlText)[]): Y.XmlElement {
  const el = new Y.XmlElement('paragraph');
  el.insert(0, children);
  return el;
}

describe('extractInternalLinks', () => {
  it('finds a pageLink node at the top level', () => {
    const doc = new Y.Doc();
    doc.getXmlFragment('content').insert(0, [paragraph(pageLink(TARGET_A, 'See Also'))]);

    expect(extractInternalLinks(doc.getXmlFragment('content'), SOURCE)).toEqual([TARGET_A]);
  });

  it('finds pageLink nodes nested arbitrarily deep (inside a list, inside a blockquote)', () => {
    const doc = new Y.Doc();
    const listItem = new Y.XmlElement('listItem');
    listItem.insert(0, [paragraph(pageLink(TARGET_A, 'Deep link'))]);
    const list = new Y.XmlElement('bulletList');
    list.insert(0, [listItem]);
    const quote = new Y.XmlElement('blockquote');
    quote.insert(0, [list]);
    doc.getXmlFragment('content').insert(0, [quote]);

    expect(extractInternalLinks(doc.getXmlFragment('content'), SOURCE)).toEqual([TARGET_A]);
  });

  it('deduplicates the same target linked twice', () => {
    const doc = new Y.Doc();
    doc
      .getXmlFragment('content')
      .insert(0, [
        paragraph(pageLink(TARGET_A, 'First mention')),
        paragraph(pageLink(TARGET_A, 'Second mention')),
      ]);

    expect(extractInternalLinks(doc.getXmlFragment('content'), SOURCE)).toEqual([TARGET_A]);
  });

  it('collects more than one distinct target', () => {
    const doc = new Y.Doc();
    doc
      .getXmlFragment('content')
      .insert(0, [paragraph(pageLink(TARGET_A, 'A')), paragraph(pageLink(TARGET_B, 'B'))]);

    const links = extractInternalLinks(doc.getXmlFragment('content'), SOURCE);
    expect(new Set(links)).toEqual(new Set([TARGET_A, TARGET_B]));
  });

  it('excludes a self-link', () => {
    const doc = new Y.Doc();
    doc.getXmlFragment('content').insert(0, [paragraph(pageLink(SOURCE, 'Self reference'))]);

    expect(extractInternalLinks(doc.getXmlFragment('content'), SOURCE)).toEqual([]);
  });

  it('ignores a pageLink whose pageId is not a valid id — content-guard-stripped-but-not-yet-compacted state, per §3.8', () => {
    const doc = new Y.Doc();
    const bad = new Y.XmlElement('pageLink');
    bad.setAttribute('pageId', 'not-a-uuid');
    bad.setAttribute('label', 'Bogus');
    doc.getXmlFragment('content').insert(0, [paragraph(bad)]);

    expect(extractInternalLinks(doc.getXmlFragment('content'), SOURCE)).toEqual([]);
  });

  it('returns nothing for a document with no internal links', () => {
    const doc = new Y.Doc();
    doc.getXmlFragment('content').insert(0, [paragraph(new Y.XmlText('Just ordinary text.'))]);

    expect(extractInternalLinks(doc.getXmlFragment('content'), SOURCE)).toEqual([]);
  });
});
