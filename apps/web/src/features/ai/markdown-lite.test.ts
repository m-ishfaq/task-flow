import { describe, expect, it } from 'vitest';
import { isSafeUrl, parseInlineSegments, parseMarkdownBlocks } from './markdown-lite.js';

/**
 * `markdown-lite.tsx`'s own header explains why this exists: the assistant's
 * plain-text replies (a fixed-enum answer with no tool behind it, most
 * commonly) came back with literal `1. Urgent 2. High` markdown syntax
 * still visible, never an actual list, and — after this file was widened —
 * the identical complaint recurred for inline code and links. These tests
 * cover the pure parsing halves directly, the same split this codebase's
 * own `neighbours.test.ts` and `api.test.ts` (`windowForRequest`) already
 * use for client-only logic.
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

  it('parses a fenced code block with a language tag', () => {
    const text = '```ts\nconst x = 1;\nconsole.log(x);\n```';
    expect(parseMarkdownBlocks(text)).toEqual([
      { type: 'code-block', code: 'const x = 1;\nconsole.log(x);', language: 'ts' },
    ]);
  });

  it('parses a fenced code block with no language tag', () => {
    expect(parseMarkdownBlocks('```\ngit fetch origin\n```')).toEqual([
      { type: 'code-block', code: 'git fetch origin', language: null },
    ]);
  });

  it('still renders everything gathered when a fence is never closed', () => {
    expect(parseMarkdownBlocks('```\nunterminated')).toEqual([
      { type: 'code-block', code: 'unterminated', language: null },
    ]);
  });

  it('separates a paragraph from a code block that follows it', () => {
    const text = 'Run this:\n```\nnpm test\n```';
    expect(parseMarkdownBlocks(text)).toEqual([
      { type: 'paragraph', text: 'Run this:' },
      { type: 'code-block', code: 'npm test', language: null },
    ]);
  });
});

describe('parseInlineSegments', () => {
  it('returns the whole string as one non-bold text segment when there is no special span', () => {
    expect(parseInlineSegments('Created it and assigned Priya')).toEqual([
      { type: 'text', text: 'Created it and assigned Priya', bold: false },
    ]);
  });

  it('splits a bold span into a bold text segment, stripped of the ** markers', () => {
    expect(parseInlineSegments('This is **urgent**.')).toEqual([
      { type: 'text', text: 'This is ', bold: false },
      { type: 'text', text: 'urgent', bold: true },
      { type: 'text', text: '.', bold: false },
    ]);
  });

  it('handles multiple bold spans in one line', () => {
    expect(parseInlineSegments('**Bold one** and **bold two**')).toEqual([
      { type: 'text', text: 'Bold one', bold: true },
      { type: 'text', text: ' and ', bold: false },
      { type: 'text', text: 'bold two', bold: true },
    ]);
  });

  it('splits an inline code span, stripped of the backticks', () => {
    expect(parseInlineSegments('Run `git status` first.')).toEqual([
      { type: 'text', text: 'Run ', bold: false },
      { type: 'code', text: 'git status' },
      { type: 'text', text: ' first.', bold: false },
    ]);
  });

  it('splits a link into text and url, stripped of the brackets/parens', () => {
    expect(parseInlineSegments('See [the PR](https://github.com/acme/todo/pull/1).')).toEqual([
      { type: 'text', text: 'See ', bold: false },
      { type: 'link', text: 'the PR', url: 'https://github.com/acme/todo/pull/1' },
      { type: 'text', text: '.', bold: false },
    ]);
  });

  it('handles bold, code, and a link together, in the order they appear', () => {
    const text = '**Note:** run `pnpm test`, see [docs](https://example.com/docs).';
    expect(parseInlineSegments(text)).toEqual([
      { type: 'text', text: 'Note:', bold: true },
      { type: 'text', text: ' run ', bold: false },
      { type: 'code', text: 'pnpm test' },
      { type: 'text', text: ', see ', bold: false },
      { type: 'link', text: 'docs', url: 'https://example.com/docs' },
      { type: 'text', text: '.', bold: false },
    ]);
  });
});

describe('isSafeUrl', () => {
  it('accepts http and https', () => {
    expect(isSafeUrl('https://example.com/docs')).toBe(true);
    expect(isSafeUrl('http://example.com')).toBe(true);
  });

  it('refuses a javascript: URL — the same scheme whitelist work/richtext.ts enforces for a TipTap link mark', () => {
    expect(isSafeUrl('javascript:alert(1)')).toBe(false);
  });

  it('refuses other non-http(s) schemes and unparseable text', () => {
    expect(isSafeUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
    expect(isSafeUrl('mailto:someone@example.com')).toBe(false);
    expect(isSafeUrl('not a url at all')).toBe(false);
  });
});
