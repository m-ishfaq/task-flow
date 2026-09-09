import { Fragment, type ReactNode } from 'react';

/**
 * A small, safe renderer for the assistant's own free-text replies — bold,
 * inline code, links, bullet/numbered lists, and fenced code blocks. Found
 * necessary from a real transcript: `MessageBubble` rendered
 * `message.content` as a bare `<p>{content}</p>`, so a reply like
 * "1. Urgent 2. High 3. Normal 4. Low" (there is no tool for a fixed enum
 * like priority, so the model has to answer from its own knowledge as plain
 * text) showed up as one run-on sentence with the markdown syntax itself
 * still visible, never as an actual list.
 *
 * Widened past bold+lists after a direct report that the assistant's
 * replies still looked "raw" — a code snippet or a GitHub link in a reply
 * about a PR or a command showed its literal backticks/brackets, the exact
 * same "syntax visible, not rendered" complaint the original bug already
 * fixed for lists. Still NOT a general markdown parser and does not try to
 * be one — no headings, tables, or nested lists. The model's own commentary
 * is deliberately short (the system prompt caps it at "one short sentence"
 * after a read tool, "a brief confirmation sentence" after a write), so the
 * real need is the handful of constructs a short, code-adjacent answer
 * actually reaches for: **bold**, `inline code`, [links](url), a fenced
 * code block, and a short list. Reusing a full markdown library (or
 * `dangerouslySetInnerHTML` over one) would pull in far more surface than
 * that need justifies, and this codebase's own rule is stricter than
 * "sanitize the HTML" — rule 4 bans `dangerouslySetInnerHTML` outright,
 * everywhere, no exception for output the app itself generated. Every node
 * this file produces is a real React element (`<p>`, `<ul>`, `<ol>`, `<li>`,
 * `<pre>`, `<code>`, `<strong>`, `<a>`) built from parsed TEXT, never a
 * string of markup handed to the DOM.
 *
 * A link's URL is checked against `isSafeUrl` before it is ever rendered as
 * a real `href` — the identical "whitelist the scheme, reject the rest"
 * discipline `work/richtext.ts` already applies to a TipTap `link` mark's
 * `href`, for the same reason: `javascript:` reached through a `[text](url)`
 * pair the model happened to echo (from a PR description, a doc, or its own
 * output) is script execution through otherwise-plain text, not a
 * hypothetical. A link that fails the check renders as its own literal
 * bracket-and-paren text instead of a dead or dangerous anchor.
 *
 * `parseMarkdownBlocks`/`parseInlineSegments`/`isSafeUrl` are exported and
 * pure specifically so `markdown-lite.test.ts` can assert the parsing (and
 * the URL-scheme refusal) directly, the same "test the pure half" split
 * this codebase already uses for `neighbours.ts`/`windowForRequest`.
 */

export type MarkdownBlock =
  | { readonly type: 'paragraph'; readonly text: string }
  | { readonly type: 'bullet-list'; readonly items: readonly string[] }
  | { readonly type: 'numbered-list'; readonly items: readonly string[] }
  | { readonly type: 'code-block'; readonly code: string; readonly language: string | null };

const BULLET_LINE = /^\s*[-*]\s+(.*)$/;
const NUMBERED_LINE = /^\s*\d+[.)]\s+(.*)$/;
const FENCE_LINE = /^\s*```\s*([\w-]*)\s*$/;

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

    const fenceMatch = FENCE_LINE.exec(line);
    if (fenceMatch !== null) {
      const language = fenceMatch[1] === '' || fenceMatch[1] === undefined ? null : fenceMatch[1];
      const codeLines: string[] = [];
      i += 1;
      // An unterminated fence (the model's own reply cut off, or simply
      // ending inside a code block) still renders everything gathered so
      // far as code, rather than losing the content or throwing — the same
      // "show something rather than nothing" instinct `DiffView`'s own
      // parser already applies to a truncated diff.
      for (let next = lines[i]; next !== undefined; next = lines[i]) {
        if (FENCE_LINE.exec(next) !== null || /^\s*```\s*$/.test(next)) {
          i += 1;
          break;
        }
        codeLines.push(next);
        i += 1;
      }
      blocks.push({ type: 'code-block', code: codeLines.join('\n'), language });
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

    // A plain paragraph: consume consecutive non-blank, non-list, non-fence
    // lines, joined with a space — ordinary markdown paragraph semantics,
    // where a single newline is a soft wrap rather than a new block.
    const paragraphLines = [line.trim()];
    i += 1;
    for (
      let next = lines[i];
      next !== undefined &&
      next.trim() !== '' &&
      BULLET_LINE.exec(next) === null &&
      NUMBERED_LINE.exec(next) === null &&
      FENCE_LINE.exec(next) === null;
      next = lines[i]
    ) {
      paragraphLines.push(next.trim());
      i += 1;
    }
    blocks.push({ type: 'paragraph', text: paragraphLines.join(' ') });
  }

  return blocks;
}

export type InlineSegment =
  | { readonly type: 'text'; readonly text: string; readonly bold: boolean }
  | { readonly type: 'code'; readonly text: string }
  | { readonly type: 'link'; readonly text: string; readonly url: string };

/* Three alternatives in one pass, in priority order left to right within
   each match position — `**bold**`, `` `code` ``, then `[text](url)` — so a
   single `String#split`-style scan produces segments in the order they
   actually appear, rather than resolving one construct at a time and
   re-scanning the leftovers (which would let a later pass corrupt an
   earlier one's output, e.g. bolding text inside a code span). */
const INLINE_TOKEN = /(\*\*[^*]+\*\*)|(`[^`]+`)|(\[[^\]]+\]\((?:[^()]|\([^()]*\))*\))/g;
const BOLD_WHOLE = /^\*\*([^*]+)\*\*$/;
const CODE_WHOLE = /^`([^`]+)`$/;
const LINK_WHOLE = /^\[([^\]]+)\]\(((?:[^()]|\([^()]*\))*)\)$/;

export function parseInlineSegments(text: string): readonly InlineSegment[] {
  const segments: InlineSegment[] = [];
  let lastIndex = 0;

  for (const match of text.matchAll(INLINE_TOKEN)) {
    const index = match.index;
    if (index > lastIndex) {
      segments.push({ type: 'text', text: text.slice(lastIndex, index), bold: false });
    }

    const token = match[0];
    const boldMatch = BOLD_WHOLE.exec(token);
    const codeMatch = CODE_WHOLE.exec(token);
    const linkMatch = LINK_WHOLE.exec(token);
    if (boldMatch?.[1] !== undefined) {
      segments.push({ type: 'text', text: boldMatch[1], bold: true });
    } else if (codeMatch?.[1] !== undefined) {
      segments.push({ type: 'code', text: codeMatch[1] });
    } else if (linkMatch?.[1] !== undefined && linkMatch[2] !== undefined) {
      segments.push({ type: 'link', text: linkMatch[1], url: linkMatch[2] });
    } else {
      // Unreachable given `INLINE_TOKEN`'s own three alternatives, but a
      // token that matches none of the three WHOLE patterns falls back to
      // its own literal text rather than being silently dropped.
      segments.push({ type: 'text', text: token, bold: false });
    }

    lastIndex = index + token.length;
  }

  if (lastIndex < text.length) {
    segments.push({ type: 'text', text: text.slice(lastIndex), bold: false });
  }
  if (segments.length === 0) {
    segments.push({ type: 'text', text, bold: false });
  }

  return segments;
}

/** Only `http:`/`https:` render as a real, clickable `href` — the identical
    scheme whitelist `work/richtext.ts` already enforces for a TipTap
    `link` mark, applied here because a `[text](url)` pair reaching this
    renderer can originate from content the model merely echoed (a PR
    description, a doc), not only text it composed itself. No base URL: a
    relative reference has no meaning for a chat reply linking to something
    external, and passing one would make the WHATWG `URL` constructor
    resolve arbitrary non-URL text as a relative PATH against it — silently
    inheriting the base's `https:` scheme for text that was never a URL at
    all, defeating the whole check. With no base, only a real absolute URL
    (a real scheme, `javascript:`/`data:` included) ever parses. */
export function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function renderInline(text: string): ReactNode {
  return parseInlineSegments(text).map((segment, index) => {
    switch (segment.type) {
      case 'text':
        return segment.bold ? (
          <strong key={index}>{segment.text}</strong>
        ) : (
          <Fragment key={index}>{segment.text}</Fragment>
        );
      case 'code':
        return (
          <code
            key={index}
            className="rounded bg-ink/10 px-1 py-0.5 font-mono text-[0.85em] text-ink"
          >
            {segment.text}
          </code>
        );
      case 'link':
        return isSafeUrl(segment.url) ? (
          <a
            key={index}
            href={segment.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
          >
            {segment.text}
          </a>
        ) : (
          <Fragment key={index}>
            [{segment.text}]({segment.url})
          </Fragment>
        );
    }
  });
}

export function MarkdownLite({ text }: { readonly text: string }): ReactNode {
  const blocks = parseMarkdownBlocks(text);
  return (
    <div className="space-y-2 text-[13px] leading-relaxed">
      {blocks.map((block, index) => {
        switch (block.type) {
          case 'paragraph':
            return (
              <p key={index} className="whitespace-pre-wrap">
                {renderInline(block.text)}
              </p>
            );
          case 'bullet-list':
            return (
              <ul key={index} className="list-disc space-y-1 pl-4 marker:text-ink-faint">
                {block.items.map((item, itemIndex) => (
                  <li key={itemIndex}>{renderInline(item)}</li>
                ))}
              </ul>
            );
          case 'numbered-list':
            return (
              <ol key={index} className="list-decimal space-y-1 pl-4 marker:text-ink-faint">
                {block.items.map((item, itemIndex) => (
                  <li key={itemIndex}>{renderInline(item)}</li>
                ))}
              </ol>
            );
          case 'code-block':
            return (
              <pre
                key={index}
                className="overflow-x-auto rounded-lg border border-line/60 bg-ink/[0.06] p-2.5 text-[12px]"
              >
                <code className="font-mono">{block.code}</code>
              </pre>
            );
        }
      })}
    </div>
  );
}
