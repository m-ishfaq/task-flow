import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { decodeBase64 } from './base64.js';
import {
  collabWebsocketUrl,
  pageDocumentName,
  pageStartAnchor,
  yjsFragmentToRichTextDocument,
} from './docs-collab.js';

/**
 * `yjsFragmentToRichTextDocument` is tested against REAL Yjs structures,
 * built with Yjs's own mutation API rather than a hand-rolled fixture —
 * `yjs` is pure JS with no DOM/native dependency, so what it produces here
 * is the same CRDT data structure a real synced document holds, not a
 * stand-in for one. What this cannot prove is that TipTap's live Yjs
 * binding shapes content exactly this way — see `docs-collab.ts`'s own
 * header for that boundary.
 */

function docWithContent(): { readonly doc: Y.Doc; readonly content: Y.XmlFragment } {
  const doc = new Y.Doc();
  return { doc, content: doc.getXmlFragment('content') };
}

describe('pageDocumentName', () => {
  it('matches the wire format apps/collab and apps/web both use', () => {
    expect(pageDocumentName('0195ff00-0000-7000-8000-000000000001')).toBe(
      'page:0195ff00-0000-7000-8000-000000000001',
    );
  });
});

describe('collabWebsocketUrl', () => {
  it('upgrades http to ws', () => {
    expect(collabWebsocketUrl('http://10.0.2.2:3002', 'org-1')).toBe(
      'ws://10.0.2.2:3002/collab?orgId=org-1',
    );
  });

  it('upgrades https to wss', () => {
    expect(collabWebsocketUrl('https://api.example.com', 'org-1')).toBe(
      'wss://api.example.com/collab?orgId=org-1',
    );
  });

  it('percent-encodes the org id', () => {
    expect(collabWebsocketUrl('http://localhost:3002', 'org id/1')).toBe(
      'ws://localhost:3002/collab?orgId=org%20id%2F1',
    );
  });
});

describe('yjsFragmentToRichTextDocument', () => {
  it('converts an empty fragment to an empty doc', () => {
    const { content } = docWithContent();
    expect(yjsFragmentToRichTextDocument(content)).toEqual({ type: 'doc', content: [] });
  });

  it('converts a plain paragraph of unformatted text', () => {
    const { content } = docWithContent();
    const paragraph = new Y.XmlElement('paragraph');
    content.insert(0, [paragraph]);
    const text = new Y.XmlText();
    paragraph.insert(0, [text]);
    text.insert(0, 'Hello world');

    expect(yjsFragmentToRichTextDocument(content)).toEqual({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Hello world' }],
        },
      ],
    });
  });

  it('converts a boolean mark (bold) to a mark with no attrs', () => {
    const { content } = docWithContent();
    const paragraph = new Y.XmlElement('paragraph');
    content.insert(0, [paragraph]);
    const text = new Y.XmlText();
    paragraph.insert(0, [text]);
    text.insert(0, 'bold text', { bold: true });

    const result = yjsFragmentToRichTextDocument(content) as {
      content: readonly { content: readonly { marks?: readonly { type: string }[] }[] }[];
    };
    expect(result.content[0]?.content[0]?.marks).toEqual([{ type: 'bold' }]);
  });

  it('converts an attributed mark (link) with its attrs preserved', () => {
    const { content } = docWithContent();
    const paragraph = new Y.XmlElement('paragraph');
    content.insert(0, [paragraph]);
    const text = new Y.XmlText();
    paragraph.insert(0, [text]);
    text.insert(0, 'a link', { link: { href: 'https://example.com', target: '_blank' } });

    const result = yjsFragmentToRichTextDocument(content) as {
      content: readonly {
        content: readonly {
          marks?: readonly { type: string; attrs?: Record<string, unknown> }[];
        }[];
      }[];
    };
    expect(result.content[0]?.content[0]?.marks).toEqual([
      { type: 'link', attrs: { href: 'https://example.com', target: '_blank' } },
    ]);
  });

  it('preserves a block node’s own attrs (heading level)', () => {
    const { content } = docWithContent();
    const heading = new Y.XmlElement('heading');
    // y-prosemirror stores heading level as a real number at runtime; Yjs's
    // own `YXmlElement` type just defaults an attribute's value type to
    // `string` when no generic is given (and a generic here would make this
    // element incompatible with `XmlFragment.insert`'s own default-typed
    // signature below), so the cast states the real, intentional shape.
    heading.setAttribute('level', 2 as unknown as string);
    content.insert(0, [heading]);
    const text = new Y.XmlText();
    heading.insert(0, [text]);
    text.insert(0, 'A heading');

    const result = yjsFragmentToRichTextDocument(content) as {
      content: readonly { attrs?: Record<string, unknown> }[];
    };
    expect(result.content[0]?.attrs).toEqual({ level: 2 });
  });

  it('nests a bulletList > listItem > paragraph correctly', () => {
    const { content } = docWithContent();
    const list = new Y.XmlElement('bulletList');
    content.insert(0, [list]);
    const item = new Y.XmlElement('listItem');
    list.insert(0, [item]);
    const paragraph = new Y.XmlElement('paragraph');
    item.insert(0, [paragraph]);
    const text = new Y.XmlText();
    paragraph.insert(0, [text]);
    text.insert(0, 'one item');

    expect(yjsFragmentToRichTextDocument(content)).toEqual({
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                {
                  type: 'paragraph',
                  content: [{ type: 'text', text: 'one item' }],
                },
              ],
            },
          ],
        },
      ],
    });
  });

  it('converts an atomic inline node (mention) with its attrs, no content', () => {
    const { content } = docWithContent();
    const paragraph = new Y.XmlElement('paragraph');
    content.insert(0, [paragraph]);
    const mention = new Y.XmlElement('mention');
    mention.setAttribute('userId', 'u1');
    mention.setAttribute('label', 'Jane Doe');
    paragraph.insert(0, [mention]);

    expect(yjsFragmentToRichTextDocument(content)).toEqual({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'mention', attrs: { userId: 'u1', label: 'Jane Doe' } }],
        },
      ],
    });
  });

  it('skips an empty text run rather than emitting a zero-length text node', () => {
    const { content } = docWithContent();
    const paragraph = new Y.XmlElement('paragraph');
    content.insert(0, [paragraph]);
    // No text child at all — an empty paragraph, the same shape a
    // freshly-created but never-typed-into block would have.

    expect(yjsFragmentToRichTextDocument(content)).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph' }],
    });
  });
});

describe('pageStartAnchor', () => {
  it('produces a wire anchor apps/api/src/docs/anchor.ts would decode as valid', () => {
    const { content } = docWithContent();
    const { anchorFrom, anchorTo } = pageStartAnchor(content);

    // Mirrors decodeAnchor's own two steps exactly: base64 decode, then
    // Y.decodeRelativePosition — the server never asks for more than this
    // to accept an anchor, per that file's own header.
    expect(() => Y.decodeRelativePosition(decodeBase64(anchorFrom))).not.toThrow();
    expect(() => Y.decodeRelativePosition(decodeBase64(anchorTo))).not.toThrow();
  });

  it('is collapsed — anchorFrom and anchorTo are identical', () => {
    const { content } = docWithContent();
    const { anchorFrom, anchorTo } = pageStartAnchor(content);
    expect(anchorFrom).toBe(anchorTo);
  });

  it('resolves back to the start of the fragment via real Yjs, content or not', () => {
    const { doc, content } = docWithContent();
    const paragraph = new Y.XmlElement('paragraph');
    content.insert(0, [paragraph]);

    const { anchorFrom } = pageStartAnchor(content);
    const relative = Y.decodeRelativePosition(decodeBase64(anchorFrom));
    const absolute = Y.createAbsolutePositionFromRelativePosition(relative, doc);

    expect(absolute).not.toBeNull();
    expect(absolute?.type).toBe(content);
    expect(absolute?.index).toBe(0);
  });
});
