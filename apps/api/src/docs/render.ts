import * as Y from 'yjs';
import PDFDocument from 'pdfkit';
import { MarkSchema, NODE_ATTRIBUTES, isSafeLinkHref, type NodeType } from '../work/richtext.js';

/**
 * Rendering a page's materialized content to safe HTML and to PDF
 * (ai/phase-6-docs.md §3.9, Wave 4).
 *
 * ## Defensive, not trusting, exactly like `content-guard.ts`
 *
 * A materialized `Y.Doc` (`page-version.service.ts#materializeCurrentState`)
 * is content that passed `apps/collab`'s save-boundary whitelist pass at
 * SOME point in the past, not necessarily the most recent WAL row — that
 * pass runs on a debounce (§3.8's own named limitation, restated in
 * `backlinks.ts`'s header: "live, uncommitted state can carry something
 * invalid for as long as it takes to reach the next pass"). A renderer that
 * is about to turn this content into either PUBLIC, unauthenticated HTML or
 * a downloaded PDF cannot assume it is already clean. So this file re-checks
 * every node type, every node's attributes, and every mark against the exact
 * same whitelist `apps/collab/src/content-guard.ts` enforces — walking
 * `Y.XmlElement`/`Y.XmlText` directly rather than converting through
 * `y-prosemirror` first, for the identical reason that file's own header
 * gives (no DOM-dependent `prosemirror-view` on a server that never renders
 * a live editor). An unknown node is skipped entirely, including its
 * children — never rendered as an empty shell that might mislead a reader
 * about what the document actually says. A text run carrying an invalid
 * mark renders as plain, unformatted text — the identical "coarser, but the
 * only thing that can't apply the wrong format to the wrong characters"
 * choice `content-guard.ts` makes for the same reason.
 *
 * ## No `rel`/`target` from content, ever
 *
 * Matches `richtext.ts`'s own comment on `MarkSchema`'s `link` member: `rel`
 * is the RENDERER's decision, never the document's, because a document that
 * could set it could opt itself out of `noopener`. Every rendered `<a>`
 * carries a fixed `rel="noopener noreferrer nofollow"` — `nofollow` in
 * addition to the two the editor's own security posture requires, because
 * this specific renderer's whole job is turning arbitrary member-authored
 * content into a page an anonymous crawler will index.
 */

const MARK_HASH_SUFFIX = /(.*)(--[a-zA-Z0-9+/=]{8})$/;

function baseMarkName(attributeKey: string): string {
  return MARK_HASH_SUFFIX.exec(attributeKey)?.[1] ?? attributeKey;
}

interface DeltaSegment {
  readonly insert: string;
  readonly attributes?: Record<string, unknown>;
}

function deltaOf(text: Y.XmlText): readonly DeltaSegment[] {
  return text.toDelta() as readonly DeltaSegment[];
}

function isKnownNodeType(nodeName: string): nodeName is NodeType {
  return Object.hasOwn(NODE_ATTRIBUTES, nodeName);
}

/** A validated mark, or `null` when the mark is not on the whitelist. */
function validatedMark(
  key: string,
  value: unknown,
): { readonly type: string; readonly attrs?: unknown } | null {
  const markType = baseMarkName(key);
  const hasAttrs = value !== null && typeof value === 'object' && Object.keys(value).length > 0;
  const candidate = hasAttrs ? { type: markType, attrs: value } : { type: markType };
  const result = MarkSchema.safeParse(candidate);
  return result.success ? result.data : null;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Renders one text run's marks as nested, whitelisted tags around its escaped text. */
function renderTextRun(segment: DeltaSegment): string {
  let html = escapeHtml(segment.insert);

  for (const [key, value] of Object.entries(segment.attributes ?? {})) {
    const mark = validatedMark(key, value);
    if (!mark) continue;

    switch (mark.type) {
      case 'bold':
        html = `<strong>${html}</strong>`;
        break;
      case 'italic':
        html = `<em>${html}</em>`;
        break;
      case 'strike':
        html = `<s>${html}</s>`;
        break;
      case 'code':
        html = `<code>${html}</code>`;
        break;
      case 'underline':
        html = `<u>${html}</u>`;
        break;
      case 'link': {
        const attrs = mark.attrs as { readonly href: string } | undefined;
        if (attrs && isSafeLinkHref(attrs.href)) {
          html = `<a href="${escapeHtml(attrs.href)}" rel="noopener noreferrer nofollow">${html}</a>`;
        }
        break;
      }
      default:
        break;
    }
  }

  return html;
}

function renderInline(element: Y.XmlElement): string {
  return element
    .toArray()
    .map((child) => {
      if (child instanceof Y.XmlText) {
        return deltaOf(child).map(renderTextRun).join('');
      }
      if (child instanceof Y.XmlElement) return renderElement(child);
      return '';
    })
    .join('');
}

/** Renders one whitelisted node. Returns `''` for an unknown type — see the file header. */
function renderElement(element: Y.XmlElement): string {
  if (!isKnownNodeType(element.nodeName)) return '';

  const schema = NODE_ATTRIBUTES[element.nodeName];
  const parsed = schema.safeParse(element.getAttributes());
  const attrs: Record<string, unknown> = parsed.success ? parsed.data : {};

  switch (element.nodeName) {
    case 'paragraph':
      return `<p>${renderInline(element)}</p>`;
    case 'hardBreak':
      return '<br>';
    case 'horizontalRule':
      return '<hr>';
    case 'blockquote':
      return `<blockquote>${renderInline(element)}</blockquote>`;
    case 'bulletList':
      return `<ul>${renderInline(element)}</ul>`;
    case 'orderedList': {
      const start = (attrs as { readonly start?: number }).start;
      const startAttr = typeof start === 'number' ? ` start="${String(start)}"` : '';
      return `<ol${startAttr}>${renderInline(element)}</ol>`;
    }
    case 'listItem':
      return `<li>${renderInline(element)}</li>`;
    case 'heading': {
      // `level` is undefined when `attrs` failed NODE_ATTRIBUTES.heading's
      // schema (an out-of-range or non-numeric level) and fell back to `{}`
      // above — falling back to 2 here as well, rather than letting
      // `Math.min`/`Math.max` propagate NaN into a `<hNaN>` tag, is what
      // `render.test.ts` pins down after that exact case produced one.
      const level = (attrs as { readonly level?: number }).level ?? 2;
      const tag = `h${String(Math.min(6, Math.max(1, level)))}`;
      return `<${tag}>${renderInline(element)}</${tag}>`;
    }
    case 'codeBlock': {
      const language = (attrs as { readonly language?: string | null }).language;
      // Whitelisted to a token shape, never interpolated as a free string —
      // an attacker-chosen `language` reaching a class attribute unescaped
      // is a smaller hole than href's, but there is no reason to trust it
      // either.
      const cls =
        typeof language === 'string' && /^[a-zA-Z0-9_-]{1,40}$/.test(language)
          ? ` class="language-${escapeHtml(language)}"`
          : '';
      return `<pre><code${cls}>${renderInline(element)}</code></pre>`;
    }
    case 'taskList':
      return `<ul class="task-list">${renderInline(element)}</ul>`;
    case 'taskItem': {
      const checked = (attrs as { readonly checked?: boolean }).checked === true;
      return `<li><input type="checkbox" disabled${checked ? ' checked' : ''}> ${renderInline(element)}</li>`;
    }
    case 'mention': {
      const label = (attrs as { readonly label?: string }).label;
      return `<span class="mention">@${escapeHtml(label ?? '')}</span>`;
    }
    case 'pageLink': {
      // A reference, not a browsable URL — matches richtext.ts's own note on
      // why this is a node and not a link mark. The target page's own
      // publish state is unknown here, so this never becomes an <a>.
      const label = (attrs as { readonly label?: string }).label;
      return `<span class="page-link">${escapeHtml(label ?? '')}</span>`;
    }
    // 'doc' and 'text' are in NODE_TYPES for RichTextDocument's JSON shape
    // (Work's card descriptions), not for a live Y.XmlFragment — y-prosemirror
    // binds a ProseMirror doc's CHILDREN directly to the fragment (no
    // wrapping element for the doc node itself), and text is always a
    // `Y.XmlText`, never a `Y.XmlElement` this function is called with.
    // Listed explicitly so this switch stays exhaustive over `NodeType`
    // rather than silently falling through the default the day a real case
    // is added and misspelled.
    case 'doc':
    case 'text':
      return '';
  }
}

/** The document body's HTML — no `<html>`/`<head>` wrapper; the caller supplies the shell. */
export function renderFragmentToHtml(fragment: Y.XmlFragment): string {
  return fragment
    .toArray()
    .map((child) => (child instanceof Y.XmlElement ? renderElement(child) : ''))
    .join('');
}

/**
 * A full, self-contained public HTML document. Deliberately no external
 * stylesheet or script reference — the whole point of "no realtime
 * dependency at all" (§3.9) extends to not depending on this API still
 * being reachable for a second request just to render one page.
 */
export function renderPublicPage(input: {
  readonly title: string;
  readonly fragment: Y.XmlFragment;
}): string {
  const body = renderFragmentToHtml(input.fragment);
  const title = escapeHtml(input.title);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="index, follow">
<title>${title}</title>
<style>
  body { max-width: 720px; margin: 2rem auto; padding: 0 1rem; font-family: system-ui, sans-serif; line-height: 1.6; color: #1a1a1a; }
  pre { background: #f4f4f4; padding: 0.75rem; overflow-x: auto; border-radius: 4px; }
  code { font-family: ui-monospace, monospace; }
  blockquote { border-left: 3px solid #ccc; margin-left: 0; padding-left: 1rem; color: #555; }
  .mention, .page-link { color: #2563eb; }
</style>
</head>
<body>
<h1>${title}</h1>
${body}
</body>
</html>`;
}

/* -------------------------------------------------------------------------- *
 * PDF export
 * -------------------------------------------------------------------------- */

interface PdfMarks {
  readonly bold: boolean;
  readonly italic: boolean;
  readonly code: boolean;
  readonly underline: boolean;
  readonly strike: boolean;
  readonly linkHref: string | null;
}

const NO_MARKS: PdfMarks = {
  bold: false,
  italic: false,
  code: false,
  underline: false,
  strike: false,
  linkHref: null,
};

function marksOf(segment: DeltaSegment): PdfMarks {
  let marks = NO_MARKS;

  for (const [key, value] of Object.entries(segment.attributes ?? {})) {
    const mark = validatedMark(key, value);
    if (!mark) continue;

    switch (mark.type) {
      case 'bold':
        marks = { ...marks, bold: true };
        break;
      case 'italic':
        marks = { ...marks, italic: true };
        break;
      case 'code':
        marks = { ...marks, code: true };
        break;
      case 'underline':
        marks = { ...marks, underline: true };
        break;
      case 'strike':
        marks = { ...marks, strike: true };
        break;
      case 'link': {
        const attrs = mark.attrs as { readonly href: string } | undefined;
        if (attrs && isSafeLinkHref(attrs.href)) marks = { ...marks, linkHref: attrs.href };
        break;
      }
      default:
        break;
    }
  }

  return marks;
}

function fontFor(marks: PdfMarks): string {
  if (marks.code) return 'Courier';
  if (marks.bold && marks.italic) return 'Helvetica-BoldOblique';
  if (marks.bold) return 'Helvetica-Bold';
  if (marks.italic) return 'Helvetica-Oblique';
  return 'Helvetica';
}

/** Writes one paragraph-shaped element's inline runs, honoring marks per run. */
function writeInline(
  doc: PDFKit.PDFDocument,
  element: Y.XmlElement,
  options: { continued?: boolean } = {},
): void {
  const runs: { readonly text: string; readonly marks: PdfMarks }[] = [];

  for (const child of element.toArray()) {
    if (child instanceof Y.XmlText) {
      for (const segment of deltaOf(child)) {
        runs.push({ text: segment.insert, marks: marksOf(segment) });
      }
    } else if (child instanceof Y.XmlElement && isKnownNodeType(child.nodeName)) {
      if (child.nodeName === 'mention') {
        const label = child.getAttributes()['label'];
        runs.push({ text: `@${typeof label === 'string' ? label : ''}`, marks: NO_MARKS });
      } else if (child.nodeName === 'pageLink') {
        const label = child.getAttributes()['label'];
        runs.push({ text: typeof label === 'string' ? label : '', marks: NO_MARKS });
      }
    }
  }

  if (runs.length === 0) {
    doc.text('', { continued: options.continued ?? false });
    return;
  }

  runs.forEach((run, index) => {
    const isLast = index === runs.length - 1;
    doc
      .font(fontFor(run.marks))
      .fillColor(run.marks.linkHref ? '#2563eb' : '#1a1a1a')
      .text(run.text, {
        continued: !isLast || (options.continued ?? false),
        underline: run.marks.underline || run.marks.linkHref !== null,
        strike: run.marks.strike,
        link: run.marks.linkHref ?? undefined,
      });
  });

  doc.fillColor('#1a1a1a');
}

const HEADING_SIZE: Readonly<Record<number, number>> = { 1: 24, 2: 20, 3: 17, 4: 15, 5: 13, 6: 12 };

function writeElement(doc: PDFKit.PDFDocument, element: Y.XmlElement, indent: number): void {
  if (!isKnownNodeType(element.nodeName)) return;

  const attrsSchema = NODE_ATTRIBUTES[element.nodeName];
  const parsed = attrsSchema.safeParse(element.getAttributes());
  const attrs: Record<string, unknown> = parsed.success ? parsed.data : {};

  switch (element.nodeName) {
    case 'paragraph':
      doc.font('Helvetica').fontSize(11);
      writeInline(doc, element);
      doc.moveDown(0.6);
      return;
    case 'heading': {
      // Same fallback as `renderElement`'s identical case — see its comment.
      const level = Math.min(6, Math.max(1, (attrs as { readonly level?: number }).level ?? 2));
      doc.font('Helvetica-Bold').fontSize(HEADING_SIZE[level] ?? 12);
      writeInline(doc, element);
      doc.moveDown(0.5);
      return;
    }
    case 'blockquote':
      doc.font('Helvetica-Oblique').fontSize(11);
      for (const child of element.toArray()) {
        if (child instanceof Y.XmlElement) writeElement(doc, child, indent + 1);
      }
      return;
    case 'bulletList':
    case 'taskList':
      for (const child of element.toArray()) {
        if (child instanceof Y.XmlElement) writeElement(doc, child, indent + 1);
      }
      return;
    case 'orderedList': {
      let n = (attrs as { readonly start?: number }).start ?? 1;
      for (const child of element.toArray()) {
        if (!(child instanceof Y.XmlElement) || child.nodeName !== 'listItem') continue;
        doc
          .font('Helvetica')
          .fontSize(11)
          .text(`${'  '.repeat(indent)}${String(n)}. `, { continued: true });
        writeInline(doc, child);
        doc.moveDown(0.3);
        n += 1;
      }
      return;
    }
    case 'listItem':
      doc
        .font('Helvetica')
        .fontSize(11)
        .text(`${'  '.repeat(indent)}• `, { continued: true });
      writeInline(doc, element);
      doc.moveDown(0.3);
      return;
    case 'taskItem': {
      const checked = (attrs as { readonly checked?: boolean }).checked === true;
      doc
        .font('Helvetica')
        .fontSize(11)
        .text(`${'  '.repeat(indent)}[${checked ? 'x' : ' '}] `, { continued: true });
      writeInline(doc, element);
      doc.moveDown(0.3);
      return;
    }
    case 'codeBlock': {
      doc.font('Courier').fontSize(10);
      writeInline(doc, element);
      doc.moveDown(0.6);
      return;
    }
    case 'horizontalRule': {
      const y = doc.y;
      doc
        .moveTo(doc.page.margins.left, y)
        .lineTo(doc.page.width - doc.page.margins.right, y)
        .strokeColor('#cccccc')
        .stroke();
      doc.moveDown(0.6);
      return;
    }
    // 'hardBreak' is ordinarily an INLINE child inside a paragraph/heading —
    // `writeInline` never emits one (it only reads text runs and the two
    // inline atomic nodes below), but a document could technically place one
    // as a direct block-level sibling; treated as a blank line rather than
    // silently dropped.
    case 'hardBreak':
      doc.moveDown(0.3);
      return;
    // 'mention' and 'pageLink' are inline atomic nodes `writeInline` already
    // handles when they appear as a paragraph's child — they have no
    // block-level rendering of their own, so a stray one reaching this
    // function (not nested in a paragraph) renders nothing rather than
    // guessing at a layout for it.
    case 'mention':
    case 'pageLink':
      return;
    // See renderElement's identical note: 'doc' and 'text' describe
    // RichTextDocument's JSON shape, never a live Y.XmlElement.
    case 'doc':
    case 'text':
      return;
  }
}

/**
 * Renders a materialized page to a PDF buffer, off a specific version's
 * content — never the live socket (§3.9): whatever is passed to this
 * function is already a snapshot, resolved by the caller before this runs.
 */
export async function renderPagePdf(input: {
  readonly title: string;
  readonly fragment: Y.XmlFragment;
}): Promise<Buffer> {
  const doc = new PDFDocument({ margin: 56, size: 'A4' });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => {
    chunks.push(chunk);
  });

  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    doc.on('error', reject);
  });

  doc.font('Helvetica-Bold').fontSize(22).text(input.title);
  doc.moveDown(1);

  for (const child of input.fragment.toArray()) {
    if (child instanceof Y.XmlElement) writeElement(doc, child, 0);
  }

  doc.end();
  return done;
}
