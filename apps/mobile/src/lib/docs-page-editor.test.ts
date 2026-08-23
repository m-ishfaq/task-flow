import { describe, expect, it } from 'vitest';
import { extractMentions, hasPageLink } from './docs-page-editor.js';

describe('hasPageLink', () => {
  it('is false for a document with no pageLink node', () => {
    expect(
      hasPageLink({
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'plain' }] }],
      }),
    ).toBe(false);
  });

  it('is true for a pageLink at the top level', () => {
    expect(
      hasPageLink({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'pageLink', attrs: { pageId: 'p1', label: 'Other Page' } }],
          },
        ],
      }),
    ).toBe(true);
  });

  it('finds a pageLink nested inside a list', () => {
    expect(
      hasPageLink({
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
                    content: [{ type: 'pageLink', attrs: { pageId: 'p1', label: 'Deep link' } }],
                  },
                ],
              },
            ],
          },
        ],
      }),
    ).toBe(true);
  });

  it('handles a malformed/empty document without throwing', () => {
    expect(hasPageLink(null)).toBe(false);
    expect(hasPageLink(undefined)).toBe(false);
    expect(hasPageLink({})).toBe(false);
    expect(hasPageLink({ type: 'doc' })).toBe(false);
  });
});

describe('extractMentions', () => {
  it('finds no mentions in a plain document', () => {
    expect(
      extractMentions({
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'plain' }] }],
      }),
    ).toEqual([]);
  });

  it('extracts a mention with its userId and label', () => {
    const result = extractMentions({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'mention', attrs: { userId: 'u1', label: 'Jane Doe' } }],
        },
      ],
    });
    expect(result).toEqual([{ userId: 'u1', label: 'Jane Doe' }]);
  });

  it('deduplicates the same person mentioned more than once', () => {
    const result = extractMentions({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'mention', attrs: { userId: 'u1', label: 'Jane Doe' } },
            { type: 'text', text: ' and again ' },
            { type: 'mention', attrs: { userId: 'u1', label: 'Jane Doe' } },
          ],
        },
      ],
    });
    expect(result).toEqual([{ userId: 'u1', label: 'Jane Doe' }]);
  });

  it('finds mentions nested inside a blockquote', () => {
    const result = extractMentions({
      type: 'doc',
      content: [
        {
          type: 'blockquote',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'mention', attrs: { userId: 'u2', label: 'Bob' } }],
            },
          ],
        },
      ],
    });
    expect(result).toEqual([{ userId: 'u2', label: 'Bob' }]);
  });
});
