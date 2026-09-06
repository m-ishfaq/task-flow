import { Fragment, type ReactNode } from 'react';

/**
 * A small, safe renderer for the assistant's own free-text replies — bold
 * spans, bullet lists, and numbered lists. Found necessary from a real
 * transcript: `MessageBubble` rendered `message.content` as a bare
 * `<p>{content}</p>`, so a reply like "1. Urgent 2. High 3. Normal 4. Low"
 * (there is no tool for a fixed enum like priority, so the model has to
 * answer from its own knowledge as plain text) showed up as one run-on
 * sentence with the markdown syntax itself still visible, never as an
 * actual list.
 *
 * This is NOT a general markdown parser and does not try to be one — no
 * headings, tables, code fences, links, or nested lists. The model's own
 * commentary is deliberately short (the system prompt caps it at "one short
 * sentence" after a read tool, "a brief confirmation sentence" after a
 * write), so the real need is exactly the two constructs a short answer
 * reaches for: **bold** for emphasis and a numbered/bulleted list for a
 * handful of options. Reusing a full markdown library (or `dangerouslySetInnerHTML`
 * over one) would pull in far more surface than that need justifies, and
 * this codebase's own rule is stricter than "sanitize the HTML" — rule 4
 * bans `dangerouslySetInnerHTML` outright, everywhere, no exception for
 * output the app itself generated. Every node this file produces is a real
 * React element (`<p>`, `<ul>`, `<ol>`, `<li>`, `<strong>`) built from parsed
 * TEXT, never a string of markup handed to the DOM.
 *
 * `parseMarkdownBlocks`/`parseInlineSegments` are exported and pure
 * specifically so `markdown-lite.test.ts` can assert the parsing directly,
 * the same "test the pure half" split this codebase already uses for
 * `neighbours.ts`/`windowForRequest`.
 */

export type MarkdownBlock =
  | { readonly type: 'paragraph'; readonly text: string }
  | { readonly type: 'bullet-list'; readonly items: readonly string[] }
  | { readonly type: 'numbered-list'; readonly items: readonly string[] };

const BULLET_LINE = /^\s*[-*]\s+(.*)$/;
const NUMBERED_LINE = /^\s*\d+[.)]\s+(.*)$/;

export function parseMarkdownBlocks(text: string): readonly MarkdownBlock[] {
  const lines = text.split('\n');
  const blocks: MarkdownBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined || line.trim() === '') {
      i += 1;
      continue;
    }

    const bulletMatch = BULLET_LINE.exec(line);
    if (bulletMatch !== null) {
      const items = [bulletMatch[1] ?? ''];
      i += 1;
      for (let next = lines[i]; next !== undefined; next = lines[i]) {
        const nextMatch = BULLET_LINE.exec(next);
        if (nextMatch === null) break;
        items.push(nextMatch[1] ?? '');
        i += 1;
      }
      blocks.push({ type: 'bullet-list', items });
      continue;
    }

    const numberedMatch = NUMBERED_LINE.exec(line);
    if (numberedMatch !== null) {
      const items = [numberedMatch[1] ?? ''];
      i += 1;
      for (let next = lines[i]; next !== undefined; next = lines[i]) {
        const nextMatch = NUMBERED_LINE.exec(next);
        if (nextMatch === null) break;
        items.push(nextMatch[1] ?? '');
        i += 1;
      }
      blocks.push({ type: 'numbered-list', items });
      continue;
    }

    // A plain paragraph: consume consecutive non-blank, non-list lines,
    // joined with a space — ordinary markdown paragraph semantics, where a
    // single newline is a soft wrap rather than a new block.
    const paragraphLines = [line.trim()];
    i += 1;
    for (
      let next = lines[i];
      next !== undefined &&
      next.trim() !== '' &&
      BULLET_LINE.exec(next) === null &&
      NUMBERED_LINE.exec(next) === null;
      next = lines[i]
    ) {
      paragraphLines.push(next.trim());
      i += 1;
    }
    blocks.push({ type: 'paragraph', text: paragraphLines.join(' ') });
  }

  return blocks;
}

export interface InlineSegment {
  readonly text: string;
  readonly bold: boolean;
}

const BOLD_SPAN = /(\*\*[^*]+\*\*)/g;
const BOLD_SPAN_WHOLE = /^\*\*([^*]+)\*\*$/;

export function parseInlineSegments(text: string): readonly InlineSegment[] {
  return text
    .split(BOLD_SPAN)
    .filter((chunk) => chunk !== '')
    .map((chunk) => {
      const match = BOLD_SPAN_WHOLE.exec(chunk);
      return match?.[1] !== undefined
        ? { text: match[1], bold: true }
        : { text: chunk, bold: false };
    });
}

function renderInline(text: string): ReactNode {
  return parseInlineSegments(text).map((segment, index) =>
    segment.bold ? (
      <strong key={index}>{segment.text}</strong>
    ) : (
      <Fragment key={index}>{segment.text}</Fragment>
    ),
  );
}

export function MarkdownLite({ text }: { readonly text: string }): ReactNode {
  const blocks = parseMarkdownBlocks(text);
  return (
    <div className="space-y-1.5">
      {blocks.map((block, index) => {
        switch (block.type) {
          case 'paragraph':
            return <p key={index}>{renderInline(block.text)}</p>;
          case 'bullet-list':
            return (
              <ul key={index} className="list-disc space-y-0.5 pl-4">
                {block.items.map((item, itemIndex) => (
                  <li key={itemIndex}>{renderInline(item)}</li>
                ))}
              </ul>
            );
          case 'numbered-list':
            return (
              <ol key={index} className="list-decimal space-y-0.5 pl-4">
                {block.items.map((item, itemIndex) => (
                  <li key={itemIndex}>{renderInline(item)}</li>
                ))}
              </ol>
            );
        }
      })}
    </div>
  );
}
