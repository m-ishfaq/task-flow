import { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { colors, radiusCard } from '@taskflow/tokens';
import { apiErrorOf } from './trpc-client.js';
import { activeMentionQuery, insertMention, type PendingMention } from './message-compose.js';
import type { Member } from './use-members.js';

/**
 * The plain-text composer + `@`-mention dropdown, extracted once a second
 * screen (`thread/[messageId].tsx`) needed the identical block
 * `channel/[channelId].tsx`'s original composer already had — same
 * `TextInput`, same dropdown, same Send button. Purely presentational:
 * `draft`/`pendingMentions` stay owned by the CALLER, so "clear the draft
 * only on send success, leave it on failure" — `channel/[channelId].tsx`'s
 * own established behavior — is one `onSuccess` handler in each caller, not
 * a callback this component would need to expose.
 *
 * **This component owns the TEXT SPLICE, not the caller** — the opposite
 * of the original split, which had each caller call `insertMention` itself
 * off a `Member` this component handed back. That worked when a mention
 * could only ever be triggered at the END of the draft; it stopped working
 * once triggering became cursor-based (below), because the cursor position
 * is state only this component tracks. `onMentionRecorded` replaces
 * `onPickMention`: it hands the caller a finished `PendingMention` for
 * bookkeeping only (the caller still owns the running list, for the same
 * "clear on success" reason it owns `draft`), never a raw `Member` the
 * caller would need this component's own cursor state to do anything with.
 *
 * ## Cursor-based triggering, not end-of-draft-only
 *
 * `message-compose.ts`'s own header has the full story: this used to
 * restrict `@mention` to the trailing run because of a claim — since found
 * wrong — that a plain `TextInput` "cannot track a live cursor position."
 * It can, via a CONTROLLED `selection` (start/end) kept in sync from
 * `onSelectionChange` on every event. That is what makes `activeMentionQuery`
 * cursor-aware instead of end-of-string-aware, and what lets `pickMention`
 * report exactly where the caret belongs after a programmatic splice —
 * `insertMention`'s own `cursor` field — rather than leaving it wherever
 * React Native's native default happened to land after a text value changed
 * out from under the input.
 *
 * `selection` is clamped to `draft.length` on every read rather than reset
 * via an effect: the caller clearing `draft` after a successful send (or
 * any other external change) shortens the text out from under a selection
 * this component captured against the PREVIOUS, longer draft, and an
 * unclamped `{ start: 40, end: 40 }` against a now-empty `value=""` is an
 * out-of-bounds selection a native text input should never be handed.
 * Deriving the clamp on every render is simpler than tracking "did the
 * draft change for a reason this component caused" and needs no effect.
 */
export function MessageComposer({
  draft,
  onDraftChange,
  people,
  viewerId,
  onMentionRecorded,
  onSubmit,
  sending,
  error,
  placeholder,
  fallbackError,
}: {
  readonly draft: string;
  readonly onDraftChange: (text: string) => void;
  readonly people: readonly Member[];
  readonly viewerId: string | null;
  readonly onMentionRecorded: (mention: PendingMention) => void;
  readonly onSubmit: () => void;
  readonly sending: boolean;
  readonly error?: unknown;
  readonly placeholder: string;
  readonly fallbackError: string;
}) {
  // `undefined` until the first `onSelectionChange` event arrives, which
  // leaves the TextInput's cursor fully native (uncontrolled) for the very
  // first render rather than forcing it to a guessed position.
  const [selection, setSelection] = useState<{ start: number; end: number } | undefined>(undefined);
  const clampedSelection =
    selection === undefined
      ? undefined
      : {
          start: Math.min(selection.start, draft.length),
          end: Math.min(selection.end, draft.length),
        };

  const active = activeMentionQuery(draft, clampedSelection?.end ?? draft.length);
  const mentionCandidates =
    active === null
      ? []
      : people
          .filter((member) => member.userId !== viewerId)
          .filter((member) =>
            (member.displayName ?? member.email).toLowerCase().includes(active.query.toLowerCase()),
          )
          .slice(0, 6);

  const pickMention = (member: Member): void => {
    if (active === null) return;
    const label = member.displayName ?? member.email;
    const result = insertMention(draft, active, { userId: member.userId, label });
    onDraftChange(result.draft);
    onMentionRecorded(result.mention);
    setSelection({ start: result.cursor, end: result.cursor });
  };

  return (
    <>
      {active !== null && mentionCandidates.length > 0 && (
        <ScrollView style={styles.mentionList} keyboardShouldPersistTaps="handled">
          {mentionCandidates.map((member) => (
            <Pressable
              key={member.userId}
              style={styles.mentionRow}
              onPress={() => {
                pickMention(member);
              }}
            >
              <Text style={styles.mentionRowText}>{member.displayName ?? member.email}</Text>
            </Pressable>
          ))}
        </ScrollView>
      )}

      <View style={styles.composerRow}>
        <TextInput
          value={draft}
          onChangeText={onDraftChange}
          onSelectionChange={(event) => {
            setSelection(event.nativeEvent.selection);
          }}
          selection={clampedSelection}
          placeholder={placeholder}
          placeholderTextColor={colors.inkFaint.hex}
          style={styles.composerInput}
          multiline
        />
        <Pressable
          style={styles.sendButton}
          disabled={draft.trim().length === 0 || sending}
          onPress={onSubmit}
        >
          {sending ? (
            <ActivityIndicator color={colors.accentInk.hex} />
          ) : (
            <Text style={styles.sendButtonText}>Send</Text>
          )}
        </Pressable>
      </View>
      {error !== undefined && error !== null && (
        <Text style={styles.error} accessibilityRole="alert">
          {apiErrorOf(error)?.error.message ?? fallbackError}
        </Text>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  mentionList: {
    maxHeight: 180,
    borderWidth: 1,
    borderColor: colors.line.hex,
    borderRadius: radiusCard,
    backgroundColor: colors.surfaceRaised.hex,
    marginBottom: 6,
  },
  mentionRow: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line.hex,
  },
  mentionRowText: {
    fontSize: 14,
    color: colors.ink.hex,
  },
  composerRow: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'flex-end',
    paddingVertical: 12,
  },
  composerInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.line.hex,
    borderRadius: radiusCard,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: colors.ink.hex,
    backgroundColor: colors.surfaceSunken.hex,
    maxHeight: 100,
  },
  sendButton: {
    backgroundColor: colors.accent.hex,
    borderRadius: radiusCard,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  sendButtonText: {
    color: colors.accentInk.hex,
    fontSize: 14,
    fontWeight: '600',
  },
  error: {
    color: colors.danger.hex,
    fontSize: 13,
    marginBottom: 8,
  },
});
