/**
 * The `@`-trigger dropdown's own cursor-position logic — WHERE and WHEN a
 * mention can be triggered and inserted, as distinct from `rich-text-
 * compose.ts`'s job (turning the finished draft, mentions included, into a
 * real TipTap document). Split across two files because they are two
 * different kinds of state: this one is about a live CURSOR position,
 * which only a mounted `TextInput` has; that one is a pure text-to-JSON
 * conversion with no notion of a cursor at all. `buildMessageBody`, this
 * file's original text-to-JSON function, moved there and grew bold/link/
 * list support in the move — see that file's own header.
 *
 * This file originally claimed a plain `TextInput` "cannot track a live
 * cursor position/selection the way `apps/web`'s TipTap `MentionExtension`
 * does," and restricted the trigger to the END of the draft only. That
 * claim was wrong — `TextInput` has supported a controlled `selection`
 * prop plus `onSelectionChange` for exactly this since long before this
 * app's React Native pin, and `message-composer.tsx` now uses both, so
 * `@mention` can be triggered and inserted anywhere in the draft, not only
 * at the end.
 *
 * Every accepted pick is recorded as a `PendingMention` — the exact
 * `@Label` text inserted, tied to a `userId` — and handed to
 * `parseFormattedText` at send time, which replaces each recorded
 * marker's LITERAL text with a real `mention` node, left-to-right by
 * first occurrence, POSITION-AGNOSTIC (`indexOf` finds a marker wherever
 * it sits) so a marker inserted mid-string needs no different handling
 * than one typed at the end.
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
