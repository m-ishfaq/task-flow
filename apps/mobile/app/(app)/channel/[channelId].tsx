import { useMemo, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { ChannelIdSchema, type ChannelId } from '@taskflow/contracts';
import { wire } from '@taskflow/client';
import { colors, radiusCard } from '@taskflow/tokens';
import { plainParagraph } from '@taskflow/api/richtext';
import { apiClient } from '../../../src/lib/app-session.js';
import { apiErrorOf } from '../../../src/lib/trpc-client.js';
import { useSession } from '../../../src/lib/use-session.js';
import { useTopInset } from '../../../src/lib/use-top-inset.js';
import { RichTextView } from '../../../src/lib/rich-text-view.js';
import { messagesQueryKey, type Message } from '../../../src/lib/chat.js';

/**
 * One channel — Wave 3's message thread, read + send only (`chat.ts`'s own
 * header has the full scope line: no reactions, no thread-reply panel, no
 * mentions autocomplete, no push). Composer reuses the identical
 * `plainParagraph` + `RichTextView` pair `card/[cardId].tsx`'s
 * `CommentsSection` already established for Work's comments — the SAME
 * boundary (no native rich text EDITOR yet), the same wire shape
 * (`RichTextDocument`), so the pattern transfers unchanged rather than
 * being rebuilt per domain.
 *
 * `chat.messages.list` returns newest-first (`ORDER BY id DESC`, the
 * `before` cursor's own pagination direction) — reversed here for display,
 * since a chat thread reads oldest-at-top like every chat client. No
 * pagination beyond the first page (`limit`'s default, 50): "load more" is
 * real, separate work, the same class of gap boards' own README section
 * names for drag-and-drop.
 *
 * `KeyboardAvoidingView`'s `behavior` is `'height'` on Android, not
 * `undefined` as originally shipped. That original choice assumed
 * Android's own `windowSoftInputMode` would resize the screen for the
 * keyboard with no help needed — a real device run disproved it directly:
 * the composer was rendering completely behind the keyboard, invisible,
 * with no way to see what was being typed. `'height'` is the standard
 * cross-platform-safe fallback for exactly this — it shrinks this view's
 * own height when the keyboard opens rather than trusting the OS to do it,
 * which does not depend on whichever `windowSoftInputMode` the current
 * build happens to have.
 */
export default function ChannelScreen() {
  const params = useLocalSearchParams<{ channelId: string }>();
  const parsedChannelId = ChannelIdSchema.safeParse(params.channelId);

  if (!parsedChannelId.success) {
    return (
      <View style={styles.center}>
        <Text style={styles.label}>This channel link isn't valid.</Text>
        <BackButton />
      </View>
    );
  }

  return <ChannelContent channelId={parsedChannelId.data} />;
}

function ChannelContent({ channelId }: { channelId: ChannelId }) {
  const queryClient = useQueryClient();
  const userId = useSession((state) => state.userId);
  const [draft, setDraft] = useState('');

  const messages = useQuery({
    queryKey: messagesQueryKey(channelId),
    queryFn: async () => wire(await apiClient.chat.messages.list.query({ channelId })),
  });

  const oldestFirst = useMemo(() => [...(messages.data ?? [])].reverse(), [messages.data]);

  const send = useMutation({
    mutationFn: (body: string) =>
      apiClient.chat.messages.send.mutate({ channelId, body: plainParagraph(body) }),
    onSuccess: async () => {
      setDraft('');
      await queryClient.invalidateQueries({ queryKey: messagesQueryKey(channelId) });
    },
  });
  const paddingTop = useTopInset();

  if (messages.isError) {
    return (
      <View style={styles.center}>
        <Text style={styles.label}>
          {apiErrorOf(messages.error)?.error.message ?? "Couldn't load this channel."}
        </Text>
        <BackButton />
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={[styles.container, { paddingTop }]}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <BackButton />

      <FlatList<Message>
        data={oldestFirst}
        keyExtractor={(message) => message.messageId}
        renderItem={({ item }) => <MessageRow message={item} isOwn={item.authorId === userId} />}
        contentContainerStyle={styles.list}
        style={styles.listContainer}
        ListEmptyComponent={
          messages.isPending ? (
            <ActivityIndicator color={colors.accent.hex} />
          ) : (
            <Text style={styles.label}>No messages yet.</Text>
          )
        }
      />

      <View style={styles.composerRow}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          placeholder="Message…"
          placeholderTextColor={colors.inkFaint.hex}
          style={styles.composerInput}
          multiline
        />
        <Pressable
          style={styles.sendButton}
          disabled={draft.trim().length === 0 || send.isPending}
          onPress={() => {
            send.mutate(draft.trim());
          }}
        >
          {send.isPending ? (
            <ActivityIndicator color={colors.accentInk.hex} />
          ) : (
            <Text style={styles.sendButtonText}>Send</Text>
          )}
        </Pressable>
      </View>
      {send.isError && (
        <Text style={styles.error} accessibilityRole="alert">
          {apiErrorOf(send.error)?.error.message ?? 'The message was not sent.'}
        </Text>
      )}
    </KeyboardAvoidingView>
  );
}

function MessageRow({ message, isOwn }: { readonly message: Message; readonly isOwn: boolean }) {
  return (
    <View style={styles.messageRow}>
      <View style={styles.messageMeta}>
        <Text style={styles.messageAuthor}>{isOwn ? 'You' : 'Member'}</Text>
        <Text style={styles.messageTime}>
          {formatDistanceToNow(new Date(message.createdAt), { addSuffix: true })}
        </Text>
      </View>
      {message.deletedAt !== null ? (
        <Text style={styles.messageDeleted}>Message deleted</Text>
      ) : (
        <RichTextView document={message.body} />
      )}
    </View>
  );
}

function BackButton() {
  return (
    <Pressable
      style={styles.backButton}
      onPress={() => {
        router.back();
      }}
    >
      <Text style={styles.backButtonText}>← Back</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.surface.hex,
    paddingHorizontal: 24,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
    padding: 24,
    backgroundColor: colors.surface.hex,
  },
  backButton: {
    alignSelf: 'flex-start',
    marginBottom: 8,
  },
  backButtonText: {
    color: colors.accent.hex,
    fontSize: 15,
    fontWeight: '600',
  },
  listContainer: {
    flex: 1,
  },
  list: {
    gap: 14,
    paddingBottom: 12,
  },
  messageRow: {
    gap: 3,
  },
  messageMeta: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'baseline',
  },
  messageAuthor: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.ink.hex,
  },
  messageTime: {
    fontSize: 12,
    color: colors.inkFaint.hex,
  },
  messageDeleted: {
    fontSize: 13,
    fontStyle: 'italic',
    color: colors.inkFaint.hex,
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
  label: {
    fontSize: 14,
    color: colors.inkMuted.hex,
    textAlign: 'center',
  },
  error: {
    color: colors.danger.hex,
    fontSize: 13,
    marginBottom: 8,
  },
});
