import { describe, expect, it } from 'vitest';
import { parseInlineSegments, parseMarkdownBlocks } from './markdown-lite.js';

/**
 * `markdown-lite.tsx`'s own header explains why this exists: the assistant's
 * plain-text replies (a fixed-enum answer with no tool behind it, most
 * commonly) came back with literal `1. Urgent 2. High` markdown syntax
 * still visible, never an actual list. These tests cover the pure parsing
 * halves directly, the same split this codebase's own `neighbours.test.ts`
 * and `api.test.ts` (`windowForRequest`) already use for client-only logic.
 */

describe('parseMarkdownBlocks', () => {
  it('parses a single line as one paragraph', () => {
    expect(parseMarkdownBlocks('Here is your answer.')).toEqual([
      { type: 'paragraph', text: 'Here is your answer.' },
    ]);
  });

  it('joins consecutive non-list lines into one paragraph', () => {
    expect(parseMarkdownBlocks('Line one.\nLine two.')).toEqual([
      { type: 'paragraph', text: 'Line one. Line two.' },
    ]);
  });

  it('parses consecutive numbered lines as a numbered list', () => {
    const blocks = parseMarkdownBlocks('1. Urgent\n2. High\n3. Normal\n4. Low');
    expect(blocks).toEqual([{ type: 'numbered-list', items: ['Urgent', 'High', 'Normal', 'Low'] }]);
  });

  it('parses consecutive bullet lines (- or *) as a bullet list', () => {
    expect(parseMarkdownBlocks('- Chore\n- Design\n* Docs')).toEqual([
      { type: 'bullet-list', items: ['Chore', 'Design', 'Docs'] },
    ]);
  });

  it('separates a paragraph, a list, and another paragraph into three blocks', () => {
    const text = 'You can set:\n1. Urgent\n2. High\n\nLet me know if you want to change it.';
    expect(parseMarkdownBlocks(text)).toEqual([
      { type: 'paragraph', text: 'You can set:' },
      { type: 'numbered-list', items: ['Urgent', 'High'] },
      { type: 'paragraph', text: 'Let me know if you want to change it.' },
    ]);
  });

  it('returns no blocks for empty or blank-only text', () => {
    expect(parseMarkdownBlocks('')).toEqual([]);
    expect(parseMarkdownBlocks('   \n  \n')).toEqual([]);
  });
});

describe('parseInlineSegments', () => {
  it('returns the whole string as one non-bold segment when there is no bold span', () => {
    expect(parseInlineSegments('Created it and assigned Priya')).toEqual([
      { text: 'Created it and assigned Priya', bold: false },
    ]);
  });

  it('splits a bold span into a bold segment, stripped of the ** markers', () => {
    expect(parseInlineSegments('This is **urgent**.')).toEqual([
      { text: 'This is ', bold: false },
      { text: 'urgent', bold: true },
      { text: '.', bold: false },
    ]);
  });

  it('handles multiple bold spans in one line', () => {
    expect(parseInlineSegments('**Bold one** and **bold two**')).toEqual([
      { text: 'Bold one', bold: true },
      { text: ' and ', bold: false },
      { text: 'bold two', bold: true },
    ]);
  });
});
