import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { renderFragment, renderState } from './render.js';

/**
 * The Yjs -> JSON converter (Wave 4, §3.9) that both `public.ts` and
 * `pdf.ts` render through, against plain `Y.Doc` fixtures — no database.
 * `render.ts`'s own header explains why this re-validates the whitelist
 * rather than trusting `apps/collab`'s save-boundary pass to have already
 * run; these tests are what prove that re-validation actually strips what
 * it claims to.
 */

function fragment(): { doc: Y.Doc; fragment: Y.XmlFragment } {
  const doc = new Y.Doc();
  return { doc, fragment: doc.getXmlFragment('content') };
}

describe('renderFragment', () => {
  it('renders a paragraph with plain text', () => {
    const { fragment: root } = fragment();
    const paragraph = new Y.XmlElement('paragraph');
    paragraph.insert(0, [new Y.XmlText('hello world')]);
    root.insert(0, [paragraph]);

    expect(renderFragment(root)).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello world' }] }],
    });
  });

  it('renders a heading with its level attribute', () => {
    const { fragment: root } = fragment();
    const heading = new Y.XmlElement('heading');
    // `setAttribute`'s default generic types values as `string`, but Yjs
    // stores whatever is handed to it — see content-guard.test.ts's
    // identical note; this module reads real (numeric) TipTap attrs.
    heading.setAttribute('level', 2 as unknown as string);
    heading.insert(0, [new Y.XmlText('Title')]);
    root.insert(0, [heading]);

    expect(renderFragment(root)).toEqual({
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Title' }] },
      ],
    });
  });

  it('renders bold text with a mark', () => {
    const { doc, fragment: root } = fragment();
    const paragraph = new Y.XmlElement('paragraph');
    root.insert(0, [paragraph]);
    doc.transact(() => {
      const text = new Y.XmlText();
      paragraph.insert(0, [text]);
      text.insert(0, 'strong', { bold: {} });
    });

    const rendered = renderFragment(root);
    expect(rendered.content?.[0]?.content?.[0]).toEqual({
      type: 'text',
      text: 'strong',
      marks: [{ type: 'bold' }],
    });
  });

  it('drops an unknown node type entirely, rather than rendering it as anything', () => {
    const { fragment: root } = fragment();
    const bogus = new Y.XmlElement('script');
    bogus.insert(0, [new Y.XmlText('alert(1)')]);
    root.insert(0, [bogus]);

    expect(renderFragment(root)).toEqual({ type: 'doc', content: [] });
  });

  it('drops a pageLink node with invalid attributes, rather than rendering a broken reference', () => {
    const { fragment: root } = fragment();
    const bad = new Y.XmlElement('pageLink');
    bad.setAttribute('pageId', 'not-a-uuid');
    // No `label` at all — fails the required-field schema too.
    root.insert(0, [bad]);

    expect(renderFragment(root)).toEqual({ type: 'doc', content: [] });
  });

  it('renders a valid pageLink node with its attributes intact', () => {
    const { fragment: root } = fragment();
    const link = new Y.XmlElement('pageLink');
    link.setAttribute('pageId', '0195ee30-0000-7000-8000-000000000001');
    link.setAttribute('label', 'See also');
    root.insert(0, [link]);

    expect(renderFragment(root)).toEqual({
      type: 'doc',
      content: [
        {
          type: 'pageLink',
          attrs: { pageId: '0195ee30-0000-7000-8000-000000000001', label: 'See also' },
        },
      ],
    });
  });

  it('strips a disallowed mark (e.g. a stale/invalid one) from a text run without dropping the text', () => {
    const { doc, fragment: root } = fragment();
    const paragraph = new Y.XmlElement('paragraph');
    root.insert(0, [paragraph]);
    doc.transact(() => {
      const text = new Y.XmlText();
      paragraph.insert(0, [text]);
      // 'javascript:' is not a valid href under SafeUrl — the exact case
      // render.ts's own header names as the reason this file re-validates.
      text.insert(0, 'click me', { link: { href: 'javascript:alert(1)' } });
    });

    const rendered = renderFragment(root);
    expect(rendered.content?.[0]?.content?.[0]).toEqual({ type: 'text', text: 'click me' });
  });

  it('renders nested lists', () => {
    const { fragment: root } = fragment();
    const item = new Y.XmlElement('listItem');
    const paragraph = new Y.XmlElement('paragraph');
    paragraph.insert(0, [new Y.XmlText('one')]);
    item.insert(0, [paragraph]);
    const list = new Y.XmlElement('bulletList');
    list.insert(0, [item]);
    root.insert(0, [list]);

    expect(renderFragment(root)).toEqual({
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }],
            },
          ],
        },
      ],
    });
  });
});

describe('renderState', () => {
  it('decodes an encoded Yjs state and renders it, without mutating anything shared', () => {
    const doc = new Y.Doc();
    const paragraph = new Y.XmlElement('paragraph');
    paragraph.insert(0, [new Y.XmlText('encoded')]);
    doc.getXmlFragment('content').insert(0, [paragraph]);
    const state = Y.encodeStateAsUpdate(doc);

    expect(renderState(state)).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'encoded' }] }],
    });
  });

  it('renders an empty state as an empty document, not an error', () => {
    const doc = new Y.Doc();
    const state = Y.encodeStateAsUpdate(doc);
    expect(renderState(state)).toEqual({ type: 'doc', content: [] });
  });
});
