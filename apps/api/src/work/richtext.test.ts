import { describe, expect, it } from 'vitest';
import { RichTextDocument, flattenToText, type RichTextNode } from './richtext.js';

/**
 * The rich text boundary (CLAUDE.md rule 4, PLAN.md §8.7).
 *
 * "Rich text is TipTap JSON, never HTML" removes the obvious XSS by removing
 * the markup column. These tests are about the SECOND one: TipTap renders a
 * node by looking its type up in an extension map, and several standard
 * extensions turn an attribute into a URL or a DOM attribute. `javascript:` in
 * a link href is script execution reached entirely through valid JSON, and it
 * is invisible to any check that only asks "is this a well-formed document?".
 */

const paragraph = (text: string): RichTextNode => ({
  type: 'paragraph',
  content: [{ type: 'text', text }],
});

const doc = (...content: RichTextNode[]): unknown => ({ type: 'doc', content });

describe('accepting what the editor produces', () => {
  it('accepts a plain document', () => {
    expect(RichTextDocument.safeParse(doc(paragraph('Hello'))).success).toBe(true);
  });

  it('accepts an empty document', () => {
    expect(RichTextDocument.safeParse({ type: 'doc', content: [] }).success).toBe(true);
  });

  it('accepts the marks the editor offers', () => {
    const marked = doc({
      type: 'paragraph',
      content: [
        { type: 'text', text: 'bold', marks: [{ type: 'bold' }] },
        { type: 'text', text: 'code', marks: [{ type: 'code' }] },
        {
          type: 'text',
          text: 'link',
          marks: [{ type: 'link', attrs: { href: 'https://example.com/x?y=1' } }],
        },
      ],
    });

    expect(RichTextDocument.safeParse(marked).success).toBe(true);
  });

  it('accepts nested lists and headings with valid attributes', () => {
    const nested = doc(
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Plan' }] },
      {
        type: 'bulletList',
        content: [{ type: 'listItem', content: [paragraph('one')] }],
      },
      {
        type: 'taskList',
        content: [{ type: 'taskItem', attrs: { checked: true }, content: [paragraph('done')] }],
      },
    );

    expect(RichTextDocument.safeParse(nested).success).toBe(true);
  });
});

describe('mentions', () => {
  const UUID = '019fcd9b-92da-7217-82b0-022420254a31';

  const mentioning = (attrs: unknown): unknown =>
    doc({
      type: 'paragraph',
      content: [
        { type: 'text', text: 'hey ' },
        { type: 'mention', attrs },
        { type: 'text', text: '!' },
      ],
    });

  it('accepts a well-formed mention', () => {
    expect(
      RichTextDocument.safeParse(mentioning({ userId: UUID, label: 'Jane Doe' })).success,
    ).toBe(true);
  });

  it('rejects a userId that is not a UUID', () => {
    expect(
      RichTextDocument.safeParse(mentioning({ userId: 'not-a-uuid', label: 'Jane Doe' })).success,
    ).toBe(false);
  });

  it('rejects an empty label', () => {
    expect(RichTextDocument.safeParse(mentioning({ userId: UUID, label: '' })).success).toBe(false);
  });

  it('rejects an unlisted attribute, same as every other node', () => {
    expect(
      RichTextDocument.safeParse(mentioning({ userId: UUID, label: 'Jane Doe', href: 'x' }))
        .success,
    ).toBe(false);
  });

  it('flattens to "@label", not the id', () => {
    const flattened = flattenToText({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'hey ' },
            { type: 'mention', attrs: { userId: UUID, label: 'Jane Doe' } },
            { type: 'text', text: ', take a look' },
          ],
        },
      ],
    });

    expect(flattened).toBe('hey @Jane Doe, take a look');
    expect(flattened).not.toContain(UUID);
  });
});

describe('link hrefs — the reason this file exists', () => {
  const withHref = (href: string): unknown =>
    doc({
      type: 'paragraph',
      content: [{ type: 'text', text: 'click', marks: [{ type: 'link', attrs: { href } }] }],
    });

  it.each([
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    '  javascript:alert(1)',
    'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
  ])('rejects %s', (href) => {
    expect(RichTextDocument.safeParse(withHref(href)).success).toBe(false);
  });

  it.each(['https://example.com', 'http://example.com/a/b', 'mailto:someone@example.com'])(
    'accepts %s',
    (href) => {
      expect(RichTextDocument.safeParse(withHref(href)).success).toBe(true);
    },
  );

  it('rejects a link that tries to set its own rel or class', () => {
    const sneaky = doc({
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: 'click',
          marks: [
            { type: 'link', attrs: { href: 'https://example.com', rel: 'opener', class: 'x' } },
          ],
        },
      ],
    });

    // A document that could set `rel` could opt itself out of noopener.
    expect(RichTextDocument.safeParse(sneaky).success).toBe(false);
  });
});

describe('the closed lists', () => {
  it('rejects an unknown node type rather than dropping it', () => {
    /* Not sanitized into an empty paragraph: a client sending this is either a
       version this build cannot render or someone probing what the parser
       accepts, and quietly accepting either stores a document whose meaning
       depends on which renderer opens it. */
    expect(RichTextDocument.safeParse(doc({ type: 'image', attrs: { src: 'x' } })).success).toBe(
      false,
    );
    expect(RichTextDocument.safeParse(doc({ type: 'iframe' })).success).toBe(false);
  });

  it('rejects an unknown mark type', () => {
    const marked = doc({
      type: 'paragraph',
      content: [{ type: 'text', text: 'x', marks: [{ type: 'onclick' }] }],
    });

    expect(RichTextDocument.safeParse(marked).success).toBe(false);
  });

  it('rejects unknown attributes on a known node', () => {
    const sneaky = doc({
      type: 'paragraph',
      attrs: { style: 'position:fixed;top:0' },
      content: [{ type: 'text', text: 'x' }],
    });

    expect(RichTextDocument.safeParse(sneaky).success).toBe(false);
  });

  it('rejects an out-of-range heading level', () => {
    expect(RichTextDocument.safeParse(doc({ type: 'heading', attrs: { level: 9 } })).success).toBe(
      false,
    );
  });

  it('requires the root to be a doc', () => {
    expect(RichTextDocument.safeParse(paragraph('orphan')).success).toBe(false);
  });

  it('rejects text on a non-text node, and a text node with no text', () => {
    expect(RichTextDocument.safeParse(doc({ type: 'paragraph', text: 'smuggled' })).success).toBe(
      false,
    );
    expect(RichTextDocument.safeParse(doc({ type: 'text' })).success).toBe(false);
  });
});

describe('resource limits', () => {
  it('rejects a document nested past the depth limit', () => {
    // Built iteratively — a recursive builder would hit the same stack limit
    // the schema exists to defend, in the test rather than the parser.
    let node: RichTextNode = paragraph('deep');
    for (let level = 0; level < 60; level += 1) {
      node = { type: 'blockquote', content: [node] };
    }

    expect(RichTextDocument.safeParse(doc(node)).success).toBe(false);
  });

  it('rejects a document wider than the node budget', () => {
    const wide = Array.from({ length: 12_000 }, () => paragraph('x'));
    expect(RichTextDocument.safeParse(doc(...wide)).success).toBe(false);
  });

  it('accepts a large but reasonable document', () => {
    const ordinary = Array.from({ length: 200 }, (_, index) => paragraph(`line ${String(index)}`));
    expect(RichTextDocument.safeParse(doc(...ordinary)).success).toBe(true);
  });
});

describe('flattenToText', () => {
  it('separates block nodes so two paragraphs do not merge into one word', () => {
    const flattened = flattenToText({
      type: 'doc',
      content: [paragraph('Ship the thing'), paragraph('Then tell everyone')],
    });

    // 'thingThen' would be a word nobody wrote, and the search index would
    // match on it.
    expect(flattened).toBe('Ship the thing\nThen tell everyone');
  });

  it('keeps the text of nested and marked nodes', () => {
    const flattened = flattenToText({
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            { type: 'listItem', content: [paragraph('alpha')] },
            { type: 'listItem', content: [paragraph('beta')] },
          ],
        },
      ],
    });

    expect(flattened).toContain('alpha');
    expect(flattened).toContain('beta');
  });

  it('returns an empty string for an empty document', () => {
    expect(flattenToText({ type: 'doc', content: [] })).toBe('');
  });
});
