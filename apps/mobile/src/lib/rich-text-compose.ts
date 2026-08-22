import type { MarkdownRange } from '@expensify/react-native-live-markdown';
import type { PendingMention } from './message-compose.js';

/**
 * Turns composer plain text — with `**bold**`, `[text](url)` links,
 * `- item`/`1. item` list lines, and any picked `@mention` markers — into
 * a real TipTap-JSON document, the same shape `apps/web`'s TipTap editor
 * already produces and the exact node/mark whitelist `packages/api`'s
 * `richtext.ts` already validates and `rich-text-view.tsx` already
 * renders. Nothing server-side changed to support this: `bold`, `link`,
 * `bulletList`/`orderedList`/`listItem` have been in the whitelist since
 * Work's own rich text landed — every composer on this app just kept
 * producing a single flat paragraph, never using the rest of it.
 *
 * ## Why a live editor is not what closes this
 *
 * There is no WebView here, deliberately (a WYSIWYG option exists —
 * `@10play/tentap-editor` — but it hosts real TipTap inside a WebView,
 * and the call was to stay fully native). `@expensify/react-native-
 * live-markdown`'s `MarkdownTextInput` gives a real native text input
 * that live-highlights INLINE marks (bold, links, …) as you type, but its
 * own `MarkdownRange` type has no notion of a LIST at all — lists are a
 * block/tree structure, not a span within flowing text, and nothing about
 * "highlight this character range" can express "these three lines are
 * one ordered list." So this file draws the same split the composer
 * screens already draw between LIVE and SEND-TIME: bold/link marks are
 * highlighted live (`liveFormatParser` below, wired into
 * `MarkdownTextInput`'s `parser` prop); `- `/`1. ` list LINES are typed as
 * plain text and only become real `bulletList`/`orderedList` nodes here,
 * at send time — exactly the same "typed as plain text, becomes a real
 * node when the message is built" relationship `@mention` composing
 * already has to `buildMessageBody`'s successor below, not a new pattern
 * invented for lists specifically.
 *
 * ## Why the live syntax and the send-time syntax must be the SAME regex
 *
 * `liveFormatParser` runs as a WORKLET, on the UI thread, entirely
 * independent of `parseFormattedText` below — nothing enforces that they
 * agree except this file keeping their patterns hand-identical. If they
 * ever drifted (say, the live parser tolerating single asterisks the
 * send-time one does not), the composer would show something highlighted
 * as bold that then posts as literal `**text**` — a live preview that
 * lies. `BOLD_PATTERN`/`LINK_PATTERN` are the ONE definition both
 * functions read, for exactly the reason `chat.ts`'s own header gives for
 * importing node/mark types from `@taskflow/api/richtext` rather than
 * restating them: two whitelists that could drift is worse than one.
 */

const BOLD_PATTERN = /\*\*(.+?)\*\*/;
/** `http(s)`/`mailto` only, matching `packages/api/richtext.ts`'s own `SAFE_SCHEMES` — a link the server would refuse is left as literal text rather than converted and rejected. */
const LINK_PATTERN = /\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/;
const BULLET_LIST_LINE = /^[-*]\s+(.*)$/;
const ORDERED_LIST_LINE = /^\d+\.\s+(.*)$/;

interface TextRun {
  readonly type: 'text';
  readonly text: string;
  readonly marks?: readonly (
    { readonly type: 'bold' } | { readonly type: 'link'; readonly attrs: { readonly href: string } }
  )[];
}

interface MentionRun {
  readonly type: 'mention';
  readonly attrs: { readonly userId: string; readonly label: string };
}

type InlineRun = TextRun | MentionRun;

interface ParagraphNode {
  readonly type: 'paragraph';
  readonly content: readonly InlineRun[];
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

type BlockNode = ParagraphNode | BulletListNode | OrderedListNode;

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
 * `@Label` marker, a `**bold**` span, or a `[text](url)` link — or `null`
 * once none remain. Mirrors `message-compose.ts`'s own `buildMessageBody`
 * left-to-right "find whichever candidate comes first" loop, generalized
 * from mentions-only to all three construct types at once: at every
 * position, ALL THREE are candidates, not mentions first.
 */
function nextMatch(text: string, mentions: readonly PendingMention[]): Match | null {
  let best: Match | null = null;

  for (const mention of mentions) {
    const marker = `@${mention.label}`;
    const index = text.indexOf(marker);
    if (index !== -1 && (best === null || index < best.index)) {
      best = {
        index,
        length: marker.length,
        run: { type: 'mention', attrs: { userId: mention.userId, label: mention.label } },
      };
    }
  }

  const bold = BOLD_PATTERN.exec(text);
  if (bold !== null && (best === null || bold.index < best.index)) {
    best = {
      index: bold.index,
      length: bold[0].length,
      run: { type: 'text', text: bold[1] ?? '', marks: [{ type: 'bold' }] },
    };
  }

  const link = LINK_PATTERN.exec(text);
  if (link !== null && (best === null || link.index < best.index)) {
    best = {
      index: link.index,
      length: link[0].length,
      run: {
        type: 'text',
        text: link[1] ?? '',
        marks: [{ type: 'link', attrs: { href: link[2] ?? '' } }],
      },
    };
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

function listItem(line: string, mentions: readonly PendingMention[]): ListItemNode {
  return {
    type: 'listItem',
    content: [{ type: 'paragraph', content: parseInline(line, mentions) }],
  };
}

/**
 * The composer's whole plain-text draft, converted to a real multi-block
 * TipTap document — `buildMessageBody`'s successor, generalized from "one
 * paragraph, mentions only" to "paragraphs and lists, mentions/bold/links
 * all three." `mentions` defaults to none: Work's card description and
 * comment editors call this with no second argument at all, since neither
 * composes `@mention`s (that stays a Chat-only affordance — `message-
 * compose.ts`'s own header on why mid-string mention composing lives
 * where the cursor-tracking is, unchanged by this file).
 *
 * Consecutive `- `/`* ` lines become one `bulletList`; consecutive
 * `N. ` lines become one `orderedList` — grouped by RUN, matching how
 * every markdown-shaped tool (Slack, Discord, GitHub) already reads
 * adjacent list-marker lines as one list rather than one per line. A line
 * that merely STARTS with those characters as prose ("- ish, but not
 * really a list") is read as a list item anyway — the identical trade
 * `slash-commands.ts`'s own header accepts for a message that merely
 * starts with a slash, restated here for list syntax instead.
 */
export function parseFormattedText(
  text: string,
  mentions: readonly PendingMention[] = [],
): FormattedDoc {
  const lines = text.split('\n');
  const blocks: BlockNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';

    const bullet = BULLET_LIST_LINE.exec(line);
    if (bullet !== null) {
      const items: ListItemNode[] = [];
      while (index < lines.length) {
        const match = BULLET_LIST_LINE.exec(lines[index] ?? '');
        if (match === null) break;
        items.push(listItem(match[1] ?? '', mentions));
        index += 1;
      }
      blocks.push({ type: 'bulletList', content: items });
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
      continue;
    }

    blocks.push({ type: 'paragraph', content: parseInline(line, mentions) });
    index += 1;
  }

  if (blocks.length === 0) blocks.push({ type: 'paragraph', content: [] });

  return { type: 'doc', content: blocks };
}

/**
 * Live inline highlighting for `MarkdownTextInput`'s own `parser` prop —
 * bold and links only (see this file's own header on why lists cannot be
 * expressed this way at all). Runs as a WORKLET, on the UI thread, on
 * every keystroke; the `'worklet'` directive inside the function body
 * (not just at module scope) is what `react-native-worklets/plugin`
 * actually looks for to compile it into something that can run there —
 * the identical shape the library's own README example uses.
 *
 * `type: 'syntax'` marks the `**`/`[`/`](url)` markup characters
 * themselves, rendered de-emphasized (`markdownStyle.syntax` in the
 * composer component) rather than hidden — hiding them would mean the
 * TEXT ON SCREEN no longer matches what `onChangeText` reports, and this
 * component has no separate "display value" from the real one the way a
 * true rich editor does.
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
