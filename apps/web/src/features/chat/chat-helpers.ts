import { useEffect, useState } from 'react';
import type { ChannelId } from '@taskflow/contracts';
import { onTyping } from '../../lib/chat-socket.js';
import type { DocumentNode } from '../work/detail/rich-text.js';
import type { ChannelDetail, ReactionRow } from './api.js';

/** How long after the last keystroke a typing indicator auto-clears. */
export const TYPING_TIMEOUT_MS = 4000;

/**
 * The message the "new messages" divider belongs above, or null for no divider.
 *
 * Exported-shaped as a pure function so the placement rules are testable
 * without mounting a panel — every branch below is a case where drawing the
 * line would be wrong, and each is silent if it regresses.
 *
 * `undefined` for the cursor means "not resolved yet"; `null` means "resolved,
 * and this person has never read this channel". They are deliberately different:
 * the first must not draw a line prematurely, the second must not draw one at
 * all — a divider above the very first message labels the entire conversation
 * "new", which is true and useless.
 */
export function firstUnreadAfter(
  cursor: string | null | undefined,
  messageIds: readonly string[],
): string | null {
  if (cursor === undefined || cursor === null) return null;

  const index = messageIds.indexOf(cursor);

  /* The cursor names a message outside the loaded page — older than it, or
     since deleted. Neither is a place to put a line: guessing would land it
     somewhere plausible and wrong. */
  if (index === -1) return null;

  /* Read right up to the end. Everything is read, so there is nothing new to
     separate — this is the ordinary case for a channel someone left open. */
  if (index === messageIds.length - 1) return null;

  return messageIds[index + 1] ?? null;
}

/**
 * How a direct message is named in the sidebar.
 *
 * Two people get one name; three or more get "A, B and 2 others" rather than a
 * list that truncates mid-address, because an ellipsis in the middle of an
 * email is indistinguishable from a different person's.
 */
export function directLabel(
  participantIds: readonly string[],
  personOf: (userId: string) => { readonly label: string },
): string {
  if (participantIds.length === 0) return 'Direct message';

  const labels = participantIds.map((userId) => personOf(userId).label);
  const [first, second, ...rest] = labels;

  if (rest.length > 0) return `${first ?? ''}, ${second ?? ''} and ${String(rest.length)} others`;
  if (second !== undefined) return `${first ?? ''}, ${second}`;
  return first ?? 'Direct message';
}

/**
 * Appends text to the end of a document, for the composer's emoji picker.
 *
 * Writes into the LAST paragraph rather than adding a new one — picking three
 * emoji should produce one line, not three. If the document somehow has no
 * block to append to, one is created, because the server's `doc` schema
 * requires content and an empty `doc` is refused.
 *
 * The result stays inside the node/mark whitelist `RichTextDocument` enforces:
 * an emoji is ordinary text, so this adds a `text` node and nothing else. That
 * is the reason this is a document edit and not a string concatenation on
 * `bodyText` — there is no HTML path here, and this must not open one.
 */
export function appendText(document: DocumentNode, text: string): DocumentNode {
  const blocks = document.content ?? [];
  const last = blocks.at(-1);

  if (last?.type !== 'paragraph') {
    return {
      ...document,
      content: [...blocks, { type: 'paragraph', content: [{ type: 'text', text }] }],
    };
  }

  const inline = last.content ?? [];
  const tail = inline.at(-1);

  /* Merged into the trailing text node when there is one, so the document does
     not accumulate a node per keystroke-equivalent. Two adjacent `text` nodes
     render identically, but they compare and diff differently, and the server
     stores what it is given. */
  const nextInline =
    tail?.type === 'text' && tail.marks === undefined
      ? [...inline.slice(0, -1), { ...tail, text: `${tail.text ?? ''}${text}` }]
      : [...inline, { type: 'text', text }];

  return {
    ...document,
    content: [...blocks.slice(0, -1), { ...last, content: nextInline }],
  };
}

/**
 * The header title for a channel.
 *
 * A DM has no name — the database refuses one, because a named DM would be
 * listable — so it is titled by WHO is in it, resolved through the same member
 * lookup every avatar uses. Falling back to "Direct message" covers the case
 * where `member:read` is denied and the lookup returns nothing: a header
 * reading "Direct message" is honest, where one reading a raw uuid is not.
 */
export function channelTitle(
  channel: ChannelDetail,
  viewerId: string | null,
  personOf: (userId: string) => { readonly label: string },
): string {
  /* No emoji/`#` prefix here — the header renders a Hash or Lock glyph next
     to the name (see the ChannelPanel header), so the title itself carries
     just the name. */
  if (channel.type === 'public') return channel.name ?? '';
  if (channel.type === 'private') return channel.name ?? '';

  const others = channel.memberIds.filter((userId) => userId !== viewerId);
  if (others.length === 0) return 'Direct message';

  const labels = others.map((userId) => personOf(userId).label);
  return labels.length <= 2
    ? labels.join(', ')
    : `${labels[0] ?? ''} and ${String(labels.length - 1)} others`;
}

/**
 * The line under the title, or null when there is nothing to put there.
 *
 * Only a topic today. There is deliberately no "3 members" here — the roster is
 * a click away in the details panel, and a count in the header is the kind of
 * thing that has to be kept in sync with a live membership change for no
 * benefit.
 */
export function channelSubtitle(channel: ChannelDetail): string | null {
  if (channel.archivedAt !== null) return 'Archived — no new messages can be posted.';
  return channel.topic;
}

/** Every reaction row, grouped by message then emoji, with who reacted. */
export function groupReactions(rows: readonly ReactionRow[]): Map<string, Map<string, string[]>> {
  const byMessage = new Map<string, Map<string, string[]>>();
  for (const row of rows) {
    const byEmoji = byMessage.get(row.messageId) ?? new Map<string, string[]>();
    byEmoji.set(row.emoji, [...(byEmoji.get(row.emoji) ?? []), row.userId]);
    byMessage.set(row.messageId, byEmoji);
  }
  return byMessage;
}

/**
 * Typing indicators (ai/phase-5-chat.md §5) — in-process only, no query, no
 * outbox. A `Set` of user ids currently typing in THIS channel, cleared per
 * user after `TYPING_TIMEOUT_MS` in case a `typing:stop` never arrives (a
 * closed tab, a dropped connection) — the same "the absence of a signal must
 * still resolve to a safe state" reasoning presence uses elsewhere.
 */
export function useTypingUsers(channelId: ChannelId, viewerId: string | null): readonly string[] {
  const [typing, setTyping] = useState<readonly string[]>([]);

  useEffect(() => {
    /* No reset here: `ChannelPanel` is keyed by channel in `ChatPage`
       (`key={search}`), so this hook fully remounts — with fresh initial
       state — on every channel switch rather than receiving a new
       `channelId` prop on a live instance. */
    const timers = new Map<string, ReturnType<typeof setTimeout>>();

    const off = onTyping((message) => {
      if (message.channelId !== channelId || message.userId === viewerId) return;

      const existing = timers.get(message.userId);
      if (existing !== undefined) clearTimeout(existing);

      if (!message.typing) {
        timers.delete(message.userId);
        setTyping((current) => current.filter((userId) => userId !== message.userId));
        return;
      }

      setTyping((current) =>
        current.includes(message.userId) ? current : [...current, message.userId],
      );
      timers.set(
        message.userId,
        setTimeout(() => {
          timers.delete(message.userId);
          setTyping((current) => current.filter((userId) => userId !== message.userId));
        }, TYPING_TIMEOUT_MS),
      );
    });

    return () => {
      off();
      for (const timer of timers.values()) clearTimeout(timer);
    };
  }, [channelId, viewerId]);

  return typing;
}

export function describeTyping(
  userIds: readonly string[],
  personOf: (userId: string) => { readonly label: string },
): string | null {
  if (userIds.length === 0) return null;
  const names = userIds.map((userId) => personOf(userId).label);
  const [first, second] = names;
  if (first === undefined) return null;
  if (second === undefined) return `${first} is typing…`;
  if (names.length === 2) return `${first} and ${second} are typing…`;
  return `${String(names.length)} people are typing…`;
}

export function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/**
 * The viewer's own local calendar day for a timestamp — used only to detect
 * when the timeline CROSSES midnight, never rendered directly.
 */
export function dayKeyOf(value: string): string {
  return new Date(value).toDateString();
}

/**
 * The day divider's own label — "Today" / "Yesterday" / a plain date.
 */
export function formatDayLabel(value: string): string {
  const date = new Date(value);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (dayKeyOf(value) === dayKeyOf(today.toISOString())) return 'Today';
  if (dayKeyOf(value) === dayKeyOf(yesterday.toISOString())) return 'Yesterday';
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'long' });
}

/**
 * Groups rows that carry a `messageId` by that id.
 *
 * Shared by attachments and previews, which are the same shape of problem: a
 * flat list keyed to the page of messages being rendered, looked up per bubble.
 */
export function groupByMessage<T extends { readonly messageId: string }>(
  rows: readonly T[],
): ReadonlyMap<string, readonly T[]> {
  const byMessage = new Map<string, T[]>();
  for (const row of rows) {
    byMessage.set(row.messageId, [...(byMessage.get(row.messageId) ?? []), row]);
  }
  return byMessage;
}

/** A one-paragraph document, for text this app composes rather than a person. */
export function textDocument(text: string): DocumentNode {
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
}

/**
 * The plain text of a document, for slash-command parsing.
 *
 * Commands are decided on TEXT, never on the node tree: `/topic` typed into a
 * rich editor may arrive as several text nodes if the person paused, and a
 * parser reading only the first would see `/top`.
 */
export function flattenDocument(node: DocumentNode): string {
  if (typeof node.text === 'string') return node.text;
  return (node.content ?? []).map(flattenDocument).join('');
}
