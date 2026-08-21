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
import { activeMentionQuery } from './message-compose.js';
import type { Member } from './use-members.js';

/**
 * The plain-text composer + trailing-`@`-mention dropdown, extracted once a
 * second screen (`thread/[messageId].tsx`) needed the identical block
 * `channel/[channelId].tsx`'s original composer already had — same
 * `TextInput`, same dropdown, same Send button. Purely presentational:
 * `draft`/`pendingMentions` stay owned by the CALLER, so "clear the draft
 * only on send success, leave it on failure" — `channel/[channelId].tsx`'s
 * own established behavior — is one `onSuccess` handler in each caller, not
 * a callback this component would need to expose. `onPickMention` hands
 * back the tapped member rather than performing the text-splice itself —
 * `insertMention` lives once, in `message-compose.ts`, called by each
 * caller the same way `buildMessageBody` already is at send time.
 */
export function MessageComposer({
  draft,
  onDraftChange,
  people,
  viewerId,
  onPickMention,
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
  readonly onPickMention: (member: Member) => void;
  readonly onSubmit: () => void;
  readonly sending: boolean;
  readonly error?: unknown;
  readonly placeholder: string;
  readonly fallbackError: string;
}) {
  const mentionQuery = activeMentionQuery(draft);
  const mentionCandidates =
    mentionQuery === null
      ? []
      : people
          .filter((member) => member.userId !== viewerId)
          .filter((member) =>
            (member.displayName ?? member.email).toLowerCase().includes(mentionQuery.toLowerCase()),
          )
          .slice(0, 6);

  return (
    <>
      {mentionQuery !== null && mentionCandidates.length > 0 && (
        <ScrollView style={styles.mentionList} keyboardShouldPersistTaps="handled">
          {mentionCandidates.map((member) => (
            <Pressable
              key={member.userId}
              style={styles.mentionRow}
              onPress={() => {
                onPickMention(member);
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
