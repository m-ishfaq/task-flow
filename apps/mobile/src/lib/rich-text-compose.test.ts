import { describe, expect, it } from 'vitest';
import {
  blockIndexForLine,
  liveFormatParser,
  parseBlocksWithLineRanges,
  parseFormattedText,
  serializeToText,
} from './rich-text-compose.js';

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

describe('parseFormattedText — italic, strike, underline, inline code', () => {
  it('wraps a *italic* span in an italic mark', () => {
    expect(parseFormattedText('this is *important* stuff').content[0]).toEqual({
      type: 'paragraph',
      content: [
        { type: 'text', text: 'this is ' },
        { type: 'text', text: 'important', marks: [{ type: 'italic' }] },
        { type: 'text', text: ' stuff' },
      ],
    });
  });

  it('does not misread **bold** as italic — bold wins the tie', () => {
    expect(parseFormattedText('**bold** text').content[0]).toEqual({
      type: 'paragraph',
      content: [
        { type: 'text', text: 'bold', marks: [{ type: 'bold' }] },
        { type: 'text', text: ' text' },
      ],
    });
  });

  it('bold and italic can both appear on the same line', () => {
    const doc = parseFormattedText('**bold** and *italic*');
    expect(doc.content[0]).toEqual({
      type: 'paragraph',
      content: [
        { type: 'text', text: 'bold', marks: [{ type: 'bold' }] },
        { type: 'text', text: ' and ' },
        { type: 'text', text: 'italic', marks: [{ type: 'italic' }] },
      ],
    });
  });

  it('wraps a ~~strike~~ span in a strike mark', () => {
    expect(parseFormattedText('~~old~~ new').content[0]).toEqual({
      type: 'paragraph',
      content: [
        { type: 'text', text: 'old', marks: [{ type: 'strike' }] },
        { type: 'text', text: ' new' },
      ],
    });
  });

  it('wraps a __underline__ span in an underline mark', () => {
    expect(parseFormattedText('__careful__').content[0]).toEqual({
      type: 'paragraph',
      content: [{ type: 'text', text: 'careful', marks: [{ type: 'underline' }] }],
    });
  });

  it('wraps a `code` span in a code mark', () => {
    expect(parseFormattedText('run `npm test` first').content[0]).toEqual({
      type: 'paragraph',
      content: [
        { type: 'text', text: 'run ' },
        { type: 'text', text: 'npm test', marks: [{ type: 'code' }] },
        { type: 'text', text: ' first' },
      ],
    });
  });
});

describe('parseFormattedText — headings', () => {
  it('turns "# " through "###### " into heading levels 1 through 6', () => {
    for (let level = 1; level <= 6; level += 1) {
      const doc = parseFormattedText(`${'#'.repeat(level)} Title`);
      expect(doc.content[0]).toEqual({
        type: 'heading',
        attrs: { level },
        content: [{ type: 'text', text: 'Title' }],
      });
    }
  });

  it('parses inline marks inside a heading', () => {
    expect(parseFormattedText('# **Bold** title').content[0]).toEqual({
      type: 'heading',
      attrs: { level: 1 },
      content: [
        { type: 'text', text: 'Bold', marks: [{ type: 'bold' }] },
        { type: 'text', text: ' title' },
      ],
    });
  });

  it('a "#" with no space is not a heading', () => {
    expect(parseFormattedText('#hashtag').content[0]).toEqual({
      type: 'paragraph',
      content: [{ type: 'text', text: '#hashtag' }],
    });
  });
});

describe('parseFormattedText — blockquote', () => {
  it('groups consecutive "> " lines into one blockquote of paragraphs', () => {
    const doc = parseFormattedText('> first\n> second');
    expect(doc.content).toEqual([
      {
        type: 'blockquote',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'first' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'second' }] },
        ],
      },
    ]);
  });

  it('a non-quote line ends the run', () => {
    const doc = parseFormattedText('> quoted\nplain');
    expect(doc.content).toEqual([
      {
        type: 'blockquote',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'quoted' }] }],
      },
      { type: 'paragraph', content: [{ type: 'text', text: 'plain' }] },
    ]);
  });
});

describe('parseFormattedText — fenced code blocks', () => {
  it('captures the lines between fences as one codeBlock, with no language', () => {
    const doc = parseFormattedText('```\nconst x = 1;\nconsole.log(x);\n```');
    expect(doc.content).toEqual([
      {
        type: 'codeBlock',
        attrs: { language: null },
        content: [{ type: 'text', text: 'const x = 1;\nconsole.log(x);' }],
      },
    ]);
  });

  it('captures a language named on the opening fence', () => {
    const doc = parseFormattedText('```js\nconst x = 1;\n```');
    expect(doc.content[0]).toEqual({
      type: 'codeBlock',
      attrs: { language: 'js' },
      content: [{ type: 'text', text: 'const x = 1;' }],
    });
  });

  it('does not parse ** or - inside a code block as formatting', () => {
    const doc = parseFormattedText('```\n**not bold**\n- not a list\n```');
    expect(doc.content[0]).toEqual({
      type: 'codeBlock',
      attrs: { language: null },
      content: [{ type: 'text', text: '**not bold**\n- not a list' }],
    });
  });

  it('an unclosed fence still closes at end of input rather than swallowing nothing', () => {
    const doc = parseFormattedText('```\nunterminated');
    expect(doc.content[0]).toEqual({
      type: 'codeBlock',
      attrs: { language: null },
      content: [{ type: 'text', text: 'unterminated' }],
    });
  });

  it('a block after the closing fence is parsed normally', () => {
    const doc = parseFormattedText('```\ncode\n```\nafter');
    expect(doc.content).toEqual([
      { type: 'codeBlock', attrs: { language: null }, content: [{ type: 'text', text: 'code' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'after' }] },
    ]);
  });
});

describe('parseFormattedText — task lists', () => {
  it('reads "- [ ] " as an unchecked task item', () => {
    const doc = parseFormattedText('- [ ] buy milk');
    expect(doc.content).toEqual([
      {
        type: 'taskList',
        content: [
          {
            type: 'taskItem',
            attrs: { checked: false },
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'buy milk' }] }],
          },
        ],
      },
    ]);
  });

  it('reads "- [x] " (and "[X]") as a checked task item', () => {
    for (const marker of ['[x]', '[X]']) {
      const doc = parseFormattedText(`- ${marker} done`);
      expect(doc.content[0]).toMatchObject({
        type: 'taskList',
        content: [{ type: 'taskItem', attrs: { checked: true } }],
      });
    }
  });

  it('groups consecutive task lines, distinct from an ordinary bulletList', () => {
    const doc = parseFormattedText('- [ ] one\n- [x] two\n- plain bullet');
    expect(doc.content.map((block) => block.type)).toEqual(['taskList', 'bulletList']);
    expect(doc.content[0]).toMatchObject({
      content: [{ attrs: { checked: false } }, { attrs: { checked: true } }],
    });
  });
});

describe('parseFormattedText — horizontal rule', () => {
  it('turns a lone "---" line into a horizontalRule with no content', () => {
    const doc = parseFormattedText('above\n---\nbelow');
    expect(doc.content).toEqual([
      { type: 'paragraph', content: [{ type: 'text', text: 'above' }] },
      { type: 'horizontalRule' },
      { type: 'paragraph', content: [{ type: 'text', text: 'below' }] },
    ]);
  });

  it('a longer run of dashes also counts', () => {
    expect(parseFormattedText('-----').content[0]).toEqual({ type: 'horizontalRule' });
  });

  it('two dashes alone is NOT a rule — the pattern requires three or more', () => {
    expect(parseFormattedText('--').content[0]?.type).toBe('paragraph');
  });
});

describe('parseBlocksWithLineRanges — the block/line-range pairing docs-collab.ts anchors against', () => {
  it('one line, one block, same content parseFormattedText would produce', () => {
    const { blocks, lineRanges } = parseBlocksWithLineRanges('hello');
    expect(blocks).toEqual(parseFormattedText('hello').content);
    expect(lineRanges).toEqual([[0, 1]]);
  });

  it('three plain-paragraph lines are three separate ranges, each one line wide', () => {
    const { blocks, lineRanges } = parseBlocksWithLineRanges('first\nsecond\nthird');
    expect(blocks).toHaveLength(3);
    expect(lineRanges).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
    ]);
  });

  it('a run of consecutive bullet lines collapses into ONE range spanning all of them', () => {
    const { blocks, lineRanges } = parseBlocksWithLineRanges('- a\n- b\n- c');
    expect(blocks).toEqual(parseFormattedText('- a\n- b\n- c').content);
    expect(blocks[0]?.type).toBe('bulletList');
    expect(lineRanges).toEqual([[0, 3]]);
  });

  it('a fenced code block spans open fence through close fence inclusive', () => {
    const { blocks, lineRanges } = parseBlocksWithLineRanges('before\n```js\ncode\n```\nafter');
    expect(blocks.map((block) => block.type)).toEqual(['paragraph', 'codeBlock', 'paragraph']);
    expect(lineRanges).toEqual([
      [0, 1],
      [1, 4],
      [4, 5],
    ]);
  });

  it('mixed content: paragraph, then a bullet run, then a heading — each range lines up with parseFormattedText’s own blocks', () => {
    const text = 'intro\n- one\n- two\n## Heading';
    const { blocks, lineRanges } = parseBlocksWithLineRanges(text);
    expect(blocks).toEqual(parseFormattedText(text).content);
    expect(lineRanges).toEqual([
      [0, 1],
      [1, 3],
      [3, 4],
    ]);
  });

  it('empty input still returns exactly one block and one range, matching parseFormattedText’s own output', () => {
    const { blocks, lineRanges } = parseBlocksWithLineRanges('');
    expect(blocks).toEqual(parseFormattedText('').content);
    expect(lineRanges).toEqual([[0, 1]]);
  });

  it('ranges are contiguous and exhaustive — every line belongs to exactly one block', () => {
    const text = '# Title\n\nsome text\n- a\n- b\n\n> quoted\nafter';
    const { lineRanges } = parseBlocksWithLineRanges(text);
    const totalLines = text.split('\n').length;
    expect(lineRanges[0]?.[0]).toBe(0);
    expect(lineRanges.at(-1)?.[1]).toBe(totalLines);
    for (let i = 1; i < lineRanges.length; i += 1) {
      expect(lineRanges[i]?.[0]).toBe(lineRanges[i - 1]?.[1]);
    }
  });
});

describe('blockIndexForLine', () => {
  it('finds the block a line belongs to, across several one-line blocks', () => {
    const { lineRanges } = parseBlocksWithLineRanges('first\nsecond\nthird');
    expect(blockIndexForLine(lineRanges, 0)).toBe(0);
    expect(blockIndexForLine(lineRanges, 1)).toBe(1);
    expect(blockIndexForLine(lineRanges, 2)).toBe(2);
  });

  it('every line of a grouped block (a bullet run) maps to that SAME block index', () => {
    const { lineRanges } = parseBlocksWithLineRanges('intro\n- a\n- b\n- c\noutro');
    expect(blockIndexForLine(lineRanges, 1)).toBe(1);
    expect(blockIndexForLine(lineRanges, 2)).toBe(1);
    expect(blockIndexForLine(lineRanges, 3)).toBe(1);
    expect(blockIndexForLine(lineRanges, 0)).toBe(0);
    expect(blockIndexForLine(lineRanges, 4)).toBe(2);
  });

  it('returns null for a line outside every range', () => {
    const { lineRanges } = parseBlocksWithLineRanges('only one line');
    expect(blockIndexForLine(lineRanges, 5)).toBeNull();
    expect(blockIndexForLine(lineRanges, -1)).toBeNull();
  });
});

describe('serializeToText — the inverse of parseFormattedText', () => {
  it('round-trips plain paragraphs', () => {
    const doc = parseFormattedText('first\nsecond');
    expect(parseFormattedText(serializeToText(doc))).toEqual(doc);
  });

  it('round-trips every inline mark', () => {
    const doc = parseFormattedText(
      '**bold** *italic* ~~strike~~ __underline__ `code` [link](https://example.com/a)',
    );
    expect(parseFormattedText(serializeToText(doc))).toEqual(doc);
  });

  it('round-trips headings at every level', () => {
    for (let level = 1; level <= 6; level += 1) {
      const doc = parseFormattedText(`${'#'.repeat(level)} Title here`);
      expect(parseFormattedText(serializeToText(doc))).toEqual(doc);
    }
  });

  it('round-trips a blockquote', () => {
    const doc = parseFormattedText('> one\n> two');
    expect(parseFormattedText(serializeToText(doc))).toEqual(doc);
  });

  it('round-trips a fenced code block, with and without a language', () => {
    const withLang = parseFormattedText('```ts\nconst x = 1;\nconst y = 2;\n```');
    expect(parseFormattedText(serializeToText(withLang))).toEqual(withLang);

    const withoutLang = parseFormattedText('```\nplain text\n```');
    expect(parseFormattedText(serializeToText(withoutLang))).toEqual(withoutLang);
  });

  it('round-trips a horizontal rule', () => {
    const doc = parseFormattedText('above\n---\nbelow');
    expect(parseFormattedText(serializeToText(doc))).toEqual(doc);
  });

  it('round-trips bullet, ordered, and task lists', () => {
    const bullet = parseFormattedText('- one\n- two');
    expect(parseFormattedText(serializeToText(bullet))).toEqual(bullet);

    const ordered = parseFormattedText('1. one\n2. two');
    expect(parseFormattedText(serializeToText(ordered))).toEqual(ordered);

    const tasks = parseFormattedText('- [ ] todo\n- [x] done');
    expect(parseFormattedText(serializeToText(tasks))).toEqual(tasks);
  });

  it('serializes a mention back to its @Label marker', () => {
    const doc = parseFormattedText('hey @Jane Doe please look', [
      { userId: 'u1', label: 'Jane Doe' },
    ]);
    expect(serializeToText(doc)).toBe('hey @Jane Doe please look');
  });

  it('keeps only the highest-priority mark when a run somehow carries more than one', () => {
    const multiMarked = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'both',
              marks: [{ type: 'italic' }, { type: 'link', attrs: { href: 'https://example.com' } }],
            },
          ],
        },
      ],
    };
    // link (priority 0) beats italic (priority 5) — the destination is
    // unrecoverable prose if dropped, the visual emphasis is not.
    expect(serializeToText(multiMarked)).toBe('[both](https://example.com)');
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
