import { useMemo, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
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
import { apiClient } from '../../../src/lib/app-session.js';
import { apiErrorOf } from '../../../src/lib/trpc-client.js';
import { useSession } from '../../../src/lib/use-session.js';
import { useTopInset } from '../../../src/lib/use-top-inset.js';
import { RichTextView } from '../../../src/lib/rich-text-view.js';
import { Avatar } from '../../../src/lib/avatar.js';
import { useMembers } from '../../../src/lib/use-members.js';
import {
  buildMessageBody,
  activeMentionQuery,
  insertMention,
} from '../../../src/lib/message-compose.js';
import {
  channelDisplayName,
  groupMessages,
  groupReactions,
  messagesQueryKey,
  reactionsQueryKey,
  QUICK_REACTIONS,
  type Message,
  type MessageGroup,
} from '../../../src/lib/chat.js';

/**
 * One channel — Wave 3's message thread. A real device video review found
 * the ORIGINAL version of this screen (no grouping, "You"/"Member" author
 * labels, no header, no reactions, no mentions) "very messy... not like
 * web has" and named specific gaps; this is the redesign that closes them.
 * Still deliberately not the whole of Wave 3 — see below for what remains
 * out of scope.
 *
 * **Grouping, real names, and a real header** all come from the same
 * underlying fix: `use-members.ts`'s `personOf`/`peopleOf` lookup, wired in
 * for the first time on this screen (`chat.ts`'s `groupMessages` collapses
 * consecutive same-author messages the way `apps/web`'s own message list
 * does — one author line per group, not one per message). The header now
 * fetches `chat.channels.get` for the first time on this screen too — a
 * channel's real name/topic and, for a DM, `channelDisplayName`'s
 * participant-based title, where nothing rendered a title at all before.
 *
 * **`capabilities.post` gates the composer, never a role check** —
 * `channels.get`'s own `capabilities` field is the server's `can()`
 * verdict, the identical pattern `(tabs)/boards.tsx`'s create buttons
 * follow. An archived channel or a read-only tuple (`commenter`-shaped
 * access) now shows no composer at all instead of one that would 403 on
 * send — one of the very first gaps this app's review named ("not all
 * things what web has as per roles... this is throughout the app").
 *
 * **Reactions**: `chat.messages.reactions` fetched CHUNKED (25 ids per
 * dispatch), mirroring `apps/web/src/features/chat/api.ts`'s own
 * `reactionsQuery` — a single dispatch carrying this screen's ~50 loaded
 * message ids is close enough to `trpc-client.ts`'s `maxURLLength` ceiling
 * that web hit the "Input is too big for a single dispatch" failure for
 * real; the same ceiling applies to this app's identical `httpBatchLink`
 * config. The query key is deliberately STABLE (no `messageIds` in it) for
 * the same reason web's own header gives: a key carrying a fresh array
 * reference every render restarts the fetch every render and the bar under
 * each message never settles. Tapping an existing pill toggles the
 * viewer's own reaction directly; long-pressing a message opens the same
 * six-emoji quick-react row web offers (`QUICK_REACTIONS` — chat's
 * reaction picker is not a full emoji keyboard on EITHER platform).
 *
 * **Mentions**: rendering already existed (`rich-text-view.tsx`'s `case
 * 'mention'` predates this screen) — what was missing was a way to COMPOSE
 * one. `message-compose.ts`'s own header has the full design: typing a
 * trailing `@query` opens a dropdown of matching members, picking one
 * inserts literal `@Label ` text and records the pick, and
 * `buildMessageBody` turns the recorded picks into real `mention` nodes at
 * send time — the bounded substitute for not having a real rich text
 * editor to track a live cursor/selection with.
 *
 * **Still explicitly out of scope, all real and separate work**: thread
 * replies (`chat.messages.thread` has no caller here), edit/delete,
 * mentions AUTOCOMPLETE beyond the trailing-query case above (mid-string
 * insertion needs a real editor), typing indicators, read receipts, file
 * attachments, link unfurls, and push.
 *
 * `chat.messages.list` returns newest-first (`ORDER BY id DESC`) —
 * reversed here for display, since a chat thread reads oldest-at-top.
 *
 * `KeyboardAvoidingView`'s Android `behavior` is `'height'`, not
 * `undefined` — found broken against a real device (the composer rendered
 * fully behind the open keyboard); see the mobile README's own bug-fix
 * section for the full account.
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
  const { personOf, people } = useMembers();
  const [draft, setDraft] = useState('');
  const [pendingMentions, setPendingMentions] = useState<
    readonly { readonly userId: string; readonly label: string }[]
  >([]);
  const [reactingTo, setReactingTo] = useState<Message | null>(null);

  const channel = useQuery({
    queryKey: ['chat.channels.get', channelId],
    queryFn: () => apiClient.chat.channels.get.query({ channelId }),
  });

  const messages = useQuery({
    queryKey: messagesQueryKey(channelId),
    queryFn: async () => wire(await apiClient.chat.messages.list.query({ channelId })),
  });

  const oldestFirst = useMemo(() => [...(messages.data ?? [])].reverse(), [messages.data]);
  const groups = useMemo(() => groupMessages(oldestFirst), [oldestFirst]);
  const messageIds = useMemo(() => oldestFirst.map((message) => message.messageId), [oldestFirst]);

  const reactions = useQuery({
    queryKey: reactionsQueryKey(channelId),
    queryFn: async () => {
      const CHUNK = 25;
      const rows: { messageId: string; userId: string; emoji: string }[] = [];
      for (let index = 0; index < messageIds.length; index += CHUNK) {
        const part = messageIds.slice(index, index + CHUNK);
        if (part.length === 0) continue;
        rows.push(
          ...(await apiClient.chat.messages.reactions.query({ channelId, messageIds: part })),
        );
      }
      return rows;
    },
    enabled: messageIds.length > 0,
  });
  const reactionsByMessage = useMemo(() => groupReactions(reactions.data ?? []), [reactions.data]);

  const send = useMutation({
    mutationFn: (body: ReturnType<typeof buildMessageBody>) =>
      apiClient.chat.messages.send.mutate({ channelId, body }),
    onSuccess: async () => {
      setDraft('');
      setPendingMentions([]);
      await queryClient.invalidateQueries({ queryKey: messagesQueryKey(channelId) });
    },
  });

  const react = useMutation({
    mutationFn: (input: { messageId: string; emoji: string }) =>
      apiClient.chat.messages.react.mutate({ channelId, ...input }),
    onSuccess: async () => {
      setReactingTo(null);
      await queryClient.invalidateQueries({ queryKey: reactionsQueryKey(channelId) });
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

  const title =
    channel.data === undefined
      ? '…'
      : channelDisplayName(
          {
            name: channel.data.name,
            type: channel.data.type,
            participantIds: channel.data.memberIds,
          },
          userId,
          personOf,
        );
  const canPost = channel.data?.capabilities.post === true && channel.data.archivedAt === null;

  const mentionQuery = activeMentionQuery(draft);
  const mentionCandidates =
    mentionQuery === null
      ? []
      : people
          .filter((member) => member.userId !== userId)
          .filter((member) =>
            (member.displayName ?? member.email).toLowerCase().includes(mentionQuery.toLowerCase()),
          )
          .slice(0, 6);

  return (
    <KeyboardAvoidingView
      style={[styles.container, { paddingTop }]}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <View style={styles.header}>
        <BackButton />
        <View style={styles.headerTitles}>
          <Text style={styles.headerTitle} numberOfLines={1}>
            {channel.data?.type === 'public' || channel.data?.type === 'private'
              ? `# ${title}`
              : title}
          </Text>
          {channel.data?.archivedAt !== null && channel.data?.archivedAt !== undefined ? (
            <Text style={styles.headerSubtitle}>Archived — no new messages can be posted.</Text>
          ) : channel.data?.topic !== null && channel.data?.topic !== undefined ? (
            <Text style={styles.headerSubtitle} numberOfLines={1}>
              {channel.data.topic}
            </Text>
          ) : null}
        </View>
      </View>

      <FlatList<MessageGroup>
        data={groups}
        keyExtractor={(group, index) => `${group.authorId ?? 'unknown'}-${String(index)}`}
        renderItem={({ item }) => (
          <MessageGroupRow
            group={item}
            viewerId={userId}
            personOf={personOf}
            reactionsByMessage={reactionsByMessage}
            onTogglePill={(messageId, emoji) => {
              react.mutate({ messageId, emoji });
            }}
            onLongPressMessage={setReactingTo}
          />
        )}
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

      {canPost && (
        <>
          {mentionQuery !== null && mentionCandidates.length > 0 && (
            <ScrollView style={styles.mentionList} keyboardShouldPersistTaps="handled">
              {mentionCandidates.map((member) => (
                <Pressable
                  key={member.userId}
                  style={styles.mentionRow}
                  onPress={() => {
                    const label = member.displayName ?? member.email;
                    const result = insertMention(draft, { userId: member.userId, label });
                    setDraft(result.draft);
                    setPendingMentions((current) => [...current, result.mention]);
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
                send.mutate(buildMessageBody(draft.trim(), pendingMentions));
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
        </>
      )}

      <Modal
        visible={reactingTo !== null}
        transparent
        animationType="fade"
        onRequestClose={() => {
          setReactingTo(null);
        }}
      >
        <Pressable
          style={styles.modalBackdrop}
          onPress={() => {
            setReactingTo(null);
          }}
        >
          <Pressable style={styles.reactionSheet} onPress={() => undefined}>
            {QUICK_REACTIONS.map((emoji) => (
              <Pressable
                key={emoji}
                style={styles.reactionOption}
                onPress={() => {
                  if (reactingTo) react.mutate({ messageId: reactingTo.messageId, emoji });
                }}
              >
                <Text style={styles.reactionOptionText}>{emoji}</Text>
              </Pressable>
            ))}
          </Pressable>
        </Pressable>
      </Modal>
    </KeyboardAvoidingView>
  );
}

function MessageGroupRow({
  group,
  viewerId,
  personOf,
  reactionsByMessage,
  onTogglePill,
  onLongPressMessage,
}: {
  readonly group: MessageGroup;
  readonly viewerId: string | null;
  readonly personOf: (userId: string) => { readonly label: string };
  readonly reactionsByMessage: Map<string, Map<string, string[]>>;
  readonly onTogglePill: (messageId: string, emoji: string) => void;
  readonly onLongPressMessage: (message: Message) => void;
}) {
  const first = group.messages[0];
  if (!first) return null;
  const isOwn = group.authorId === viewerId;
  const authorLabel = group.authorId === null ? 'Unknown' : personOf(group.authorId).label;

  return (
    <View style={styles.groupRow}>
      <Avatar label={authorLabel} />
      <View style={styles.groupBody}>
        <View style={styles.groupHeader}>
          <Text style={styles.groupAuthor}>{isOwn ? 'You' : authorLabel}</Text>
          <Text style={styles.groupTime}>
            {formatDistanceToNow(new Date(first.createdAt), { addSuffix: true })}
          </Text>
        </View>
        {group.messages.map((message) => {
          const reactions = reactionsByMessage.get(message.messageId);
          return (
            <Pressable
              key={message.messageId}
              onLongPress={() => {
                onLongPressMessage(message);
              }}
              style={styles.messageBody}
            >
              {message.deletedAt !== null ? (
                <Text style={styles.messageDeleted}>Message deleted</Text>
              ) : (
                <RichTextView document={message.body} />
              )}
              {reactions && reactions.size > 0 && (
                <View style={styles.reactionBar}>
                  {[...reactions.entries()].map(([emoji, userIds]) => {
                    const mine = viewerId !== null && userIds.includes(viewerId);
                    return (
                      <Pressable
                        key={emoji}
                        style={[styles.reactionPill, mine && styles.reactionPillMine]}
                        onPress={() => {
                          onTogglePill(message.messageId, emoji);
                        }}
                      >
                        <Text style={styles.reactionPillText}>
                          {emoji} {userIds.length}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              )}
            </Pressable>
          );
        })}
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
    gap: 4,
    paddingBottom: 8,
  },
  backButton: {
    alignSelf: 'flex-start',
    marginBottom: 4,
  },
  backButtonText: {
    color: colors.accent.hex,
    fontSize: 15,
    fontWeight: '600',
  },
  headerTitles: {
    gap: 1,
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: colors.ink.hex,
  },
  headerSubtitle: {
    fontSize: 12,
    color: colors.inkFaint.hex,
  },
  listContainer: {
    flex: 1,
  },
  list: {
    gap: 16,
    paddingBottom: 12,
  },
  groupRow: {
    flexDirection: 'row',
    gap: 10,
  },
  groupBody: {
    flex: 1,
    gap: 4,
  },
  groupHeader: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'baseline',
  },
  groupAuthor: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.ink.hex,
  },
  groupTime: {
    fontSize: 12,
    color: colors.inkFaint.hex,
  },
  messageBody: {
    gap: 6,
  },
  messageDeleted: {
    fontSize: 13,
    fontStyle: 'italic',
    color: colors.inkFaint.hex,
  },
  reactionBar: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  reactionPill: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.line.hex,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
    backgroundColor: colors.surfaceRaised.hex,
  },
  reactionPillMine: {
    borderColor: colors.accent.hex,
    backgroundColor: colors.accent.hex + '22',
  },
  reactionPillText: {
    fontSize: 12,
    color: colors.inkMuted.hex,
  },
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
  modalBackdrop: {
    flex: 1,
    backgroundColor: '#00000099',
    justifyContent: 'flex-end',
  },
  reactionSheet: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    backgroundColor: colors.surfaceRaised.hex,
    borderTopLeftRadius: radiusCard,
    borderTopRightRadius: radiusCard,
    padding: 20,
  },
  reactionOption: {
    padding: 8,
  },
  reactionOptionText: {
    fontSize: 28,
  },
});
