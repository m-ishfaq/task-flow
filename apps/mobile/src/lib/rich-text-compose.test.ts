import { describe, expect, it } from 'vitest';
import { liveFormatParser, parseFormattedText } from './rich-text-compose.js';

describe('parseFormattedText — plain text', () => {
  it('with no formatting, produces a single paragraph with one text run', () => {
    expect(parseFormattedText('hello world')).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello world' }] }],
    });
  });

  it('an empty draft still produces one paragraph, never zero blocks', () => {
    expect(parseFormattedText('')).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: '' }] }],
    });
  });

  it('each newline-separated line becomes its own paragraph', () => {
    expect(parseFormattedText('first\nsecond')).toEqual({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'first' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'second' }] },
      ],
    });
  });
});

describe('parseFormattedText — bold', () => {
  it('wraps a **bold** span in a bold mark, keeping text on both sides', () => {
    const doc = parseFormattedText('hey **Jane** can you look');
    expect(doc.content[0]).toEqual({
      type: 'paragraph',
      content: [
        { type: 'text', text: 'hey ' },
        { type: 'text', text: 'Jane', marks: [{ type: 'bold' }] },
        { type: 'text', text: ' can you look' },
      ],
    });
  });

  it('handles two separate bold spans on one line', () => {
    const doc = parseFormattedText('**a** and **b**');
    expect(doc.content[0]).toEqual({
      type: 'paragraph',
      content: [
        { type: 'text', text: 'a', marks: [{ type: 'bold' }] },
        { type: 'text', text: ' and ' },
        { type: 'text', text: 'b', marks: [{ type: 'bold' }] },
      ],
    });
  });

  it('a message that is ONLY bold has no leading/trailing empty text run', () => {
    expect(parseFormattedText('**bold**').content[0]).toEqual({
      type: 'paragraph',
      content: [{ type: 'text', text: 'bold', marks: [{ type: 'bold' }] }],
    });
  });
});

describe('parseFormattedText — links', () => {
  it('turns [text](url) into a link mark for an https URL', () => {
    const doc = parseFormattedText('see [the docs](https://example.com/x) please');
    expect(doc.content[0]).toEqual({
      type: 'paragraph',
      content: [
        { type: 'text', text: 'see ' },
        {
          type: 'text',
          text: 'the docs',
          marks: [{ type: 'link', attrs: { href: 'https://example.com/x' } }],
        },
        { type: 'text', text: ' please' },
      ],
    });
  });

  it('accepts mailto: links too', () => {
    const doc = parseFormattedText('[email me](mailto:a@example.com)');
    expect(doc.content[0]).toEqual({
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: 'email me',
          marks: [{ type: 'link', attrs: { href: 'mailto:a@example.com' } }],
        },
      ],
    });
  });

  it('leaves an unsafe-scheme link as literal text — never converted, never sent to the server to be refused', () => {
    const doc = parseFormattedText('[click](javascript:alert(1))');
    expect(doc.content[0]).toEqual({
      type: 'paragraph',
      content: [{ type: 'text', text: '[click](javascript:alert(1))' }],
    });
  });
});

describe('parseFormattedText — lists', () => {
  it('groups consecutive "- " lines into one bulletList', () => {
    const doc = parseFormattedText('- first\n- second\n- third');
    expect(doc.content).toEqual([
      {
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'first' }] }],
          },
          {
            type: 'listItem',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'second' }] }],
          },
          {
            type: 'listItem',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'third' }] }],
          },
        ],
      },
    ]);
  });

  it('accepts "* " as a bullet marker too', () => {
    const doc = parseFormattedText('* one\n* two');
    expect(doc.content[0]?.type).toBe('bulletList');
  });

  it('groups consecutive "N. " lines into one orderedList, ignoring the actual numbers typed', () => {
    const doc = parseFormattedText('1. first\n2. second');
    expect(doc.content).toEqual([
      {
        type: 'orderedList',
        content: [
          {
            type: 'listItem',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'first' }] }],
          },
          {
            type: 'listItem',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'second' }] }],
          },
        ],
      },
    ]);
  });

  it('a non-list line ends the list run — a paragraph follows, not a third item', () => {
    const doc = parseFormattedText('- first\n- second\nplain line');
    expect(doc.content).toEqual([
      {
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'first' }] }],
          },
          {
            type: 'listItem',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'second' }] }],
          },
        ],
      },
      { type: 'paragraph', content: [{ type: 'text', text: 'plain line' }] },
    ]);
  });

  it('a bullet run and an ordered run stay separate lists, not one merged list', () => {
    const doc = parseFormattedText('- bullet\n1. ordered');
    expect(doc.content.map((block) => block.type)).toEqual(['bulletList', 'orderedList']);
  });

  it('list item text is still parsed for bold and links', () => {
    const doc = parseFormattedText('- **important** thing');
    expect(doc.content[0]).toEqual({
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [
            {
              type: 'paragraph',
              content: [
                { type: 'text', text: 'important', marks: [{ type: 'bold' }] },
                { type: 'text', text: ' thing' },
              ],
            },
          ],
        },
      ],
    });
  });
});

describe('parseFormattedText — mentions', () => {
  it('replaces a marker in the middle with a mention node, keeping text on both sides', () => {
    const doc = parseFormattedText('hey @Jane Doe can you look at this', [
      { userId: 'u1', label: 'Jane Doe' },
    ]);
    expect(doc.content[0]).toEqual({
      type: 'paragraph',
      content: [
        { type: 'text', text: 'hey ' },
        { type: 'mention', attrs: { userId: 'u1', label: 'Jane Doe' } },
        { type: 'text', text: ' can you look at this' },
      ],
    });
  });

  it('a pending mention whose marker text no longer appears verbatim degrades to plain text', () => {
    const doc = parseFormattedText('hey @Jane', [{ userId: 'u1', label: 'Jane Doe' }]);
    expect(doc.content[0]).toEqual({
      type: 'paragraph',
      content: [{ type: 'text', text: 'hey @Jane' }],
    });
  });

  it('mentions, bold, and links can all appear on the same line, resolved left-to-right', () => {
    const doc = parseFormattedText('hey @Jane Doe **please** see [this](https://example.com)', [
      { userId: 'u1', label: 'Jane Doe' },
    ]);
    expect(doc.content[0]).toEqual({
      type: 'paragraph',
      content: [
        { type: 'text', text: 'hey ' },
        { type: 'mention', attrs: { userId: 'u1', label: 'Jane Doe' } },
        { type: 'text', text: ' ' },
        { type: 'text', text: 'please', marks: [{ type: 'bold' }] },
        { type: 'text', text: ' see ' },
        {
          type: 'text',
          text: 'this',
          marks: [{ type: 'link', attrs: { href: 'https://example.com' } }],
        },
      ],
    });
  });

  it('defaults to no mentions when the argument is omitted — Work callers never pass one', () => {
    expect(parseFormattedText('hi @body').content[0]).toEqual({
      type: 'paragraph',
      content: [{ type: 'text', text: 'hi @body' }],
    });
  });
});

describe('liveFormatParser', () => {
  it('returns no ranges for plain text', () => {
    expect(liveFormatParser('hello world')).toEqual([]);
  });

  it('marks the ** syntax and the bold text separately', () => {
    const ranges = liveFormatParser('**bold**');
    expect(ranges).toEqual([
      { type: 'syntax', start: 0, length: 2 },
      { type: 'bold', start: 2, length: 4 },
      { type: 'syntax', start: 6, length: 2 },
    ]);
  });

  it("marks a link's brackets, text, and the (url) tail as syntax around it", () => {
    const text = '[go](https://example.com)';
    const ranges = liveFormatParser(text);
    expect(ranges).toEqual([
      { type: 'syntax', start: 0, length: 1 },
      { type: 'link', start: 1, length: 2 },
      { type: 'syntax', start: 3, length: 22 },
    ]);
    // The full syntax range should span exactly "](https://example.com)".
    const syntaxTail = ranges[2]!;
    expect(text.slice(syntaxTail.start, syntaxTail.start + syntaxTail.length)).toBe(
      '](https://example.com)',
    );
  });

  it('finds every bold span on a line with more than one', () => {
    const ranges = liveFormatParser('**a** and **b**');
    expect(ranges.filter((r) => r.type === 'bold')).toEqual([
      { type: 'bold', start: 2, length: 1 },
      { type: 'bold', start: 12, length: 1 },
    ]);
  });

  it('never highlights an unsafe-scheme link — matches parseFormattedText leaving it as literal text', () => {
    expect(liveFormatParser('[click](javascript:alert(1))')).toEqual([]);
  });
});
