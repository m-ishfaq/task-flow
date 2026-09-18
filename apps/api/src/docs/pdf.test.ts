import { describe, expect, it } from 'vitest';
import { inflateSync } from 'node:zlib';
import { layoutDocument, renderPdf, type LayoutLine } from './pdf.js';
import { PDFDocument } from 'pdf-lib';
import type { RenderedNode } from './render.js';

/**
 * PDF export (Wave 4, §3.9). `layoutDocument` against a synthetic
 * measurement function (deterministic, no font embedding) — see pdf.ts's
 * own header on why layout and rendering are tested separately: `pdf-lib`
 * gives no way to ask a finished document what text it drew where.
 */

const width = (text: string): number => text.length * 6;

function text(value: string): RenderedNode {
  return { type: 'text', text: value };
}

function textOf(line: LayoutLine): string {
  return line.runs.map((run) => run.text).join('');
}

/** Inflates every FlateDecode content stream and concatenates the raw operator text — `pdf-lib`
 * gives no API to ask a finished document what it drew (see this file's own header), so a test
 * that wants to see literal drawn text has to decode the PDF's own content streams by hand. */
function decodedStreamText(bytes: Uint8Array): string {
  const raw = Buffer.from(bytes).toString('latin1');
  const chunks: string[] = [];
  for (const match of raw.matchAll(/stream\r?\n([\s\S]*?)endstream/g)) {
    const body = Buffer.from(match[1] ?? '', 'latin1');
    try {
      chunks.push(inflateSync(body).toString('latin1'));
    } catch {
      chunks.push(body.toString('latin1'));
    }
  }
  return chunks.join('\n');
}

/** `drawText` emits a `<HEX> Tj` operator (WinAnsi hex string), never a literal `(text) Tj`
 * — so a stream-text assertion has to look for the hex encoding of what was drawn. */
function hexOf(text: string): string {
  return Buffer.from(text, 'latin1').toString('hex');
}

describe('layoutDocument', () => {
  it('lays out a paragraph as body-sized regular text', () => {
    const doc: RenderedNode = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [text('hello world')] }],
    };

    const lines = layoutDocument(doc, width).filter((line) => line.runs.length > 0);
    expect(lines).toHaveLength(1);
    expect(textOf(lines[0]!)).toBe('hello world');
    expect(lines[0]!.runs[0]?.variant).toBe('regular');
    expect(lines[0]!.runs[0]?.size).toBe(11);
  });

  it('lays out a heading larger and bold, scaled by level', () => {
    const doc: RenderedNode = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [text('Big')] },
        { type: 'heading', attrs: { level: 3 }, content: [text('Small')] },
      ],
    };

    const lines = layoutDocument(doc, width).filter((line) => line.runs.length > 0);
    expect(lines[0]!.runs[0]?.variant).toBe('bold');
    expect(lines[0]!.runs[0]?.size).toBeGreaterThan(lines[1]!.runs[0]!.size);
  });

  it('marks bold+italic text as the boldItalic variant', () => {
    const doc: RenderedNode = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'both', marks: [{ type: 'bold' }, { type: 'italic' }] }],
        },
      ],
    };

    const lines = layoutDocument(doc, width).filter((line) => line.runs.length > 0);
    expect(lines[0]!.runs[0]?.variant).toBe('boldItalic');
  });

  it('wraps a long paragraph across multiple lines when it exceeds the max width', () => {
    const doc: RenderedNode = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [text('one two three four five six seven eight nine ten eleven twelve')],
        },
      ],
    };

    // A narrow measurement forces wrapping deterministically.
    const lines = layoutDocument(doc, (t) => t.length * 40).filter((line) => line.runs.length > 0);
    expect(lines.length).toBeGreaterThan(1);
    // No word is dropped in the wrap.
    const joined = lines.map(textOf).join(' ');
    expect(joined.split(/\s+/).filter(Boolean)).toEqual(
      'one two three four five six seven eight nine ten eleven twelve'.split(' '),
    );
  });

  it('prefixes each bullet-list item with a marker, and each ordered-list item with its number', () => {
    const doc: RenderedNode = {
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            { type: 'listItem', content: [{ type: 'paragraph', content: [text('first')] }] },
            { type: 'listItem', content: [{ type: 'paragraph', content: [text('second')] }] },
          ],
        },
        {
          type: 'orderedList',
          attrs: { start: 3 },
          content: [
            { type: 'listItem', content: [{ type: 'paragraph', content: [text('third')] }] },
          ],
        },
      ],
    };

    const lines = layoutDocument(doc, width).filter((line) => line.runs.length > 0);
    expect(textOf(lines[0]!)).toBe('• first');
    expect(textOf(lines[1]!)).toBe('• second');
    expect(textOf(lines[2]!)).toBe('3. third');
  });

  it('renders a pageLink as a bracketed label, and a mention with an @ prefix', () => {
    const doc: RenderedNode = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'mention', attrs: { userId: 'x', label: 'Jane' } },
            text(' see '),
            { type: 'pageLink', attrs: { pageId: 'y', label: 'Runbook' } },
          ],
        },
      ],
    };

    const lines = layoutDocument(doc, width).filter((line) => line.runs.length > 0);
    expect(textOf(lines[0]!)).toBe('@Jane see [[Runbook]]');
  });

  it('renders a codeBlock in the code variant, one line per source line', () => {
    const doc: RenderedNode = {
      type: 'doc',
      content: [{ type: 'codeBlock', content: [text('line one\nline two')] }],
    };

    const lines = layoutDocument(doc, width).filter((line) => line.runs.length > 0);
    expect(lines).toHaveLength(2);
    expect(lines[0]!.runs[0]?.variant).toBe('code');
    expect(textOf(lines[0]!)).toBe('line one');
    expect(textOf(lines[1]!)).toBe('line two');
  });

  it('produces no runs at all for an empty document', () => {
    const doc: RenderedNode = { type: 'doc', content: [] };
    const lines = layoutDocument(doc, width).filter((line) => line.runs.length > 0);
    expect(lines).toEqual([]);
  });
});

describe('renderPdf', () => {
  it('produces a well-formed, loadable PDF with at least one page', async () => {
    const doc: RenderedNode = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [text('Runbook')] },
        { type: 'paragraph', content: [text('This is the content.')] },
      ],
    };

    const bytes = await renderPdf('Runbook', doc);
    const loaded = await PDFDocument.load(bytes);
    expect(loaded.getPageCount()).toBeGreaterThanOrEqual(1);
  });

  it('paginates when content overflows a single page', async () => {
    const paragraphs: RenderedNode[] = Array.from({ length: 200 }, (_, index) => ({
      type: 'paragraph',
      content: [
        text(`Paragraph number ${String(index)} with enough text to take real vertical space.`),
      ],
    }));
    const doc: RenderedNode = { type: 'doc', content: paragraphs };

    const bytes = await renderPdf('Long Document', doc);
    const loaded = await PDFDocument.load(bytes);
    expect(loaded.getPageCount()).toBeGreaterThan(1);
  });

  it('produces a valid PDF for an empty document (just the title)', async () => {
    const doc: RenderedNode = { type: 'doc', content: [] };
    const bytes = await renderPdf('Empty', doc);
    const loaded = await PDFDocument.load(bytes);
    expect(loaded.getPageCount()).toBe(1);
  });

  it('stamps every page with a footer naming the resolved product, defaulting to Rinavai', async () => {
    const doc: RenderedNode = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [text('x')] }],
    };

    const defaulted = await renderPdf('Doc', doc);
    expect(decodedStreamText(defaulted).toLowerCase()).toContain(
      hexOf('Exported from Rinavai').toLowerCase(),
    );

    const branded = await renderPdf('Doc', doc, 'Acme Flow');
    expect(decodedStreamText(branded).toLowerCase()).toContain(
      hexOf('Exported from Acme Flow').toLowerCase(),
    );
  });
});
