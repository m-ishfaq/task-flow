import type { MarkdownRange } from '@expensify/react-native-live-markdown';
import type { PendingMention } from './message-compose.js';

/**
 * Turns composer plain text — with `**bold**`, `*italic*`, `~~strike~~`,
 * `` `code` ``, `__underline__`, `[text](url)` links, `# `…`###### `
 * headings, `> ` blockquotes, `- `/`* `/`1. ` lists, `- [ ] `/`- [x] ` task
 * lists, fenced ` ``` ` code blocks, `---` horizontal rules, and any picked
 * `@mention` markers — into a real TipTap-JSON document, the same shape
 * `apps/web`'s TipTap editor already produces and the exact node/mark
 * whitelist `packages/api`'s `richtext.ts` already validates and
 * `rich-text-view.tsx` already renders. Nothing server-side changed to
 * support any of this: every node/mark type here has been in the whitelist
 * since Work's own rich text landed — this file just kept producing a
 * single flat paragraph (then, later, lists and mentions), never using the
 * rest of it.
 *
 * ## Why a live editor is not what closes this
 *
 * There is no WebView here, deliberately (a WYSIWYG option exists —
 * `@10play/tentap-editor` — but it hosts real TipTap inside a WebView,
 * and the call was to stay fully native). `@expensify/react-native-
 * live-markdown`'s `MarkdownTextInput` gives a real native text input
 * that live-highlights INLINE marks (bold, links, …) as you type, but its
 * own `MarkdownRange` type has no notion of a BLOCK structure at all —
 * lists, headings, blockquotes, and code fences are tree/paragraph-level
 * constructs, not a span within flowing text, and nothing about
 * "highlight this character range" can express "these three lines are one
 * ordered list" or "this line is a heading." So this file draws the same
 * split the composer screens already draw between LIVE and SAVE-TIME:
 * INLINE marks are highlighted live (`liveFormatParser` below, wired into
 * `MarkdownTextInput`'s `parser` prop); block-level syntax is typed as
 * plain text and only becomes real nodes here, at save/send time — exactly
 * the same "typed as plain text, becomes a real node when the message is
 * built" relationship `@mention` composing and list lines already have.
 *
 * ## Why the live syntax and the save-time syntax must be the SAME regex
 *
 * `liveFormatParser` runs as a WORKLET, on the UI thread, entirely
 * independent of `parseFormattedText` below — nothing enforces that they
 * agree except this file keeping their patterns hand-identical. If they
 * ever drifted (say, the live parser tolerating single asterisks the
 * save-time one does not), the composer would show something highlighted
 * as bold that then posts as literal `**text**` — a live preview that
 * lies. Every regex both functions read is defined ONCE, above both, for
 * exactly the reason `chat.ts`'s own header gives for importing node/mark
 * types from `@taskflow/api/richtext` rather than restating them: two
 * whitelists that could drift is worse than one.
 *
 * ## `serializeToText` — the inverse, for editing EXISTING content
 *
 * `docs-page-editor.ts` needs to pre-fill the edit box with a faithful
 * plain-text rendering of a page's CURRENT content, not blank — opening
 * "Edit" on a page nobody has ever composed through this format before
 * must not read as "the page is empty." `serializeToText` walks the same
 * node/mark shapes `docs-collab.ts`'s `yjsFragmentToRichTextDocument`
 * already produces, back into the identical syntax `parseFormattedText`
 * reads. It is intentionally NOT total: a run carrying more than one mark
 * only keeps the highest-priority one (`MARK_PRIORITY` below) — nesting
 * `**_both_**` unambiguously was already out of scope for the parser side
 * (this file's own long-standing "no honest way to compose this without a
 * real editor tracking marks independently of text" boundary), so the
 * serializer does not pretend to invent fidelity the parser could not
 * consume back anyway. `mention`/`pageLink` nodes are a harder case — see
 * that function's own header.
 */

const BOLD_PATTERN = /\*\*(.+?)\*\*/;
const STRIKE_PATTERN = /~~(.+?)~~/;
const UNDERLINE_PATTERN = /__(.+?)__/;
const CODE_PATTERN = /`([^`]+?)`/;
/** No `(?<!\*)`/`(?!\*)` lookaround needed — see this file's own header on
 *  why "leftmost match wins, then re-scan the remainder" already resolves
 *  `**bold**` vs `*italic*` correctly without one: `BOLD_PATTERN` is
 *  checked first and, for `**bold**`, matches at the same index a naive
 *  italic attempt would only reach one character later (Loop-tested in
 *  `rich-text-compose.test.ts`). */
const ITALIC_PATTERN = /\*(.+?)\*/;
/** `http(s)`/`mailto` only, matching `packages/api/richtext.ts`'s own `SAFE_SCHEMES` — a link the server would refuse is left as literal text rather than converted and rejected. */
const LINK_PATTERN = /\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/;

const BULLET_LIST_LINE = /^[-*]\s+(.*)$/;
const ORDERED_LIST_LINE = /^\d+\.\s+(.*)$/;
const TASK_LIST_LINE = /^[-*]\s+\[([ xX])\]\s+(.*)$/;
const HEADING_LINE = /^(#{1,6})\s+(.*)$/;
const BLOCKQUOTE_LINE = /^>\s?(.*)$/;
const CODE_FENCE_LINE = /^```\s*([\w-]*)\s*$/;
const HORIZONTAL_RULE_LINE = /^-{3,}$/;

interface MarkedTextRun {
  readonly type: 'text';
  readonly text: string;
  readonly marks?: readonly (
    | { readonly type: 'bold' }
    | { readonly type: 'italic' }
    | { readonly type: 'strike' }
    | { readonly type: 'code' }
    | { readonly type: 'underline' }
    | { readonly type: 'link'; readonly attrs: { readonly href: string } }
  )[];
}

interface MentionRun {
  readonly type: 'mention';
  readonly attrs: { readonly userId: string; readonly label: string };
}

type InlineRun = MarkedTextRun | MentionRun;

interface ParagraphNode {
  readonly type: 'paragraph';
  readonly content: readonly InlineRun[];
}

interface HeadingNode {
  readonly type: 'heading';
  readonly attrs: { readonly level: number };
  readonly content: readonly InlineRun[];
}

interface BlockquoteNode {
  readonly type: 'blockquote';
  readonly content: readonly ParagraphNode[];
}

interface CodeBlockNode {
  readonly type: 'codeBlock';
  readonly attrs: { readonly language: string | null };
  readonly content: readonly [{ readonly type: 'text'; readonly text: string }];
}

interface HorizontalRuleNode {
  readonly type: 'horizontalRule';
}

interface ListItemNode {
  readonly type: 'listItem';
  readonly content: readonly [ParagraphNode];
}

interface BulletListNode {
  readonly type: 'bulletList';
  readonly content: readonly ListItemNode[];
}

interface OrderedListNode {
  readonly type: 'orderedList';
  readonly content: readonly ListItemNode[];
}

interface TaskItemNode {
  readonly type: 'taskItem';
  readonly attrs: { readonly checked: boolean };
  readonly content: readonly [ParagraphNode];
}

interface TaskListNode {
  readonly type: 'taskList';
  readonly content: readonly TaskItemNode[];
}

type BlockNode =
  | ParagraphNode
  | HeadingNode
  | BlockquoteNode
  | CodeBlockNode
  | HorizontalRuleNode
  | BulletListNode
  | OrderedListNode
  | TaskListNode;

export interface FormattedDoc {
  readonly type: 'doc';
  readonly content: readonly BlockNode[];
}

interface Match {
  readonly index: number;
  readonly length: number;
  readonly run: InlineRun;
}

/**
 * The earliest special construct in `text` — a pending mention's exact
 * `@Label` marker, or a `**bold**`/`*italic*`/`~~strike~~`/`` `code` ``/
 * `__underline__` span, or a `[text](url)` link — or `null` once none
 * remain. Mirrors `message-compose.ts`'s own `buildMessageBody` left-to-
 * right "find whichever candidate comes first" loop, generalized from
 * mentions-only to every construct type at once: at every position, ALL of
 * them are candidates, not mentions first. Checked in a fixed order so
 * that a genuine tie at the same starting index resolves predictably
 * (bold before italic is the one that matters in practice — see the
 * module header on why `**bold**` never actually ties with italic in the
 * first place).
 */
function nextMatch(text: string, mentions: readonly PendingMention[]): Match | null {
  let best: Match | null = null;
  const consider = (index: number, length: number, run: InlineRun): void => {
    if (best === null || index < best.index) best = { index, length, run };
  };

  for (const mention of mentions) {
    const marker = `@${mention.label}`;
    const index = text.indexOf(marker);
    if (index !== -1) {
      consider(index, marker.length, {
        type: 'mention',
        attrs: { userId: mention.userId, label: mention.label },
      });
    }
  }

  const bold = BOLD_PATTERN.exec(text);
  if (bold !== null) {
    consider(bold.index, bold[0].length, {
      type: 'text',
      text: bold[1] ?? '',
      marks: [{ type: 'bold' }],
    });
  }

  const strike = STRIKE_PATTERN.exec(text);
  if (strike !== null) {
    consider(strike.index, strike[0].length, {
      type: 'text',
      text: strike[1] ?? '',
      marks: [{ type: 'strike' }],
    });
  }

  const underline = UNDERLINE_PATTERN.exec(text);
  if (underline !== null) {
    consider(underline.index, underline[0].length, {
      type: 'text',
      text: underline[1] ?? '',
      marks: [{ type: 'underline' }],
    });
  }

  const code = CODE_PATTERN.exec(text);
  if (code !== null) {
    consider(code.index, code[0].length, {
      type: 'text',
      text: code[1] ?? '',
      marks: [{ type: 'code' }],
    });
  }

  const italic = ITALIC_PATTERN.exec(text);
  if (italic !== null) {
    consider(italic.index, italic[0].length, {
      type: 'text',
      text: italic[1] ?? '',
      marks: [{ type: 'italic' }],
    });
  }

  const link = LINK_PATTERN.exec(text);
  if (link !== null) {
    consider(link.index, link[0].length, {
      type: 'text',
      text: link[1] ?? '',
      marks: [{ type: 'link', attrs: { href: link[2] ?? '' } }],
    });
  }

  return best;
}

/**
 * One line's worth of inline content — no nesting (a mention inside a
 * bold span, a link inside a bold span, …): once a construct matches, its
 * own captured text is emitted as a plain run, not re-scanned. The same
 * "no honest way to compose this without a real editor tracking marks
 * independently of text, so don't guess" boundary this app already
 * accepts for the mention-only version.
 */
function parseInline(text: string, mentions: readonly PendingMention[]): readonly InlineRun[] {
  const runs: InlineRun[] = [];
  let remaining = text;

  for (;;) {
    const match = nextMatch(remaining, mentions);
    if (match === null) break;
    if (match.index > 0) runs.push({ type: 'text', text: remaining.slice(0, match.index) });
    runs.push(match.run);
    remaining = remaining.slice(match.index + match.length);
  }

  if (remaining.length > 0 || runs.length === 0) runs.push({ type: 'text', text: remaining });

  return runs;
}

function paragraphOf(line: string, mentions: readonly PendingMention[]): ParagraphNode {
  return { type: 'paragraph', content: parseInline(line, mentions) };
}

function listItem(line: string, mentions: readonly PendingMention[]): ListItemNode {
  return { type: 'listItem', content: [paragraphOf(line, mentions)] };
}

/**
 * `parseFormattedText`'s own block/line-range pairing — factored out so
 * `docs-collab.ts`'s block-range anchor builder (comment/suggestion
 * anchoring "from Edit mode," Tier 3 off the mobile-vs-web audit) can know
 * which RAW draft lines became which top-level block, without a second
 * implementation of the grouping rules above to drift from this one.
 * `lineRanges[i]` is the `[startLine, endLine)` span of `text.split('\n')`
 * that produced `blocks[i]` — same length and order as `blocks`.
 */
export interface ParsedBlocks {
  readonly blocks: readonly BlockNode[];
  readonly lineRanges: readonly (readonly [number, number])[];
}

/**
 * The composer's whole plain-text draft, converted to a real multi-block
 * TipTap document. `mentions` defaults to none: Work's card description
 * and comment editors call this with no second argument at all, since
 * neither composes `@mention`s (that stays a Chat-only affordance —
 * `message-compose.ts`'s own header on why mid-string mention composing
 * lives where the cursor-tracking is, unchanged by this file).
 *
 * Every block construct groups consecutive matching lines the same way:
 * `- `/`* ` bullets, `N. ` ordered items, `- [ ] `/`- [x] ` task items,
 * and `> ` blockquote lines each run until a non-matching line ends the
 * run — matching how every markdown-shaped tool (Slack, Discord, GitHub)
 * already reads adjacent marker lines as one list rather than one per
 * line. A fenced ` ``` ` block instead runs until its OWN closing fence
 * (or end of input, if the draft was cut off mid-fence — better to close
 * it than to swallow the rest of the document as "still code"). Order of
 * the checks matters: task-list lines match the bullet pattern too, so
 * `TASK_LIST_LINE` is checked first; everything else is mutually
 * exclusive by its own leading character.
 */
export function parseBlocksWithLineRanges(
  text: string,
  mentions: readonly PendingMention[] = [],
): ParsedBlocks {
  const lines = text.split('\n');
  const blocks: BlockNode[] = [];
  const lineRanges: (readonly [number, number])[] = [];
  let index = 0;

  while (index < lines.length) {
    const blockStart = index;
    const line = lines[index] ?? '';

    const fence = CODE_FENCE_LINE.exec(line);
    if (fence !== null) {
      const language = fence[1] === undefined || fence[1] === '' ? null : fence[1];
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !CODE_FENCE_LINE.test(lines[index] ?? '')) {
        codeLines.push(lines[index] ?? '');
        index += 1;
      }
      if (index < lines.length) index += 1; // consume the closing fence
      blocks.push({
        type: 'codeBlock',
        attrs: { language },
        content: [{ type: 'text', text: codeLines.join('\n') }],
      });
      lineRanges.push([blockStart, index]);
      continue;
    }

    if (HORIZONTAL_RULE_LINE.test(line)) {
      blocks.push({ type: 'horizontalRule' });
      index += 1;
      lineRanges.push([blockStart, index]);
      continue;
    }

    const task = TASK_LIST_LINE.exec(line);
    if (task !== null) {
      const items: TaskItemNode[] = [];
      while (index < lines.length) {
        const match = TASK_LIST_LINE.exec(lines[index] ?? '');
        if (match === null) break;
        items.push({
          type: 'taskItem',
          attrs: { checked: (match[1] ?? '').toLowerCase() === 'x' },
          content: [paragraphOf(match[2] ?? '', mentions)],
        });
        index += 1;
      }
      blocks.push({ type: 'taskList', content: items });
      lineRanges.push([blockStart, index]);
      continue;
    }

    const bullet = BULLET_LIST_LINE.exec(line);
    if (bullet !== null) {
      const items: ListItemNode[] = [];
      while (index < lines.length) {
        const match = BULLET_LIST_LINE.exec(lines[index] ?? '');
        if (match === null || TASK_LIST_LINE.test(lines[index] ?? '')) break;
        items.push(listItem(match[1] ?? '', mentions));
        index += 1;
      }
      blocks.push({ type: 'bulletList', content: items });
      lineRanges.push([blockStart, index]);
      continue;
    }

    const ordered = ORDERED_LIST_LINE.exec(line);
    if (ordered !== null) {
      const items: ListItemNode[] = [];
      while (index < lines.length) {
        const match = ORDERED_LIST_LINE.exec(lines[index] ?? '');
        if (match === null) break;
        items.push(listItem(match[1] ?? '', mentions));
        index += 1;
      }
      blocks.push({ type: 'orderedList', content: items });
      lineRanges.push([blockStart, index]);
      continue;
    }

    const heading = HEADING_LINE.exec(line);
    if (heading !== null) {
      blocks.push({
        type: 'heading',
        attrs: { level: (heading[1] ?? '#').length },
        content: parseInline(heading[2] ?? '', mentions),
      });
      index += 1;
      lineRanges.push([blockStart, index]);
      continue;
    }

    const quote = BLOCKQUOTE_LINE.exec(line);
    if (quote !== null) {
      const paragraphs: ParagraphNode[] = [];
      while (index < lines.length) {
        const match = BLOCKQUOTE_LINE.exec(lines[index] ?? '');
        if (match === null) break;
        paragraphs.push(paragraphOf(match[1] ?? '', mentions));
        index += 1;
      }
      blocks.push({ type: 'blockquote', content: paragraphs });
      lineRanges.push([blockStart, index]);
      continue;
    }

    blocks.push(paragraphOf(line, mentions));
    index += 1;
    lineRanges.push([blockStart, index]);
  }

  if (blocks.length === 0) {
    blocks.push({ type: 'paragraph', content: [] });
    lineRanges.push([0, 0]);
  }

  return { blocks, lineRanges };
}

export function parseFormattedText(
  text: string,
  mentions: readonly PendingMention[] = [],
): FormattedDoc {
  return { type: 'doc', content: parseBlocksWithLineRanges(text, mentions).blocks };
}

/**
 * Which top-level block's `lineRanges` entry `line` falls inside —
 * `docs-page/[pageId].tsx`'s own bridge from a `MarkdownTextInput`
 * selection (via `docs-collab.ts`'s `lineOfOffset`) to the block index
 * `docs-collab.ts`'s `blockRangeAnchor` anchors against. `null` only for a
 * `line` outside every range — should not happen for a line genuinely
 * produced by splitting the SAME text `lineRanges` was built from, but the
 * caller treats `null` as "fall back to a page-level anchor" rather than
 * assuming it cannot occur.
 */
export function blockIndexForLine(
  lineRanges: readonly (readonly [number, number])[],
  line: number,
): number | null {
  for (let index = 0; index < lineRanges.length; index += 1) {
    const range = lineRanges[index];
    if (range !== undefined && line >= range[0] && line < range[1]) return index;
  }
  return null;
}

/**
 * Live inline highlighting for `MarkdownTextInput`'s own `parser` prop —
 * inline marks only (see this file's own header on why block constructs
 * cannot be expressed this way at all). Runs as a WORKLET, on the UI
 * thread, on every keystroke; the `'worklet'` directive inside the
 * function body (not just at module scope) is what
 * `react-native-worklets/plugin` actually looks for to compile it into
 * something that can run there — the identical shape the library's own
 * README example uses.
 *
 * `type: 'syntax'` marks the markup characters themselves (`**`, `` ` ``,
 * `[`/`](url)`, …), rendered de-emphasized (`markdownStyle.syntax` in the
 * composer component) rather than hidden — hiding them would mean the
 * TEXT ON SCREEN no longer matches what `onChangeText` reports, and this
 * component has no separate "display value" from the real one the way a
 * true rich editor does. `bold`/`italic`/`code`/`strikethrough` are all
 * real `MarkdownType` members the library itself defines and renders;
 * `underline` is not one of them, so `__text__`'s delimiters de-emphasize
 * live the same way a `- ` list marker does, with the text itself
 * rendering plain until save.
 */
export function liveFormatParser(input: string): MarkdownRange[] {
  'worklet';
  const ranges: MarkdownRange[] = [];

  const boldRegex = /\*\*(.+?)\*\*/g;
  let bold: RegExpExecArray | null;
  while ((bold = boldRegex.exec(input)) !== null) {
    const innerLength = bold[1]?.length ?? 0;
    ranges.push({ type: 'syntax', start: bold.index, length: 2 });
    ranges.push({ type: 'bold', start: bold.index + 2, length: innerLength });
    ranges.push({ type: 'syntax', start: bold.index + 2 + innerLength, length: 2 });
  }

  const codeRegex = /`([^`]+?)`/g;
  let code: RegExpExecArray | null;
  while ((code = codeRegex.exec(input)) !== null) {
    const innerLength = code[1]?.length ?? 0;
    ranges.push({ type: 'syntax', start: code.index, length: 1 });
    ranges.push({ type: 'code', start: code.index + 1, length: innerLength });
    ranges.push({ type: 'syntax', start: code.index + 1 + innerLength, length: 1 });
  }

  const strikeRegex = /~~(.+?)~~/g;
  let strike: RegExpExecArray | null;
  while ((strike = strikeRegex.exec(input)) !== null) {
    const innerLength = strike[1]?.length ?? 0;
    ranges.push({ type: 'syntax', start: strike.index, length: 2 });
    ranges.push({ type: 'strikethrough', start: strike.index + 2, length: innerLength });
    ranges.push({ type: 'syntax', start: strike.index + 2 + innerLength, length: 2 });
  }

  const underlineRegex = /__(.+?)__/g;
  let underline: RegExpExecArray | null;
  while ((underline = underlineRegex.exec(input)) !== null) {
    ranges.push({ type: 'syntax', start: underline.index, length: underline[0].length });
  }

  // Deliberately last — `**bold**` would otherwise also match a naive
  // italic scan (see the module header's account of why `nextMatch`
  // resolves this by consuming bold first); running italic's regex over
  // the FULL input independently of the others risks exactly that overlap
  // for live highlighting. Each already-claimed range above is excluded
  // by requiring the italic match not START inside one.
  const claimed = ranges.map((range) => [range.start, range.start + range.length] as const);
  const italicRegex = /\*(.+?)\*/g;
  let italic: RegExpExecArray | null;
  while ((italic = italicRegex.exec(input)) !== null) {
    const italicIndex = italic.index;
    const overlapsClaimed = claimed.some(([from, to]) => italicIndex >= from && italicIndex < to);
    if (overlapsClaimed) continue;
    const innerLength = italic[1]?.length ?? 0;
    ranges.push({ type: 'syntax', start: italicIndex, length: 1 });
    ranges.push({ type: 'italic', start: italicIndex + 1, length: innerLength });
    ranges.push({ type: 'syntax', start: italicIndex + 1 + innerLength, length: 1 });
  }

  const linkRegex = /\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g;
  let link: RegExpExecArray | null;
  while ((link = linkRegex.exec(input)) !== null) {
    const textLength = link[1]?.length ?? 0;
    const textStart = link.index + 1;
    ranges.push({ type: 'syntax', start: link.index, length: 1 });
    ranges.push({ type: 'link', start: textStart, length: textLength });
    ranges.push({
      type: 'syntax',
      start: textStart + textLength,
      length: link[0].length - 1 - textLength,
    });
  }

  return ranges;
}

/**
 * The mark a run keeps when it carries more than one — never expected in
 * practice from THIS file's own output (`nextMatch` only ever attaches
 * one), but real content can carry any combination TipTap's editor
 * allows. Ordered roughly by how much meaning would be lost by dropping
 * it: a link's destination is unrecoverable prose if flattened to plain
 * text, so it wins over purely visual marks.
 */
const MARK_PRIORITY: Record<string, number> = {
  link: 0,
  code: 1,
  bold: 2,
  strike: 3,
  underline: 4,
  italic: 5,
};

interface SerializableMark {
  readonly type: string;
  readonly attrs?: Record<string, unknown>;
}

export interface SerializableNode {
  readonly type: string;
  readonly text?: string;
  readonly attrs?: Record<string, unknown>;
  readonly marks?: readonly SerializableMark[];
  readonly content?: readonly SerializableNode[];
}

function wrapForMark(text: string, mark: SerializableMark): string {
  switch (mark.type) {
    case 'bold':
      return `**${text}**`;
    case 'italic':
      return `*${text}*`;
    case 'strike':
      return `~~${text}~~`;
    case 'code':
      return `\`${text}\``;
    case 'underline':
      return `__${text}__`;
    case 'link': {
      const href = typeof mark.attrs?.['href'] === 'string' ? mark.attrs['href'] : '';
      return `[${text}](${href})`;
    }
    default:
      return text;
  }
}

function serializeInline(nodes: readonly SerializableNode[]): string {
  return nodes
    .map((node) => {
      if (node.type === 'mention') {
        const label = typeof node.attrs?.['label'] === 'string' ? node.attrs['label'] : '';
        return `@${label}`;
      }
      if (node.type === 'pageLink') {
        // Serialized as plain text, not `[[…]]` syntax the parser has no
        // way to turn back into a real pageLink — see this function's own
        // header and `docs-page-editor.ts`'s `hasUnpreservableContent`.
        const label = typeof node.attrs?.['label'] === 'string' ? node.attrs['label'] : '';
        return label;
      }
      if (node.type !== 'text') return '';

      const text = node.text ?? '';
      if (node.marks === undefined || node.marks.length === 0) return text;

      const primary = [...node.marks].sort(
        (a, b) => (MARK_PRIORITY[a.type] ?? 99) - (MARK_PRIORITY[b.type] ?? 99),
      )[0];
      return primary === undefined ? text : wrapForMark(text, primary);
    })
    .join('');
}

function serializeBlock(node: SerializableNode): readonly string[] {
  switch (node.type) {
    case 'paragraph':
      return [serializeInline(node.content ?? [])];

    case 'heading': {
      const level = typeof node.attrs?.['level'] === 'number' ? node.attrs['level'] : 1;
      return [
        `${'#'.repeat(Math.min(Math.max(level, 1), 6))} ${serializeInline(node.content ?? [])}`,
      ];
    }

    case 'blockquote':
      return (node.content ?? []).map((child) => `> ${serializeInline(child.content ?? [])}`);

    case 'codeBlock': {
      const language = typeof node.attrs?.['language'] === 'string' ? node.attrs['language'] : '';
      const text = (node.content ?? [])
        .map((child) => child.text ?? '')
        .join('')
        .split('\n');
      return [`\`\`\`${language}`, ...text, '```'];
    }

    case 'horizontalRule':
      return ['---'];

    case 'bulletList':
      return (node.content ?? []).map(
        (item) => `- ${serializeInline(item.content?.[0]?.content ?? [])}`,
      );

    case 'orderedList':
      return (node.content ?? []).map(
        (item, index) =>
          `${String(index + 1)}. ${serializeInline(item.content?.[0]?.content ?? [])}`,
      );

    case 'taskList':
      return (node.content ?? []).map((item) => {
        const checked = item.attrs?.['checked'] === true;
        return `- [${checked ? 'x' : ' '}] ${serializeInline(item.content?.[0]?.content ?? [])}`;
      });

    default:
      // An unrecognized node type reaching here would only happen for a
      // document already outside what this file's own writer produced —
      // `docs-page-editor.ts`'s own pre-flight check is what refuses to
      // enter edit mode on one of those, so this is a defensive floor,
      // not the actual guard.
      return [];
  }
}

/**
 * The inverse of `parseFormattedText` — a rich-text document back into the
 * plain-text syntax this file reads, for pre-filling an edit box with a
 * page's EXISTING content rather than a blank one. Blocks are joined by a
 * single `\n`, matching `parseFormattedText`'s own one-line-per-block
 * reading, so `parseFormattedText(serializeToText(doc))` reproduces `doc`
 * for every node/mark this file's parser understands — asserted directly
 * in `rich-text-compose.test.ts`'s round-trip suite, for real fixtures
 * built the same way `docs-collab.test.ts` builds its own.
 *
 * `mention` round-trips only if the SAME `label` text is preserved
 * verbatim (serialized as `@Label`, re-parsed only when the caller passes
 * a `mentions` list containing that exact `userId`/`label` pair back to
 * `parseFormattedText` — `docs-page-editor.ts` seeds that list from the
 * page's own pre-edit mentions for exactly this reason). `pageLink` has no
 * such path: it serializes to its plain `label` text, and re-parsing never
 * turns that back into a real `pageLink` node — a real, accepted loss
 * flagged to the editor's caller before they can lose one silently, not
 * pretended away.
 */
export function serializeToText(document: {
  readonly content: readonly SerializableNode[];
}): string {
  return document.content.flatMap((node) => serializeBlock(node)).join('\n');
}
