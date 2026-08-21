/**
 * Turns a plain-text composer draft plus the mentions the user actually
 * picked from the `@`-trigger dropdown into a real TipTap-JSON document with
 * `mention` nodes — not literal `@Name` text. There is no native rich text
 * EDITOR (`card/[cardId].tsx`'s `TitleField` header already draws this
 * boundary for Work; chat's composer is the identical plain `TextInput`),
 * so mention COMPOSING cannot track a live cursor position/selection the
 * way `apps/web`'s TipTap `MentionExtension` does. This is the bounded
 * substitute: `channel/[channelId].tsx`'s composer only offers the dropdown
 * while the user is actively typing the END of the draft (never mid-string),
 * and every accepted pick is recorded as a `PendingMention` — the exact
 * `@Label` text inserted, tied to a `userId`. `buildMessageBody` then
 * replaces each recorded marker's LITERAL text with a real `mention` node at
 * send time, left-to-right by first occurrence.
 *
 * Rendering was already built (`rich-text-view.tsx` has had a `case
 * 'mention'` since the read-only TipTap renderer shipped — it just had no
 * caller producing one from native input until this file). Server-side
 * validation is unchanged: `RichTextDocument`'s `mention` node schema
 * requires `userId`/`label`, and this always supplies both from a real
 * roster entry the dropdown offered, never from unvalidated free text.
 *
 * A pending mention that no longer appears verbatim in the final draft
 * (the user edited the middle of "@Jane Doe" after picking her) is simply
 * never matched — it degrades to plain text, not a broken reference. That
 * is the same "no honest way to repair it, so don't guess" call
 * `rich-text.ts`'s own header makes for a sanitizer that cannot fix a
 * half-broken node either.
 */

export interface PendingMention {
  readonly userId: string;
  readonly label: string;
}

interface TextSegment {
  readonly type: 'text';
  readonly text: string;
}

interface MentionSegment {
  readonly type: 'mention';
  readonly attrs: { readonly userId: string; readonly label: string };
}

type Segment = TextSegment | MentionSegment;

export interface RichTextDoc {
  readonly type: 'doc';
  readonly content: readonly [{ readonly type: 'paragraph'; readonly content: readonly Segment[] }];
}

export function buildMessageBody(text: string, mentions: readonly PendingMention[]): RichTextDoc {
  const segments: Segment[] = [];
  let remaining = text;

  // Left-to-right by first occurrence: repeatedly find whichever pending
  // mention's "@Label" marker appears earliest in what's left, emit the
  // plain text before it, then the mention node, and continue past it. A
  // mention can match more than once (the same person named twice) since
  // it stays in the candidate list for every pass.
  for (;;) {
    let bestIndex = -1;
    let bestMention: PendingMention | null = null;
    let bestMarker = '';

    for (const mention of mentions) {
      const marker = `@${mention.label}`;
      const index = remaining.indexOf(marker);
      if (index !== -1 && (bestIndex === -1 || index < bestIndex)) {
        bestIndex = index;
        bestMention = mention;
        bestMarker = marker;
      }
    }

    if (bestIndex === -1 || bestMention === null) break;

    if (bestIndex > 0) segments.push({ type: 'text', text: remaining.slice(0, bestIndex) });
    segments.push({
      type: 'mention',
      attrs: { userId: bestMention.userId, label: bestMention.label },
    });
    remaining = remaining.slice(bestIndex + bestMarker.length);
  }

  if (remaining.length > 0 || segments.length === 0) {
    segments.push({ type: 'text', text: remaining });
  }

  return { type: 'doc', content: [{ type: 'paragraph', content: segments }] };
}

/**
 * The active `@query` at the END of the draft, or `null` when the caller
 * is not (or is no longer) mid-mention — the dropdown's own visibility
 * signal. Only the trailing run counts: `@` earlier in the text is content
 * the user already finished typing, not a live trigger, and a whitespace
 * character always ends the active query (`@a b` is not a query for "a b").
 */
export function activeMentionQuery(draft: string): string | null {
  const at = draft.lastIndexOf('@');
  if (at === -1) return null;
  const tail = draft.slice(at + 1);
  if (/\s/.test(tail)) return null;
  return tail;
}

/** Replaces the active trailing `@query` (see `activeMentionQuery`) with `@Label ` and records the pick. */
export function insertMention(
  draft: string,
  mention: PendingMention,
): { readonly draft: string; readonly mention: PendingMention } {
  const at = draft.lastIndexOf('@');
  const head = at === -1 ? draft : draft.slice(0, at);
  return { draft: `${head}@${mention.label} `, mention };
}
