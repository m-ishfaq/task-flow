/**
 * Turns a plain-text composer draft plus the mentions the user actually
 * picked from the `@`-trigger dropdown into a real TipTap-JSON document with
 * `mention` nodes — not literal `@Name` text. There is still no native rich
 * text EDITOR (`card/[cardId].tsx`'s `TitleField` header draws the identical
 * boundary for Work — no bold, links, or lists composed on this app), so a
 * message's FORMATTING is always plain. But mention COMPOSING itself is not
 * actually blocked on that: this file originally claimed a plain `TextInput`
 * "cannot track a live cursor position/selection the way `apps/web`'s
 * TipTap `MentionExtension` does," and restricted the trigger to the END of
 * the draft only. That claim was wrong — `TextInput` has supported a
 * controlled `selection` prop plus `onSelectionChange` for exactly this
 * since long before this app's React Native pin, and `message-composer.tsx`
 * now uses both, so `@mention` can be triggered and inserted anywhere in
 * the draft, not only at the end.
 *
 * Every accepted pick is still recorded as a `PendingMention` — the exact
 * `@Label` text inserted, tied to a `userId`. `buildMessageBody` replaces
 * each recorded marker's LITERAL text with a real `mention` node at send
 * time, left-to-right by first occurrence — unchanged by the cursor-tracking
 * fix, and deliberately so: it was already POSITION-AGNOSTIC (`indexOf`
 * finds a marker wherever it sits), so a marker inserted mid-string needs
 * no different handling at send time than one typed at the end.
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

/** An in-progress `@query`, anchored to where the triggering `@` sits (`start`) and where the cursor was when it was captured (`end`). */
export interface MentionQuery {
  readonly query: string;
  readonly start: number;
  readonly end: number;
}

/**
 * The active `@query` nearest the CURSOR, or `null` when the cursor is not
 * (or is no longer) inside one — the dropdown's own visibility signal.
 * Anchored to `cursor`, not the end of the draft: `message-composer.tsx`
 * passes the TextInput's own live selection, so typing `@` in the MIDDLE
 * of existing text triggers the dropdown exactly the way typing it at the
 * end always has. Only the run immediately before the cursor counts — an
 * `@` earlier in the text, before wherever the cursor currently sits, is
 * content already finished, not a live trigger — and a whitespace
 * character always ends the active query (`@a b|` is not a query for
 * "a b" once the cursor, `|`, has moved past the space).
 */
export function activeMentionQuery(draft: string, cursor: number): MentionQuery | null {
  const prefix = draft.slice(0, cursor);
  const at = prefix.lastIndexOf('@');
  if (at === -1) return null;
  const tail = draft.slice(at + 1, cursor);
  if (/\s/.test(tail)) return null;
  return { query: tail, start: at, end: cursor };
}

/**
 * Replaces the active `@query` (see `activeMentionQuery`) with `@Label `,
 * records the pick, and reports where the cursor belongs afterward — right
 * after the inserted text, not necessarily the end of the draft, since the
 * query being replaced may have been anywhere in the string. The caller
 * (`message-composer.tsx`) feeds `cursor` back into the TextInput's own
 * controlled `selection` prop; skipping that would leave the caret wherever
 * it happened to land natively, which after a programmatic text splice is
 * rarely where the person was actually typing.
 */
export function insertMention(
  draft: string,
  active: MentionQuery,
  mention: PendingMention,
): { readonly draft: string; readonly mention: PendingMention; readonly cursor: number } {
  const before = draft.slice(0, active.start);
  const after = draft.slice(active.end);
  const inserted = `@${mention.label} `;
  return {
    draft: `${before}${inserted}${after}`,
    mention,
    cursor: before.length + inserted.length,
  };
}
