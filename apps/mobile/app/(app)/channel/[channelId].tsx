import { useEffect, useMemo, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Linking,
  Modal,
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
import { plainParagraph } from '@taskflow/api/richtext';
import { colors, radiusCard } from '@taskflow/tokens';
import { apiClient, chatSocket } from '../../../src/lib/app-session.js';
import { apiErrorOf } from '../../../src/lib/trpc-client.js';
import { useSession } from '../../../src/lib/use-session.js';
import { useTopInset } from '../../../src/lib/use-top-inset.js';
import { RichTextView } from '../../../src/lib/rich-text-view.js';
import { Avatar } from '../../../src/lib/avatar.js';
import { useMembers, type Member } from '../../../src/lib/use-members.js';
import { buildMessageBody, insertMention } from '../../../src/lib/message-compose.js';
import { MessageComposer } from '../../../src/lib/message-composer.js';
import { useChatRoom } from '../../../src/lib/use-chat-room.js';
import {
  channelDisplayName,
  channelQueryKey,
  describeTyping,
  groupMessages,
  groupPreviews,
  groupReactions,
  messagesQueryKey,
  pinsQueryKey,
  reactionsQueryKey,
  replyCountsOf,
  unfurlsQueryKey,
  QUICK_REACTIONS,
  type Message,
  type MessageGroup,
  type UnfurlPreview,
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
 * **The header opens Details, and long-pressing a message now offers
 * "Pin"** alongside the quick-react row — the two gaps a second real device
 * review named directly ("where to see details... members... where to add
 * members"). `channel-details/[channelId].tsx` is the screen; PINNING lives
 * here (on the message), UNPINNING lives there (in the list) — the same
 * split `apps/web`'s message row and details panel draw.
 *
 * **Thread replies, edit, and delete/"remove for me" close most of the
 * remaining Wave-3 message-action gap.** `chat.messages.list` returns EVERY
 * message in the page — roots and replies together — so the list here is
 * filtered to `parentMessageId === null` (`topLevel`) exactly the way
 * `apps/web`'s own `chat-page.tsx` filters its `topLevel`; without it, a
 * reply would render twice, once inline here and once in its thread.
 * `replyCountsOf` (`chat.ts`) is the same "count by parent id" computation
 * web makes inline, over the SAME already-loaded page — no second query.
 * Tapping "N replies" pushes `thread/[messageId].tsx`, which owns the
 * reply composer and the one-level-deep reply list; see that screen's own
 * header for why it has no message actions of its own (mirroring web's
 * `ThreadPanel`, which has none either).
 *
 * Edit is AUTHOR-ONLY with no server override — same reasoning as Work's
 * comments (CLAUDE.md §8.2) and `apps/web`'s own message toolbar: nobody
 * else's edit would ever succeed, so the option is hidden rather than
 * shown-and-refused. It reuses `plainParagraph`, not `buildMessageBody` —
 * an edit does not re-open mention composing, the same boundary
 * `card/[cardId].tsx`'s comment composer draws. Delete is two actions,
 * Slack-style: "Remove for me" (`chat.messages.hide`, `message:read`,
 * offered to everyone) only changes the viewer's own list; "Delete for
 * everyone" is author OR moderation, gated on `channel.data.capabilities.
 * moderate` — the server's own verdict, never a role check — and hidden
 * rather than shown-and-refused for the same reason edit is.
 *
 * **The composer is now the shared `<MessageComposer />`** (`message-
 * composer.tsx`) — extracted once `thread/[messageId].tsx` needed the
 * identical TextInput-plus-mention-dropdown block this screen already had;
 * see that component's own header for the ownership split.
 *
 * **Read receipts: this screen ADVANCES the cursor; `(tabs)/chat.tsx`
 * DISPLAYS the badge.** Mirrors `apps/web`'s own split exactly — a
 * `useEffect` here calls `chat.channels.markRead` whenever the newest
 * TOP-LEVEL message id changes (opening the channel, sending, or a refetch
 * picking up someone else's new message), no socket required. `markRead`
 * itself refuses to move the cursor backward, so re-firing on every render
 * of the same last id is safe — the effect's dependency is the id, not a
 * one-shot mount flag. No "new messages" divider (web's own `entryCursor`/
 * `firstUnreadAfter` machinery) — a real but separate refinement; this
 * increment closes the badge, not the divider.
 *
 * **Typing indicators and live broadcast-driven refresh** come from
 * `use-chat-room.ts`, mounted here for the first time — see that hook's own
 * header. It joins the `/chat` namespace's room for this channel (the same
 * connection typing needs anyway to receive `typing` events at all), so a
 * message someone else sends, an edit, a reaction, or a pin now appears
 * without a manual pull-to-refresh, not just the typing label itself.
 * `startTyping` fires on every composer keystroke, no debounce — matching
 * `apps/web/src/features/chat/chat-page.tsx`'s own composer exactly —  and
 * `stopTyping` fires right before the message actually sends. Scoped to the
 * main composer only, mirroring web: `thread/[messageId].tsx`'s reply
 * composer does not wire typing either there or here.
 *
 * **Still explicitly out of scope, all real and separate work**: mentions
 * AUTOCOMPLETE beyond the trailing-query case above (mid-string insertion
 * needs a real editor), and file ATTACHING from the composer (the details
 * screen's Files section can list and download what is already there).
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
  const orgId = useSession((state) => state.orgId);
  const { personOf, people } = useMembers();
  const { typingUserIds } = useChatRoom(orgId, channelId, userId);
  const typingLabel = describeTyping(typingUserIds, personOf);
  const [draft, setDraft] = useState('');
  const [pendingMentions, setPendingMentions] = useState<
    readonly { readonly userId: string; readonly label: string }[]
  >([]);
  const [actionsFor, setActionsFor] = useState<Message | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');

  const channel = useQuery({
    queryKey: channelQueryKey(channelId),
    queryFn: () => apiClient.chat.channels.get.query({ channelId }),
  });

  const messages = useQuery({
    queryKey: messagesQueryKey(channelId),
    queryFn: async () => wire(await apiClient.chat.messages.list.query({ channelId })),
  });

  const oldestFirst = useMemo(() => [...(messages.data ?? [])].reverse(), [messages.data]);
  // Replies live in the same page as their root (`chat.messages.list` does
  // not separate them) but render inside `thread/[messageId].tsx`, not
  // here — see this file's own header on why filtering to `topLevel`
  // matters once replies exist at all.
  const topLevel = useMemo(
    () => oldestFirst.filter((message) => message.parentMessageId === null),
    [oldestFirst],
  );
  const groups = useMemo(() => groupMessages(topLevel), [topLevel]);
  const replyCounts = useMemo(() => replyCountsOf(oldestFirst), [oldestFirst]);
  const messageIds = useMemo(() => oldestFirst.map((message) => message.messageId), [oldestFirst]);

  const markRead = useMutation({
    mutationFn: (messageId: string) =>
      apiClient.chat.channels.markRead.mutate({ channelId, messageId }),
    onSuccess: async () => {
      // The bare prefix, not `unreadCountsQueryKey(someArray)` — see that
      // function's own header on why a shorter key invalidates every
      // longer one TanStack Query has cached under it.
      await queryClient.invalidateQueries({ queryKey: ['chat.channels.unreadCounts'] });
    },
  });
  const lastTopLevelId = topLevel.at(-1)?.messageId;
  useEffect(() => {
    if (lastTopLevelId === undefined) return;
    markRead.mutate(lastTopLevelId);
  }, [lastTopLevelId]);

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

  const previews = useQuery({
    queryKey: unfurlsQueryKey(channelId),
    queryFn: async () => {
      const CHUNK = 25;
      const rows: UnfurlPreview[] = [];
      for (let index = 0; index < messageIds.length; index += CHUNK) {
        const part = messageIds.slice(index, index + CHUNK);
        if (part.length === 0) continue;
        rows.push(
          ...wire(await apiClient.chat.unfurls.list.query({ channelId, messageIds: part })),
        );
      }
      return rows;
    },
    enabled: messageIds.length > 0,
  });
  const previewsByMessage = useMemo(() => groupPreviews(previews.data ?? []), [previews.data]);

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
      setActionsFor(null);
      await queryClient.invalidateQueries({ queryKey: reactionsQueryKey(channelId) });
    },
  });

  // The other half of the details screen's "Pinned" section, which can only
  // unpin — pinning happens here, from the message itself, the same split
  // apps/web draws between a message's own controls and the panel that lists
  // the results.
  const pin = useMutation({
    mutationFn: (messageId: string) => apiClient.chat.messages.pin.mutate({ channelId, messageId }),
    onSuccess: async () => {
      setActionsFor(null);
      await queryClient.invalidateQueries({ queryKey: pinsQueryKey(channelId) });
    },
  });

  const edit = useMutation({
    mutationFn: (input: { messageId: string; text: string }) =>
      apiClient.chat.messages.edit.mutate({
        messageId: input.messageId,
        body: plainParagraph(input.text),
      }),
    onSuccess: async () => {
      setEditingId(null);
      await queryClient.invalidateQueries({ queryKey: messagesQueryKey(channelId) });
    },
  });

  // "Remove for me" — no tombstone, no event: the message stays live for
  // everyone else and this viewer's next refetch simply stops returning it.
  const hide = useMutation({
    mutationFn: (messageId: string) => apiClient.chat.messages.hide.mutate({ messageId }),
    onSuccess: async () => {
      setActionsFor(null);
      await queryClient.invalidateQueries({ queryKey: messagesQueryKey(channelId) });
    },
  });

  // "Delete for everyone" — author OR moderation; the service decides which
  // permission applies once it knows the author, so the client sends the
  // same route either way and the "Delete" option is hidden (not shown and
  // refused) for anyone who is neither.
  const remove = useMutation({
    mutationFn: (messageId: string) => apiClient.chat.messages.delete.mutate({ messageId }),
    onSuccess: async () => {
      setActionsFor(null);
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
  const canModerate = channel.data?.capabilities.moderate === true;

  return (
    <KeyboardAvoidingView
      style={[styles.container, { paddingTop }]}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <View style={styles.header}>
        <BackButton />
        {/* The whole title block opens Details — mirroring apps/web's header,
            where clicking the channel name is how the roster/settings panel
            opens. Found missing entirely by a real device review ("where to
            see details... members... where to add members"). */}
        <Pressable
          style={styles.headerTitles}
          onPress={() => {
            router.push(`/channel-details/${channelId}`);
          }}
        >
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
          ) : (
            <Text style={styles.headerSubtitle}>Details</Text>
          )}
        </Pressable>
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
            previewsByMessage={previewsByMessage}
            replyCounts={replyCounts}
            editingId={editingId}
            editDraft={editDraft}
            onEditDraftChange={setEditDraft}
            editPending={edit.isPending}
            onSaveEdit={(messageId) => {
              if (editDraft.trim().length === 0) return;
              edit.mutate({ messageId, text: editDraft.trim() });
            }}
            onCancelEdit={() => {
              setEditingId(null);
            }}
            onTogglePill={(messageId, emoji) => {
              react.mutate({ messageId, emoji });
            }}
            onLongPressMessage={setActionsFor}
            onOpenThread={(message) => {
              router.push({
                pathname: '/thread/[messageId]',
                params: { messageId: message.messageId, channelId },
              });
            }}
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

      {typingLabel !== null && <Text style={styles.typingLabel}>{typingLabel}</Text>}

      {canPost && (
        <MessageComposer
          draft={draft}
          onDraftChange={(text) => {
            setDraft(text);
            chatSocket.startTyping(channelId);
          }}
          people={people}
          viewerId={userId}
          onPickMention={(member: Member) => {
            const label = member.displayName ?? member.email;
            const result = insertMention(draft, { userId: member.userId, label });
            setDraft(result.draft);
            setPendingMentions((current) => [...current, result.mention]);
          }}
          onSubmit={() => {
            chatSocket.stopTyping(channelId);
            send.mutate(buildMessageBody(draft.trim(), pendingMentions));
          }}
          sending={send.isPending}
          error={send.isError ? send.error : null}
          placeholder="Message…"
          fallbackError="The message was not sent."
        />
      )}

      <Modal
        visible={actionsFor !== null}
        transparent
        animationType="fade"
        onRequestClose={() => {
          setActionsFor(null);
        }}
      >
        <Pressable
          style={styles.modalBackdrop}
          onPress={() => {
            setActionsFor(null);
          }}
        >
          <Pressable style={styles.reactionSheetCard} onPress={() => undefined}>
            <View style={styles.reactionSheet}>
              {QUICK_REACTIONS.map((emoji) => (
                <Pressable
                  key={emoji}
                  style={styles.reactionOption}
                  onPress={() => {
                    if (actionsFor) react.mutate({ messageId: actionsFor.messageId, emoji });
                  }}
                >
                  <Text style={styles.reactionOptionText}>{emoji}</Text>
                </Pressable>
              ))}
            </View>
            {canPost && actionsFor?.parentMessageId === null && (
              <Pressable
                style={styles.actionOption}
                onPress={() => {
                  router.push({
                    pathname: '/thread/[messageId]',
                    params: { messageId: actionsFor.messageId, channelId },
                  });
                  setActionsFor(null);
                }}
              >
                <Text style={styles.actionOptionText}>💬 Reply in thread</Text>
              </Pressable>
            )}
            <Pressable
              style={styles.actionOption}
              disabled={pin.isPending}
              onPress={() => {
                if (actionsFor) pin.mutate(actionsFor.messageId);
              }}
            >
              <Text style={styles.actionOptionText}>📌 Pin this message</Text>
            </Pressable>
            {actionsFor?.authorId === userId && (
              <Pressable
                style={styles.actionOption}
                onPress={() => {
                  setEditingId(actionsFor.messageId);
                  setEditDraft(actionsFor.bodyText);
                  setActionsFor(null);
                }}
              >
                <Text style={styles.actionOptionText}>✏️ Edit</Text>
              </Pressable>
            )}
            <Pressable
              style={styles.actionOption}
              disabled={hide.isPending}
              onPress={() => {
                if (actionsFor) hide.mutate(actionsFor.messageId);
              }}
            >
              <Text style={styles.actionOptionText}>🙈 Remove for me</Text>
            </Pressable>
            {(actionsFor?.authorId === userId || canModerate) && (
              <Pressable
                style={styles.actionOption}
                disabled={remove.isPending}
                onPress={() => {
                  if (actionsFor) remove.mutate(actionsFor.messageId);
                }}
              >
                <Text style={styles.actionOptionTextDanger}>🗑️ Delete for everyone</Text>
              </Pressable>
            )}
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
  previewsByMessage,
  replyCounts,
  editingId,
  editDraft,
  onEditDraftChange,
  editPending,
  onSaveEdit,
  onCancelEdit,
  onTogglePill,
  onLongPressMessage,
  onOpenThread,
}: {
  readonly group: MessageGroup;
  readonly viewerId: string | null;
  readonly personOf: (userId: string) => { readonly label: string };
  readonly reactionsByMessage: Map<string, Map<string, string[]>>;
  readonly previewsByMessage: Map<string, readonly UnfurlPreview[]>;
  readonly replyCounts: Map<string, number>;
  readonly editingId: string | null;
  readonly editDraft: string;
  readonly onEditDraftChange: (text: string) => void;
  readonly editPending: boolean;
  readonly onSaveEdit: (messageId: string) => void;
  readonly onCancelEdit: () => void;
  readonly onTogglePill: (messageId: string, emoji: string) => void;
  readonly onLongPressMessage: (message: Message) => void;
  readonly onOpenThread: (message: Message) => void;
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
          const previews = previewsByMessage.get(message.messageId) ?? [];
          const replyCount = replyCounts.get(message.messageId) ?? 0;
          const isEditing = editingId === message.messageId;

          if (isEditing) {
            return (
              <View key={message.messageId} style={styles.editRow}>
                <TextInput
                  value={editDraft}
                  onChangeText={onEditDraftChange}
                  style={styles.editInput}
                  multiline
                  autoFocus
                />
                <View style={styles.editActions}>
                  <Pressable onPress={onCancelEdit}>
                    <Text style={styles.editCancelText}>Cancel</Text>
                  </Pressable>
                  <Pressable
                    style={styles.editSaveButton}
                    disabled={editPending || editDraft.trim().length === 0}
                    onPress={() => {
                      onSaveEdit(message.messageId);
                    }}
                  >
                    {editPending ? (
                      <ActivityIndicator color={colors.accentInk.hex} />
                    ) : (
                      <Text style={styles.editSaveText}>Save</Text>
                    )}
                  </Pressable>
                </View>
              </View>
            );
          }

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
                <>
                  <RichTextView document={message.body} />
                  {message.editedAt !== null && <Text style={styles.editedTag}>edited</Text>}
                </>
              )}
              {previews.length > 0 && <LinkPreviewList previews={previews} />}
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
              {replyCount > 0 && (
                <Pressable
                  onPress={() => {
                    onOpenThread(message);
                  }}
                >
                  <Text style={styles.replyCountText}>
                    {replyCount} {replyCount === 1 ? 'reply' : 'replies'}
                  </Text>
                </Pressable>
              )}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

/**
 * A message's resolved link previews — `apps/web`'s `MessagePreviews`,
 * ported. Every row is already ready to render (see `UnfurlPreview`'s own
 * comment — `pending`/`failed`/`refused` never reach the client), so this
 * does no status branching, just a card per preview: site name, title,
 * description, tap to open. `Linking.openURL`, not a re-validated scheme
 * check — the same trust boundary `rich-text-view.tsx`'s own `link` mark
 * draws, except the URL here came from the SERVER's own unfurl record
 * rather than a sanitized document, so there is no client-side whitelist
 * to re-run in the first place.
 */
function LinkPreviewList({ previews }: { readonly previews: readonly UnfurlPreview[] }) {
  return (
    <View style={styles.previewList}>
      {previews.map((preview) => (
        <Pressable
          key={preview.url}
          style={styles.previewCard}
          onPress={() => {
            void Linking.openURL(preview.url);
          }}
        >
          {preview.siteName !== null && (
            <Text style={styles.previewSite} numberOfLines={1}>
              {preview.siteName}
            </Text>
          )}
          {preview.title !== null && (
            <Text style={styles.previewTitle} numberOfLines={1}>
              {preview.title}
            </Text>
          )}
          {preview.description !== null && (
            <Text style={styles.previewDescription} numberOfLines={2}>
              {preview.description}
            </Text>
          )}
        </Pressable>
      ))}
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
  replyCountText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.accent.hex,
  },
  editRow: {
    gap: 6,
  },
  editInput: {
    borderWidth: 1,
    borderColor: colors.accent.hex,
    borderRadius: radiusCard,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
    color: colors.ink.hex,
    backgroundColor: colors.surfaceSunken.hex,
  },
  editActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  editCancelText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.inkMuted.hex,
  },
  editSaveButton: {
    backgroundColor: colors.accent.hex,
    borderRadius: radiusCard,
    paddingHorizontal: 12,
    paddingVertical: 5,
  },
  editSaveText: {
    color: colors.accentInk.hex,
    fontSize: 13,
    fontWeight: '600',
  },
  editedTag: {
    fontSize: 11,
    fontStyle: 'italic',
    color: colors.inkFaint.hex,
  },
  previewList: {
    gap: 4,
  },
  previewCard: {
    borderLeftWidth: 2,
    borderLeftColor: colors.accent.hex,
    borderRadius: 4,
    backgroundColor: colors.surfaceRaised.hex,
    paddingHorizontal: 8,
    paddingVertical: 6,
    gap: 1,
    maxWidth: 320,
  },
  previewSite: {
    fontSize: 11,
    color: colors.inkFaint.hex,
  },
  previewTitle: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.ink.hex,
  },
  previewDescription: {
    fontSize: 11,
    color: colors.inkMuted.hex,
  },
  label: {
    fontSize: 14,
    color: colors.inkMuted.hex,
    textAlign: 'center',
  },
  typingLabel: {
    fontSize: 12,
    fontStyle: 'italic',
    color: colors.inkFaint.hex,
    paddingBottom: 2,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: '#00000099',
    justifyContent: 'flex-end',
  },
  reactionSheetCard: {
    backgroundColor: colors.surfaceRaised.hex,
    borderTopLeftRadius: radiusCard,
    borderTopRightRadius: radiusCard,
    paddingTop: 20,
  },
  reactionSheet: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    paddingHorizontal: 20,
  },
  reactionOption: {
    padding: 8,
  },
  reactionOptionText: {
    fontSize: 28,
  },
  actionOption: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.line.hex,
    paddingVertical: 14,
    alignItems: 'center',
  },
  actionOptionText: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.ink.hex,
  },
  actionOptionTextDanger: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.danger.hex,
  },
});
