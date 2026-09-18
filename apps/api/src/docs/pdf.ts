import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import type { RenderedNode } from './render.js';
import { DEFAULT_PRODUCT_NAME } from '../platform-admin/branding-cache.js';

/**
 * PDF export, off a specific version's rendered content — never live state
 * (ai/phase-6-docs.md §3.9, Wave 4).
 *
 * ## Why `pdf-lib`, and not a headless browser
 *
 * The obvious high-fidelity approach — render the document as HTML and
 * print it with a headless Chromium — was considered and rejected. It would
 * be this codebase's first dependency on a browser binary running inside
 * `apps/api` at all, a materially different operational surface (a
 * multi-hundred-MB download, sandboxing considerations, a process the API
 * would need to spawn and manage) for a feature whose actual requirement —
 * §3.9's own words — is "renders from a specific version," not "renders
 * pixel-identical to the live editor." `pdf-lib` is pure JavaScript, has no
 * native binary and no subprocess, and produces a real, valid PDF from the
 * same `RenderedNode` tree `public.ts` already renders — one content model,
 * two output formats, rather than a second document representation (HTML)
 * introduced solely to hand to a browser.
 *
 * ## Two functions, deliberately split
 *
 * `layoutDocument` is a PURE function: `RenderedNode` in, a flat list of
 * positioned text lines out, no I/O, no `pdf-lib` types in its signature.
 * `renderPdf` turns a layout into actual PDF bytes. The split exists because
 * `pdf-lib`'s own objects (`PDFFont`, embedded glyph data) are not
 * introspectable after the fact — there is no API to ask a finished
 * `PDFDocument` "what text did you draw and where," so a test asserting
 * "a heading produces larger, bold text" has nothing to assert against
 * except the layout model. `pdf.test.ts` tests `layoutDocument` directly for
 * exactly this reason, and `renderPdf` only for "produces a well-formed PDF
 * with the expected page count," which is all a round-trip `PDFDocument.load`
 * can actually confirm.
 */

const PAGE_WIDTH = 595.28; // A4
const PAGE_HEIGHT = 841.89;
const MARGIN = 56; // 0.75in
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

type FontVariant = 'regular' | 'bold' | 'italic' | 'boldItalic' | 'code';

export interface LayoutRun {
  readonly text: string;
  readonly variant: FontVariant;
  readonly size: number;
  readonly underline: boolean;
  readonly strike: boolean;
}

export interface LayoutLine {
  readonly indent: number;
  readonly runs: readonly LayoutRun[];
  /** Extra space after this line, in points — paragraph/heading spacing. */
  readonly spaceAfter: number;
}

const HEADING_SIZE: Record<number, number> = { 1: 24, 2: 20, 3: 17, 4: 15, 5: 13, 6: 12 };
const BODY_SIZE = 11;

interface InlineRun {
  readonly text: string;
  readonly variant: FontVariant;
  readonly underline: boolean;
  readonly strike: boolean;
}

function markSet(marks: RenderedNode['marks']): ReadonlySet<string> {
  return new Set((marks ?? []).map((mark) => mark.type));
}

function variantOf(marks: ReadonlySet<string>): FontVariant {
  if (marks.has('code')) return 'code';
  const bold = marks.has('bold');
  const italic = marks.has('italic');
  if (bold && italic) return 'boldItalic';
  if (bold) return 'bold';
  if (italic) return 'italic';
  return 'regular';
}

/** Flattens one block node's inline content into runs, atomic nodes rendered as bracketed labels. */
function inlineRunsOf(node: RenderedNode): readonly InlineRun[] {
  const runs: InlineRun[] = [];
  for (const child of node.content ?? []) {
    if (child.type === 'text' && child.text !== undefined) {
      const marks = markSet(child.marks);
      runs.push({
        text: child.text,
        variant: variantOf(marks),
        underline: marks.has('underline') || marks.has('link'),
        strike: marks.has('strike'),
      });
    } else if (child.type === 'hardBreak') {
      runs.push({ text: '\n', variant: 'regular', underline: false, strike: false });
    } else if (child.type === 'mention') {
      const label = typeof child.attrs?.['label'] === 'string' ? child.attrs['label'] : 'mention';
      runs.push({ text: `@${label}`, variant: 'bold', underline: false, strike: false });
    } else if (child.type === 'pageLink') {
      const label = typeof child.attrs?.['label'] === 'string' ? child.attrs['label'] : 'page';
      runs.push({ text: `[[${label}]]`, variant: 'italic', underline: true, strike: false });
    }
  }
  return runs;
}

/** Greedy word-wrap of `runs` into lines no wider than `maxWidth`, measured with `widthOf`. */
function wrapRuns(
  runs: readonly InlineRun[],
  size: number,
  maxWidth: number,
  widthOf: (text: string, variant: FontVariant, size: number) => number,
): LayoutRun[][] {
  const lines: LayoutRun[][] = [];
  let current: LayoutRun[] = [];
  let currentWidth = 0;

  const pushWord = (
    word: string,
    variant: FontVariant,
    underline: boolean,
    strike: boolean,
  ): void => {
    const wordWidth = widthOf(word, variant, size);
    if (current.length > 0 && currentWidth + wordWidth > maxWidth) {
      lines.push(current);
      current = [];
      currentWidth = 0;
    }
    current.push({ text: word, variant, size, underline, strike });
    currentWidth += wordWidth;
  };

  for (const run of runs) {
    const segments = run.text.split('\n');
    for (let index = 0; index < segments.length; index++) {
      const segment = segments[index] ?? '';
      for (const word of segment.split(/(\s+)/).filter((piece) => piece.length > 0)) {
        pushWord(word, run.variant, run.underline, run.strike);
      }
      if (index < segments.length - 1) {
        lines.push(current);
        current = [];
        currentWidth = 0;
      }
    }
  }
  if (current.length > 0) lines.push(current);
  return lines.length > 0 ? lines : [[]];
}

interface LayoutContext {
  readonly widthOf: (text: string, variant: FontVariant, size: number) => number;
}

function layoutBlock(
  node: RenderedNode,
  indent: number,
  ctx: LayoutContext,
  out: LayoutLine[],
): void {
  switch (node.type) {
    case 'heading': {
      const level = typeof node.attrs?.['level'] === 'number' ? node.attrs['level'] : 1;
      const size = HEADING_SIZE[level] ?? BODY_SIZE;
      const runs = inlineRunsOf(node).map((run) => ({
        ...run,
        variant: run.variant === 'code' ? ('code' as const) : ('bold' as const),
      }));
      for (const line of wrapRuns(runs, size, CONTENT_WIDTH - indent, ctx.widthOf)) {
        out.push({ indent, runs: line, spaceAfter: 4 });
      }
      out.push({ indent, runs: [], spaceAfter: 8 });
      return;
    }
    case 'paragraph': {
      const runs = inlineRunsOf(node);
      const wrapped = wrapRuns(runs, BODY_SIZE, CONTENT_WIDTH - indent, ctx.widthOf);
      for (const line of wrapped) out.push({ indent, runs: line, spaceAfter: 2 });
      out.push({ indent, runs: [], spaceAfter: 6 });
      return;
    }
    case 'blockquote': {
      for (const child of node.content ?? []) layoutBlock(child, indent + 20, ctx, out);
      return;
    }
    case 'codeBlock': {
      const text = (node.content ?? []).map((child) => child.text ?? '').join('');
      for (const line of text.split('\n')) {
        out.push({
          indent: indent + 12,
          runs: [{ text: line, variant: 'code', size: BODY_SIZE, underline: false, strike: false }],
          spaceAfter: 0,
        });
      }
      out.push({ indent, runs: [], spaceAfter: 6 });
      return;
    }
    case 'bulletList': {
      for (const item of node.content ?? []) layoutListItem(item, indent, '• ', ctx, out);
      return;
    }
    case 'orderedList': {
      const start = typeof node.attrs?.['start'] === 'number' ? node.attrs['start'] : 1;
      (node.content ?? []).forEach((item, index) => {
        layoutListItem(item, indent, `${String(start + index)}. `, ctx, out);
      });
      return;
    }
    case 'taskList': {
      for (const item of node.content ?? []) {
        const checked = item.attrs?.['checked'] === true;
        layoutListItem(item, indent, checked ? '☑ ' : '☐ ', ctx, out);
      }
      return;
    }
    case 'horizontalRule': {
      out.push({
        indent,
        runs: [
          {
            text: '————————',
            variant: 'regular',
            size: BODY_SIZE,
            underline: false,
            strike: false,
          },
        ],
        spaceAfter: 8,
      });
      return;
    }
    case 'doc': {
      for (const child of node.content ?? []) layoutBlock(child, indent, ctx, out);
      return;
    }
    default: {
      // listItem reached directly, or any other container: recurse into children.
      for (const child of node.content ?? []) layoutBlock(child, indent, ctx, out);
    }
  }
}

function layoutListItem(
  item: RenderedNode,
  indent: number,
  marker: string,
  ctx: LayoutContext,
  out: LayoutLine[],
): void {
  const before = out.length;
  for (const child of item.content ?? []) layoutBlock(child, indent + 16, ctx, out);
  const first = out[before];
  if (first) {
    out[before] = {
      ...first,
      runs: [
        { text: marker, variant: 'regular', size: BODY_SIZE, underline: false, strike: false },
        ...first.runs,
      ],
    };
  } else {
    out.push({
      indent: indent + 16,
      runs: [
        { text: marker, variant: 'regular', size: BODY_SIZE, underline: false, strike: false },
      ],
      spaceAfter: 2,
    });
  }
}

/** Pure layout: `RenderedNode` -> lines to draw. No `pdf-lib` involved — see the file header. */
export function layoutDocument(
  document: RenderedNode,
  widthOf: (text: string, variant: FontVariant, size: number) => number = (text, variant, size) =>
    text.length * size * (variant === 'code' ? 0.6 : 0.5),
): readonly LayoutLine[] {
  const lines: LayoutLine[] = [];
  layoutBlock(document, 0, { widthOf }, lines);
  return lines;
}

export async function renderPdf(
  title: string,
  document: RenderedNode,
  productName = DEFAULT_PRODUCT_NAME,
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const fonts: Record<FontVariant, PDFFont> = {
    regular: await pdf.embedFont(StandardFonts.Helvetica),
    bold: await pdf.embedFont(StandardFonts.HelveticaBold),
    italic: await pdf.embedFont(StandardFonts.HelveticaOblique),
    boldItalic: await pdf.embedFont(StandardFonts.HelveticaBoldOblique),
    code: await pdf.embedFont(StandardFonts.Courier),
  };

  const widthOf = (text: string, variant: FontVariant, size: number): number =>
    fonts[variant].widthOfTextAtSize(text, size);

  const lines = layoutDocument(document, widthOf);

  let page: PDFPage = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = PAGE_HEIGHT - MARGIN;

  page.drawText(title, { x: MARGIN, y, size: 20, font: fonts.bold });
  y -= 32;

  const lineHeight = (size: number): number => size * 1.35;

  for (const line of lines) {
    const size = line.runs[0]?.size ?? BODY_SIZE;
    if (y - lineHeight(size) < MARGIN) {
      page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      y = PAGE_HEIGHT - MARGIN;
    }

    let x = MARGIN + line.indent;
    for (const run of line.runs) {
      const font = fonts[run.variant];
      page.drawText(run.text, { x, y, size: run.size, font, color: rgb(0.1, 0.1, 0.1) });
      const width = font.widthOfTextAtSize(run.text, run.size);
      if (run.underline || run.strike) {
        const lineY = run.underline ? y - 1 : y + run.size * 0.3;
        page.drawLine({
          start: { x, y: lineY },
          end: { x: x + width, y: lineY },
          thickness: 0.6,
          color: rgb(0.1, 0.1, 0.1),
        });
      }
      x += width;
    }

    y -= lineHeight(size) + line.spaceAfter;
  }

  /* Drawn once the page count is final, not per-page as content is laid out —
     `layoutDocument`/pagination above adds pages on demand, so the total is
     only known once the loop finishes. */
  const footerText = `Exported from ${productName}`;
  const footerSize = 8;
  const footerWidth = fonts.regular.widthOfTextAtSize(footerText, footerSize);
  for (const footerPage of pdf.getPages()) {
    footerPage.drawText(footerText, {
      x: (PAGE_WIDTH - footerWidth) / 2,
      y: MARGIN / 2,
      size: footerSize,
      font: fonts.regular,
      color: rgb(0.5, 0.5, 0.5),
    });
  }

  return pdf.save();
}
