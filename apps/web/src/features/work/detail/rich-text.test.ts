import { describe, expect, it } from 'vitest';
import { RichTextDocument } from '@taskflow/api/richtext';
import { EMPTY_DOCUMENT, flatten, isEmptyDocument, toDocument } from './rich-text.js';

/**
 * The normalizer, checked against the REAL server schema.
 *
 * Importing `RichTextDocument` from the API rather than restating its rules is
 * the whole value of this file. A hand-written expectation would assert that the
 * normalizer does what this test's author believed the server wanted, and would
 * keep passing after the server's whitelist changed. Parsing with the actual
 * schema means a divergence fails here instead of in production, where it looks
 * like "the API rejects valid input".
 *
 * The documents below are shaped the way TipTap actually emits them, defaults
 * and all — which is the thing that does not match.
 */

describe('the attributes TipTap emits and the server refuses', () => {
  it('drops `type` from an ordered list', () => {
    /* TipTap's OrderedList declares `start` AND `type`; the server's schema is
       `.strict()` with only `start`. A document containing any numbered list
       fails validation without this. */
    const fromEditor = {
      type: 'doc',
      content: [
        {
          type: 'orderedList',
          attrs: { start: 1, type: null },
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }],
            },
          ],
        },
      ],
    };

    expect(RichTextDocument.safeParse(fromEditor).success).toBe(false);
    expect(RichTextDocument.safeParse(toDocument(fromEditor)).success).toBe(true);
  });

  it('drops `rel` and `class` from a link', () => {
    /* Not a formatting detail. The server refuses `rel` deliberately — a
       document that could set it could opt itself out of noopener — so those
       keys have to be gone before the request, not argued about after it. */
    const fromEditor = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'a link',
              marks: [
                {
                  type: 'link',
                  attrs: {
                    href: 'https://example.com',
                    target: '_blank',
                    rel: 'noopener noreferrer nofollow',
                    class: null,
                  },
                },
              ],
            },
          ],
        },
      ],
    };

    expect(RichTextDocument.safeParse(fromEditor).success).toBe(false);

    const normalized = toDocument(fromEditor);
    expect(RichTextDocument.safeParse(normalized).success).toBe(true);

    const mark = normalized.content?.[0]?.content?.[0]?.marks?.[0];
    expect(mark?.attrs).toEqual({ href: 'https://example.com', target: '_blank' });
  });

  it('drops a null language from a code block', () => {
    const fromEditor = {
      type: 'doc',
      content: [
        { type: 'codeBlock', attrs: { language: null }, content: [{ type: 'text', text: 'x' }] },
      ],
    };

    expect(RichTextDocument.safeParse(toDocument(fromEditor)).success).toBe(true);
  });

  it('keeps the attributes the server does want', () => {
    const fromEditor = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Title' }] },
      ],
    };

    const normalized = toDocument(fromEditor);
    expect(normalized.content?.[0]?.attrs).toEqual({ level: 2 });
    expect(RichTextDocument.safeParse(normalized).success).toBe(true);
  });

  it('leaves an unknown node type alone for the server to refuse', () => {
    /* Deliberate. Silently stripping it would turn a version mismatch between
       this bundle and the deployed API into a document that lost content with
       no error anywhere. */
    const fromEditor = { type: 'doc', content: [{ type: 'mermaidDiagram', attrs: { src: 'x' } }] };

    expect(toDocument(fromEditor).content?.[0]?.type).toBe('mermaidDiagram');
    expect(RichTextDocument.safeParse(toDocument(fromEditor)).success).toBe(false);
  });

  it('produces a document the server accepts for an untouched editor', () => {
    expect(RichTextDocument.safeParse(EMPTY_DOCUMENT).success).toBe(true);
  });
});

describe('emptiness', () => {
  it('treats the editor default as empty', () => {
    // TipTap never yields a truly empty doc — an empty editor is a doc with one
    // empty paragraph — so `content.length` cannot answer this.
    expect(isEmptyDocument(EMPTY_DOCUMENT)).toBe(true);
    expect(isEmptyDocument({ type: 'doc', content: [{ type: 'paragraph' }] })).toBe(true);
  });

  it('treats whitespace-only text as empty', () => {
    expect(
      isEmptyDocument({
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: '   ' }] }],
      }),
    ).toBe(true);
  });

  it('recognizes real content', () => {
    const document = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }],
    };

    expect(isEmptyDocument(document)).toBe(false);
    expect(flatten(document)).toBe('hello');
  });

  it('is not confused by a non-document', () => {
    expect(isEmptyDocument(null)).toBe(true);
    expect(isEmptyDocument('not a document')).toBe(true);
  });
});
