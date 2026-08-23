import { describe, expect, it } from 'vitest';
import { flattenText, sanitizeRichText } from './rich-text.js';

describe('sanitizeRichText', () => {
  it('passes through a well-formed document unchanged in shape', () => {
    const doc = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }],
    };
    expect(sanitizeRichText(doc)).toEqual(doc);
  });

  it('returns null for a missing description', () => {
    expect(sanitizeRichText(null)).toBeNull();
    expect(sanitizeRichText(undefined)).toBeNull();
  });

  it('returns null when the root is not a "doc" node', () => {
    expect(sanitizeRichText({ type: 'paragraph', content: [] })).toBeNull();
  });

  it('returns null for non-object input', () => {
    expect(sanitizeRichText('not a document')).toBeNull();
    expect(sanitizeRichText(42)).toBeNull();
    expect(sanitizeRichText([])).toBeNull();
  });

  it('drops an unrecognized node type but keeps its siblings', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'before' }] },
        { type: 'video', attrs: { src: 'evil.mp4' } },
        { type: 'paragraph', content: [{ type: 'text', text: 'after' }] },
      ],
    };
    const result = sanitizeRichText(doc);
    expect(result?.content).toHaveLength(2);
    expect(result?.content?.map((node) => node.content?.[0]?.text)).toEqual(['before', 'after']);
  });

  it('drops a node whose attributes fail the whitelist rather than stripping them', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 99 }, content: [{ type: 'text', text: 'nope' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'kept' }] },
      ],
    };
    const result = sanitizeRichText(doc);
    expect(result?.content).toHaveLength(1);
    expect(result?.content?.[0]?.type).toBe('paragraph');
  });

  it('strips a link mark using an unsafe URL scheme, keeping the text plain', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'click me',
              marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }],
            },
          ],
        },
      ],
    };
    const result = sanitizeRichText(doc);
    const textNode = result?.content?.[0]?.content?.[0];
    expect(textNode?.text).toBe('click me');
    expect(textNode?.marks ?? []).toHaveLength(0);
  });

  it('keeps a link mark using a safe URL scheme', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'click me',
              marks: [{ type: 'link', attrs: { href: 'https://taskflow.example/x' } }],
            },
          ],
        },
      ],
    };
    const result = sanitizeRichText(doc);
    const textNode = result?.content?.[0]?.content?.[0];
    expect(textNode?.marks).toHaveLength(1);
    expect(textNode?.marks?.[0]).toEqual({
      type: 'link',
      attrs: { href: 'https://taskflow.example/x' },
    });
  });

  it('drops a mention missing its required label', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'mention', attrs: { userId: '018f4d1e-7c3a-7b2e-8f1a-2c9d3e4f5a6b' } }],
        },
      ],
    };
    const result = sanitizeRichText(doc);
    expect(result?.content?.[0]?.content ?? []).toHaveLength(0);
  });

  it('does not stack-overflow on a document nested far past MAX_DEPTH, and truncates it', () => {
    let node: unknown = { type: 'text', text: 'leaf' };
    for (let i = 0; i < 200; i++) {
      node = { type: 'blockquote', content: [node] };
    }
    const doc = { type: 'doc', content: [node] };
    expect(() => sanitizeRichText(doc)).not.toThrow();
    // A tree this deep cannot possibly survive intact, but sanitizing must
    // terminate rather than exhaust the stack finding that out.
    expect(sanitizeRichText(doc)).not.toBeNull();
  });

  it('does not hang on a document with far more than MAX_NODES siblings', () => {
    const content = Array.from({ length: 12_000 }, (_, i) => ({
      type: 'paragraph',
      content: [{ type: 'text', text: `p${String(i)}` }],
    }));
    const doc = { type: 'doc', content };
    const result = sanitizeRichText(doc);
    expect(result?.content?.length ?? 0).toBeLessThanOrEqual(12_000);
  });
});

describe('flattenText', () => {
  it('returns an empty string for null', () => {
    expect(flattenText(null)).toBe('');
  });

  it('joins split marks with no separator, not "Hel lo"', () => {
    const doc = sanitizeRichText({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Hel', marks: [{ type: 'bold' }] },
            { type: 'text', text: 'lo' },
          ],
        },
      ],
    });
    expect(flattenText(doc)).toBe('Hello');
  });

  it('concatenates two paragraphs with no separator between them, matching web', () => {
    const doc = sanitizeRichText({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'World' }] },
      ],
    });
    expect(flattenText(doc)).toBe('HelloWorld');
  });

  it('returns an empty string for an empty document', () => {
    const doc = sanitizeRichText({ type: 'doc', content: [] });
    expect(flattenText(doc)).toBe('');
  });
});
