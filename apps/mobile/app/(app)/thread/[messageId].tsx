import { useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import {
  ChannelIdSchema,
  MessageIdSchema,
  type ChannelId,
  type MessageId,
} from '@taskflow/contracts';
import { wire } from '@taskflow/client';
import { colors } from '@taskflow/tokens';
import { apiClient } from '../../../src/lib/app-session.js';
import { apiErrorOf } from '../../../src/lib/trpc-client.js';
import { useSession } from '../../../src/lib/use-session.js';
import { useTopInset } from '../../../src/lib/use-top-inset.js';
import { RichTextView } from '../../../src/lib/rich-text-view.js';
import { Avatar } from '../../../src/lib/avatar.js';
import { useMembers } from '../../../src/lib/use-members.js';
import { parseFormattedText } from '../../../src/lib/rich-text-compose.js';
import { MessageComposer } from '../../../src/lib/message-composer.js';
import {
  channelQueryKey,
  messagesQueryKey,
  threadQueryKey,
  type Message,
} from '../../../src/lib/chat.js';

/**
 * A message's thread — the root plus its replies, one level deep
 * (`message.service.ts`'s own limit: a reply cannot itself be replied to,
 * so a reply's own long-press menu in `channel/[channelId].tsx` never
 * offers "Reply in thread" — gated there on `parentMessageId === null`).
 * Mirrors `apps/web`'s `ThreadPanel`, as a pushed screen instead of a
 * right-hand panel — this app has no side-by-side layout to spare.
 *
 * **The root comes from `channel/[channelId].tsx`'s already-loaded
 * `messages.list` query, not a second fetch.** Reaching this screen is
 * always a push FROM the channel screen, which stays mounted underneath in
 * the navigation stack (`(app)/_layout.tsx`'s real `<Stack>` — see that
 * file's own header), so `messagesQueryKey(channelId)` is a cache hit: the
 * same reasoning web's own header gives for reading `rootMessage` off the
 * page already on screen rather than re-requesting a message the caller is
 * already looking at. `messageId` and `channelId` both arrive as route
 * params (`router.push({ pathname, params })`, not a single dynamic
 * segment) because a thread has no meaning without knowing which channel's
 * cache to read.
 *
 * **No reactions, edit, delete, or "remove for me" on a reply, matching
 * web's own `ThreadPanel` exactly** — that is web's actual scope, not a
 * mobile-only gap: web's `renderPlain` inside `ThreadPanel` draws the
 * identical bare author/timestamp/body/"edited" row with no per-message
 * controls at all. A reply is still POSTED through the same `message:create`
 * permission and the same `RichTextDocument` whitelist as any other
 * message; only the read side is deliberately simpler here.
 */
export default function ThreadScreen() {
  const params = useLocalSearchParams<{ messageId: string; channelId: string }>();
  const parsedMessageId = MessageIdSchema.safeParse(params.messageId);
  const parsedChannelId = ChannelIdSchema.safeParse(params.channelId);

  if (!parsedMessageId.success || !parsedChannelId.success) {
    return (
      <View style={styles.center}>
        <Text style={styles.label}>This thread link isn't valid.</Text>
        <BackButton />
      </View>
    );
  }

  return <ThreadContent messageId={parsedMessageId.data} channelId={parsedChannelId.data} />;
}

function ThreadContent({ messageId, channelId }: { messageId: MessageId; channelId: ChannelId }) {
  const queryClient = useQueryClient();
  const userId = useSession((state) => state.userId);
  const { personOf, people } = useMembers();
  const [draft, setDraft] = useState('');
  const [pendingMentions, setPendingMentions] = useState<
    readonly { readonly userId: string; readonly label: string }[]
  >([]);

  const messages = useQuery({
    queryKey: messagesQueryKey(channelId),
    queryFn: async () => wire(await apiClient.chat.messages.list.query({ channelId })),
  });
  const root = messages.data?.find((message) => message.messageId === messageId) ?? null;

  const channel = useQuery({
    queryKey: channelQueryKey(channelId),
    queryFn: () => apiClient.chat.channels.get.query({ channelId }),
  });
  const canPost = channel.data?.capabilities.post === true && channel.data.archivedAt === null;

  const replies = useQuery({
    queryKey: threadQueryKey(messageId),
    queryFn: async () => wire(await apiClient.chat.messages.thread.query({ messageId })),
  });

  const reply = useMutation({
    mutationFn: (body: ReturnType<typeof parseFormattedText>) =>
      apiClient.chat.messages.send.mutate({ channelId, body, parentMessageId: messageId }),
    onSuccess: async () => {
      setDraft('');
      setPendingMentions([]);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: threadQueryKey(messageId) }),
        queryClient.invalidateQueries({ queryKey: messagesQueryKey(channelId) }),
      ]);
    },
  });

  const paddingTop = useTopInset();

  if (root === null && !messages.isPending) {
    return (
      <View style={styles.center}>
        <Text style={styles.label}>
          {apiErrorOf(messages.error)?.error.message ?? "This message couldn't be found."}
        </Text>
        <BackButton />
      </View>
    );
  }

  const rows: readonly Message[] = root === null ? [] : [root, ...(replies.data ?? [])];

  return (
    <KeyboardAvoidingView
      style={[styles.container, { paddingTop }]}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <View style={styles.header}>
        <BackButton />
        <Text style={styles.headerTitle}>Thread</Text>
      </View>

      <FlatList<Message>
        data={rows}
        keyExtractor={(message) => message.messageId}
        renderItem={({ item, index }) => (
          <ThreadMessageRow
            message={item}
            viewerId={userId}
            personOf={personOf}
            isRoot={index === 0}
          />
        )}
        contentContainerStyle={styles.list}
        style={styles.listContainer}
        ListEmptyComponent={
          messages.isPending || replies.isPending ? (
            <ActivityIndicator color={colors.accent.hex} />
          ) : null
        }
      />

      {canPost && root !== null && (
        <MessageComposer
          draft={draft}
          onDraftChange={setDraft}
          people={people}
          viewerId={userId}
          onMentionRecorded={(mention) => {
            setPendingMentions((current) => [...current, mention]);
          }}
          onSubmit={() => {
            reply.mutate(parseFormattedText(draft.trim(), pendingMentions));
          }}
          sending={reply.isPending}
          error={reply.isError ? reply.error : null}
          placeholder="Reply in thread…"
          fallbackError="The reply was not sent."
        />
      )}
    </KeyboardAvoidingView>
  );
}

function ThreadMessageRow({
  message,
  viewerId,
  personOf,
  isRoot,
}: {
  readonly message: Message;
  readonly viewerId: string | null;
  readonly personOf: (userId: string) => { readonly label: string };
  readonly isRoot: boolean;
}) {
  const isOwn = message.authorId !== null && message.authorId === viewerId;
  const authorLabel = message.authorId === null ? 'Unknown' : personOf(message.authorId).label;

  return (
    <View style={[styles.row, isRoot && styles.rootRow]}>
      <Avatar label={authorLabel} />
      <View style={styles.rowBody}>
        <View style={styles.rowHeader}>
          <Text style={styles.rowAuthor}>{isOwn ? 'You' : authorLabel}</Text>
          <Text style={styles.rowTime}>
            {formatDistanceToNow(new Date(message.createdAt), { addSuffix: true })}
          </Text>
        </View>
        {message.deletedAt !== null ? (
          <Text style={styles.messageDeleted}>Message deleted</Text>
        ) : (
          <>
            <RichTextView document={message.body} />
            {message.editedAt !== null && <Text style={styles.editedTag}>edited</Text>}
          </>
        )}
      </View>
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
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingBottom: 8,
  },
  backButton: {
    alignSelf: 'flex-start',
  },
  backButtonText: {
    color: colors.accent.hex,
    fontSize: 15,
    fontWeight: '600',
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: colors.ink.hex,
  },
  listContainer: {
    flex: 1,
  },
  list: {
    gap: 16,
    paddingBottom: 12,
  },
  row: {
    flexDirection: 'row',
    gap: 10,
  },
  rootRow: {
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.line.hex,
  },
  rowBody: {
    flex: 1,
    gap: 4,
  },
  rowHeader: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'baseline',
  },
  rowAuthor: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.ink.hex,
  },
  rowTime: {
    fontSize: 12,
    color: colors.inkFaint.hex,
  },
  messageDeleted: {
    fontSize: 13,
    fontStyle: 'italic',
    color: colors.inkFaint.hex,
  },
  editedTag: {
    fontSize: 11,
    fontStyle: 'italic',
    color: colors.inkFaint.hex,
  },
  label: {
    fontSize: 14,
    color: colors.inkMuted.hex,
    textAlign: 'center',
  },
});
