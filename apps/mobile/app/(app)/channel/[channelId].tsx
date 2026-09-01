import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ActivityIndicator,
  Animated,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Linking,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import { ChannelIdSchema, type ChannelId } from '@taskflow/contracts';
import { wire } from '@taskflow/client';
import { plainParagraph, type RichTextNode } from '@taskflow/api/richtext';
import { colors, radiusCard } from '@taskflow/tokens';
import { apiClient, chatSocket } from '../../../src/lib/app-session.js';
import { apiErrorOf } from '../../../src/lib/trpc-client.js';
import { useSession } from '../../../src/lib/use-session.js';
import { useTopInset } from '../../../src/lib/use-top-inset.js';
import { RichTextView } from '../../../src/lib/rich-text-view.js';
import { Avatar } from '../../../src/lib/avatar.js';
import { useMembers } from '../../../src/lib/use-members.js';
import { parseFormattedText } from '../../../src/lib/rich-text-compose.js';
import { MessageComposer } from '../../../src/lib/message-composer.js';
import { CallButton } from '../../../src/lib/call-button.js';
import { useChatRoom } from '../../../src/lib/use-chat-room.js';
import { pickAttachment } from '../../../src/lib/pick-attachment.js';
import { uploadMessageFile, type PickedFile } from '../../../src/lib/upload-message-file.js';
import { matchingCommands, messageTextFor, parseCommand } from '../../../src/lib/slash-commands.js';
import {
  callHistoryQueryKey,
  formatCallDuration,
  type CallHistoryEntry,
} from '../../../src/lib/rtc.js';
import {
  channelDisplayName,
  channelQueryKey,
  channelTypeGlyph,
  describeTyping,
  entryCursorQueryKey,
  firstUnreadAfter,
  groupMessages,
  groupPreviews,
  groupReactions,
  messagesQueryKey,
  pinsQueryKey,
  reactionsQueryKey,
  replyCountsOf,
  unfurlsQueryKey,
  CHANNELS_QUERY_KEY,
  QUICK_REACTIONS,
  SAVED_QUERY_KEY,
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
 * one. `message-compose.ts`'s own header has the cursor-tracking design:
 * typing `@query` anywhere in the draft opens a dropdown of matching
 * members, and picking one inserts literal `@Label ` text and records the
 * pick. `rich-text-compose.ts`'s `parseFormattedText` turns those recorded
 * picks into real `mention` nodes at send time, alongside `**bold**`,
 * `[text](url)` links, and `- `/`1. ` list lines — see that file's own
 * header for the native (no WebView) live/send-time split behind it.
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
 * shown-and-refused. It reuses `plainParagraph`, not `parseFormattedText` —
 * an edit does not re-open mention composing or formatting syntax, since
 * there is no honest way to reconstruct `**`/`[]()`/list markdown SOURCE
 * from marks a real editor never kept text-shaped in the first place; the
 * same boundary `card/[cardId].tsx`'s comment composer draws. An edited
 * message therefore loses any formatting the original had — a known,
 * accepted trade rather than a gap in this pass.
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
 * **Attaching a file from the composer** closes the last named gap
 * (`pick-attachment.ts`, `upload-message-file.ts`) — the mirror image of
 * the details screen's existing Files section, which could only download
 * what was already there. Mirrors `apps/web/src/features/chat/chat-page.tsx`'s
 * own `attach` mutation exactly: the message is sent FIRST (an attachment
 * hangs off a message, and until one exists there is no channel to
 * authorize the upload against — `attachment.service.ts`), using the
 * current draft if there is one or a short "Shared **filename**" message
 * otherwise, and typing stops the same way an ordinary send already does.
 * `PickedFile.sizeBytes` comes from the fetched `Blob`, not the picker
 * asset's own `size` field — see `pick-attachment.ts`'s own header for why
 * that distinction matters to a signature-pinned upload.
 *
 * **Still explicitly out of scope, all real and separate work**: preserving
 * formatting across an edit (see the edit note above).
 *
 * `chat.messages.list` returns newest-first (`ORDER BY id DESC`) —
 * reversed here for display, since a chat thread reads oldest-at-top.
 *
 * `KeyboardAvoidingView`'s Android `behavior` is `'height'`, not
 * `undefined` — found broken against a real device (the composer rendered
 * fully behind the open keyboard); see the mobile README's own bug-fix
 * section for the full account.
 */

/**
 * Mirrors `apps/api/src/rtc/shared.ts`'s `MESH_PARTICIPANT_CAP` — not
 * imported from there, since that module pulls in `@taskflow/db` (Drizzle,
 * the Postgres driver) at module scope, which this app must never bundle
 * (CLAUDE.md guardrail 1). The value only decides whether to SHOW the Call
 * button; `session.service.ts`'s own check is what actually enforces it —
 * a stale copy here would only make the button appear one call too early or
 * late, never let anyone past the real cap, the same courtesy-only relationship
 * the public-channel hide below already has to `startSession`'s own refusal.
 */
const MESH_PARTICIPANT_CAP = 4;

/** One row in the merged list — a group of messages or a call event, ordered
 *  by `at` — mirrors `apps/web/src/features/chat/chat-page.tsx`'s identical
 *  `TimelineItem`. */
type TimelineItem =
  | {
      readonly kind: 'messages';
      readonly key: string;
      readonly at: string;
      readonly group: MessageGroup;
    }
  | {
      readonly kind: 'call';
      readonly key: string;
      readonly at: string;
      readonly entry: CallHistoryEntry;
    };

const MOBILE_QUICK_REACTIONS = [
  '👍', '❤️', '😂', '🎉', '👀', '✅',
  '🙏', '🔥', '😍', '🤔', '👏', '😢',
  '🚀', '😅', '💯',
];

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
  /** "There is no /xxx command" — a parse-time notice, not a mutation error,
      so it has nowhere else to live; see `runCommand` below. */
  const [commandNotice, setCommandNotice] = useState<string | null>(null);
  /** The "who reacted" sheet — long-press on a reaction pill, not a tap
      (which stays the fast toggle it already was; see `MessageGroupRow`'s
      own header for why this app splits the two gestures where web's
      click-through-a-popover does not need to). */
  const [reactionInfoFor, setReactionInfoFor] = useState<{
    readonly messageId: string;
    readonly emoji: string;
    readonly userIds: readonly string[];
  } | null>(null);

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

  /* Every call this conversation has had, merged into the list below by
     timestamp — `apps/web/src/features/chat/chat-page.tsx`'s own "WhatsApp
     placement" for the identical gap: a call happened AT A POINT in the
     conversation, between two messages, not off to one side in the details
     panel's Calls tab only (which this app already has,
     `channel-details/[channelId].tsx`'s `CallHistorySection` — this is the
     other half of that same read, not a new query shape). */
  const calls = useQuery({
    queryKey: callHistoryQueryKey(orgId ?? '', channelId),
    queryFn: async () => wire(await apiClient.rtc.history.list.query({ channelId })),
    enabled: orgId !== null,
  });

  /* String comparison is safe here for the identical reason web's own
     comment gives: both timestamps are this server's own
     `Date.prototype.toISOString()` output — fixed-width, UTC, `Z`-suffixed —
     so lexicographic order already agrees with chronological order. */
  const timeline = useMemo(
    (): readonly TimelineItem[] =>
      [
        ...groups.map((group, index): TimelineItem => ({
          kind: 'messages',
          key: `${group.authorId ?? 'unknown'}-${String(index)}`,
          at: group.messages[0]?.createdAt ?? '',
          group,
        })),
        ...(calls.data ?? []).map((entry): TimelineItem => ({
          kind: 'call',
          key: entry.sessionId,
          at: entry.createdAt,
          entry,
        })),
      ].sort((a, b) => a.at.localeCompare(b.at)),
    [groups, calls.data],
  );

  /**
   * The read cursor as it was the moment this screen opened — where the
   * "new messages" divider goes. Ported from `apps/web/src/features/chat/
   * chat-page.tsx`'s own `entryCursor`, reusing the identical `chat.
   * channels.unreadCounts` route the channel LIST already calls for its
   * badges (`(tabs)/chat.tsx`), narrowed to this one channel and read for
   * `lastReadMessageId` instead of `unreadCount`.
   *
   * `staleTime: Infinity` is what makes this FROZEN rather than live: this
   * screen's own `markRead` effect below advances the SAME cursor on the
   * server every time a new message arrives, so a divider computed from a
   * live read of it would chase itself — appearing for one render and
   * vanishing, or walking down the list as each new message advanced the
   * cursor past it. `gcTime: 0` is the other half: without it, leaving and
   * reopening this same channel within TanStack Query's default cache
   * window would reuse the STALE frozen value from the previous visit
   * instead of fetching where the reader actually left off this time.
   */
  const entryCursor = useQuery({
    queryKey: entryCursorQueryKey(channelId),
    queryFn: async () => {
      const rows = wire(
        await apiClient.chat.channels.unreadCounts.query({ channelIds: [channelId] }),
      );
      return rows[0]?.lastReadMessageId ?? null;
    },
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
  });

  const markRead = useMutation({
    mutationFn: (messageId: string) =>
      apiClient.chat.channels.markRead.mutate({ channelId, messageId }),
    onSuccess: async () => {
      await Promise.all([
        // The bare prefix, not `unreadCountsQueryKey(someArray)` — see that
        // function's own header on why a shorter key invalidates every
        // longer one TanStack Query has cached under it.
        queryClient.invalidateQueries({ queryKey: ['chat.channels.unreadCounts'] }),
        // Re-freezes `entryCursor` at the position it just advanced TO —
        // without this, sending a message would advance the server's
        // cursor while this screen kept showing the PRE-SEND value, and
        // the divider would stay stuck above the sender's own just-sent
        // message.
        queryClient.invalidateQueries({ queryKey: entryCursorQueryKey(channelId) }),
      ]);
    },
  });
  const lastTopLevelId = topLevel.at(-1)?.messageId;
  useEffect(() => {
    if (lastTopLevelId === undefined) return;
    /* ORDERED AFTER the entry cursor has been read — both this effect and
       `entryCursor` touch the same server-side cursor, one advancing it and
       the other reading it. Started together they race: if this wins, the
       divider never appears; if the read wins, it appears correctly. Which
       one happened was down to network timing, so waiting for the read
       first is what makes the divider a function of what the person had
       actually seen, not of request ordering. */
    if (!entryCursor.isSuccess) return;
    markRead.mutate(lastTopLevelId);
  }, [lastTopLevelId, entryCursor.isSuccess]);

  // The RENDERED list's own ids — `topLevel`, never `messageIds` (which
  // includes thread replies, rendered in no group here). Handing
  // `firstUnreadAfter` the wrong list is exactly the bug web's own
  // `unread-divider.test.ts` suite exists to catch: a reply sitting next
  // to its parent in the raw feed could otherwise be named as the divider
  // target, and nothing would draw a line for it.
  const topLevelIds = useMemo(() => topLevel.map((message) => message.messageId), [topLevel]);
  const firstUnreadId = firstUnreadAfter(entryCursor.data, topLevelIds);
  /* Suppressed when the first unread message is the viewer's OWN — the
     cursor advances in the same beat as the send (the invalidation above),
     so without this the line would flash above your own just-sent message
     for a render or two. "New" means "arrived while you were away", and
     your own message is not that. */
  const firstUnreadAuthorId =
    topLevel.find((message) => message.messageId === firstUnreadId)?.authorId ?? null;

  /**
   * Bottom-anchored on open, and follows a new message down while the reader
   * is still near the bottom — the mobile counterpart of `apps/web/src/
   * features/chat/chat-page.tsx`'s own `useLayoutEffect`/`atBottom` pair,
   * including WHY: a reader who has scrolled up into history must not be
   * yanked back down by a message arriving while they read.
   *
   * This does NOT try to scroll straight to the first-UNREAD message's own
   * position. Neither does web — `firstUnreadId`'s own comment above and web's
   * identical one both describe the divider rendered below as a passive
   * marker a reader finds by scrolling up, never a scroll TARGET. The
   * previous version of this effect tried to be cleverer than web here,
   * scrolling to `timeline.findIndex(...)` via `FlatList.scrollToIndex` —
   * which RN can only do reliably for a row already inside the list's
   * measured render window. Message groups are variable height (reactions,
   * attachments, reply counts), so there is no `getItemLayout` to give it,
   * and for any channel with real history the first unread message sits well
   * outside that window. `scrollToIndex` failed there, and
   * `onScrollToIndexFailed`'s fallback silently turned every failure into
   * "scroll to the very bottom" — indistinguishable from this effect never
   * having run at all, which is exactly the "the fix doesn't do anything"
   * symptom this replaces.
   *
   * `onContentSizeChange` is `FlatList`'s equivalent of web's DOM
   * `scrollHeight` growing — it fires whenever the rendered content's own
   * height changes (the first page landing, a new message, a reaction row
   * changing a bubble's height), which is web's own trigger for "maybe
   * follow." `hasAnchoredRef` mirrors web's `firstAnchor`: the very first
   * change scrolls unconditionally (mounting this channel), every
   * subsequent one only scrolls if `nearBottomRef` — tracked from `onScroll`
   * the same way web reads `scrollTop`/`scrollHeight`/`clientHeight`, with
   * the identical 160px threshold and the identical reasoning for it
   * (`chat-page.tsx`'s own comment: a bottom-anchored reader does not sit at
   * exactly `scrollHeight` because of the list's own bottom padding).
   */
  const flatListRef = useRef<FlatList<TimelineItem>>(null);
  const hasAnchoredRef = useRef(false);
  const nearBottomRef = useRef(true);

  const onContentSizeChange = useCallback(() => {
    if (!hasAnchoredRef.current) {
      hasAnchoredRef.current = true;
      flatListRef.current?.scrollToEnd({ animated: false });
      return;
    }
    if (nearBottomRef.current) {
      flatListRef.current?.scrollToEnd({ animated: true });
    }
  }, []);

  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    nearBottomRef.current = contentSize.height - contentOffset.y - layoutMeasurement.height < 160;
  }, []);

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

  const pins = useQuery({
    queryKey: pinsQueryKey(channelId),
    queryFn: () => apiClient.chat.messages.pins.query({ channelId }),
  });
  const pinnedIds = useMemo(
    () => new Set((pins.data ?? []).map((p) => p.messageId)),
    [pins.data],
  );

  const saved = useQuery({
    queryKey: SAVED_QUERY_KEY,
    queryFn: () => apiClient.chat.saved.list.query(),
  });
  const savedIds = useMemo(
    () => new Set((saved.data ?? []).map((s) => s.messageId)),
    [saved.data],
  );

  const send = useMutation({
    // `RichTextNode`, not `ReturnType<typeof parseFormattedText>` — the
    // ordinary send path always builds one via `parseFormattedText`, but a
    // `/shrug`/`/me` slash command's replacement text goes through
    // `plainParagraph` instead (`submitDraft` below), and `FormattedDoc` is
    // structurally a `RichTextNode` (a stricter `type: 'doc'` shape), so
    // this widens to the common supertype rather than adding a second
    // near-identical mutation just for the two commands that speak.
    mutationFn: (body: RichTextNode) => apiClient.chat.messages.send.mutate({ channelId, body }),
    onSuccess: async () => {
      setDraft('');
      setPendingMentions([]);
      await queryClient.invalidateQueries({ queryKey: messagesQueryKey(channelId) });
    },
  });

  /**
   * The two slash commands that ACT rather than say something —
   * `/topic`/`/leave` — ported from `apps/web/src/features/chat/
   * chat-page.tsx`'s own `runCommand`. Each resolves to the identical
   * already-authorized route the equivalent UI control uses elsewhere on
   * this screen or `channel-details/[channelId].tsx` (`chat.channels.
   * update`, `chat.channels.removeMember`) — see `slash-commands.ts`'s own
   * header on why there is no dedicated `commands.run` endpoint for the
   * client to call instead.
   */
  const runCommand = useMutation({
    mutationFn: async (parsed: ReturnType<typeof parseCommand>) => {
      if (parsed.kind !== 'command') return;

      if (parsed.command.name === 'topic') {
        await apiClient.chat.channels.update.mutate({
          channelId,
          name: channel.data?.name ?? '',
          topic: parsed.argument === '' ? null : parsed.argument,
        });
        return;
      }

      if (parsed.command.name === 'leave' && userId !== null) {
        await apiClient.chat.channels.removeMember.mutate({ channelId, userId });
      }
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: channelQueryKey(channelId) }),
        queryClient.invalidateQueries({ queryKey: CHANNELS_QUERY_KEY }),
      ]);
    },
    onError: () => {
      setCommandNotice('That command did not run.');
    },
  });

  /**
   * Interprets the draft before sending, mirroring `chat-page.tsx`'s own
   * `submit` exactly: a message that merely STARTS with a slash
   * (`/etc/passwd is broken`) is not a command and goes out unchanged, an
   * unrecognized name is reported rather than posted
   * (`/topc oops` almost certainly meant `/topic`), and a command that acts
   * rather than speaks (`/topic`, `/leave`) never reaches `send` at all.
   */
  const submitDraft = (): void => {
    const parsed = parseCommand(draft);

    if (parsed.kind === 'unknown') {
      setCommandNotice(`There is no /${parsed.name} command`);
      return;
    }

    setCommandNotice(null);
    chatSocket.stopTyping(channelId);

    if (parsed.kind === 'command') {
      const replacement = messageTextFor(parsed);
      setDraft('');
      setPendingMentions([]);
      if (replacement !== null) {
        send.mutate(plainParagraph(replacement));
      } else {
        runCommand.mutate(parsed);
      }
      return;
    }

    send.mutate(parseFormattedText(draft.trim(), pendingMentions));
  };

  const [uploadStage, setUploadStage] = useState<string | null>(null);
  const [uploadNotice, setUploadNotice] = useState<{
    readonly kind: 'success' | 'failure';
    readonly text: string;
  } | null>(null);

  // Uploads against the LAST message this pick sends — an attachment hangs
  // off a message, and until one exists there is no channel to authorize
  // the upload against (`attachment.service.ts`), the same ordering
  // `apps/web`'s own `attach` mutation uses.
  const attach = useMutation({
    mutationFn: async (file: PickedFile) => {
      setUploadNotice(null);
      // `parseFormattedText`, not `plainParagraph`, for the synthetic
      // "Shared **filename**" carrier too — now that `**` really means bold,
      // leaving this on `plainParagraph` would post literal asterisks around
      // the filename instead of the bold text they were always meant to be.
      const carrier =
        draft.trim().length === 0
          ? await apiClient.chat.messages.send.mutate({
              channelId,
              body: parseFormattedText(`Shared **${file.name}**`),
            })
          : await apiClient.chat.messages.send.mutate({
              channelId,
              body: parseFormattedText(draft.trim(), pendingMentions),
            });

      setDraft('');
      setPendingMentions([]);
      chatSocket.stopTyping(channelId);

      return uploadMessageFile(
        {
          presign: (input) => apiClient.chat.attachments.presign.mutate(input),
          confirm: (input) => apiClient.chat.attachments.confirm.mutate(input),
        },
        carrier.messageId,
        file,
        setUploadStage,
      );
    },
    onSuccess: (result) => {
      if (result.status === 'clean') {
        setUploadNotice({ kind: 'success', text: 'File uploaded.' });
      } else {
        setUploadNotice({
          kind: 'failure',
          text:
            result.status === 'infected'
              ? 'That file was rejected: malware detected.'
              : `That file was rejected: ${result.reason ?? 'it did not pass verification.'}`,
        });
      }
    },
    onError: () => {
      setUploadNotice({ kind: 'failure', text: 'The file was not uploaded.' });
    },
    onSettled: async () => {
      setUploadStage(null);
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

  const saveMessage = useMutation({
    mutationFn: (messageId: string) => apiClient.chat.saved.save.mutate({ messageId }),
    onSuccess: async () => {
      setActionsFor(null);
      await queryClient.invalidateQueries({ queryKey: SAVED_QUERY_KEY });
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
  const insets = useSafeAreaInsets();

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
        <View style={styles.headerTitleRow}>
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
              {channelTypeGlyph(channel.data?.type ?? '')}
              {title}
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
          {/* Hide the call button on public channels — calls are only supported
              on DMs and private channels (server refuses with a clear error, but
              showing the button at all is confusing UX) — and on a DM/private
              channel whose roster already exceeds the mesh cap, for the same
              reason: `startSession` refuses the whole conversation rather than
              ringing only the first four, so a button that can only ever fail
              is worse than no button. */}
          {orgId !== null &&
            channel.data?.type !== 'public' &&
            (channel.data?.memberIds.length ?? 0) <= MESH_PARTICIPANT_CAP && (
              <CallButton orgId={orgId} channelId={channelId} />
            )}
        </View>
      </View>

      <FlatList<TimelineItem>
        ref={flatListRef}
        data={timeline}
        keyExtractor={(item) => item.key}
        onContentSizeChange={onContentSizeChange}
        onScroll={onScroll}
        scrollEventThrottle={200}
        keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'none'}
        renderItem={({ item }) =>
          item.kind === 'call' ? (
            <CallTimelineCard entry={item.entry} viewerId={userId} personOf={personOf} />
          ) : (
            <>
              {/* The "new messages" line, placed by the read CURSOR rather
                  than by counting back from the end — see `firstUnreadAfter`'s
                  own header on why a count-based position is silently wrong
                  the moment a message is deleted or the page is partially
                  loaded. */}
              {firstUnreadId !== null &&
                firstUnreadAuthorId !== userId &&
                item.group.messages.some((message) => message.messageId === firstUnreadId) && (
                  <View style={styles.unreadDivider} accessibilityRole="none">
                    <View style={styles.unreadDividerLine} />
                    <Text style={styles.unreadDividerText}>New messages</Text>
                    <View style={styles.unreadDividerLine} />
                  </View>
                )}
              <MessageGroupRow
                group={item.group}
                viewerId={userId}
                personOf={personOf}
                reactionsByMessage={reactionsByMessage}
                previewsByMessage={previewsByMessage}
                replyCounts={replyCounts}
                pinnedIds={pinnedIds}
                savedIds={savedIds}
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
                  setReactionInfoFor({
                    messageId,
                    emoji,
                    userIds: reactionsByMessage.get(messageId)?.get(emoji) ?? [],
                  });
                }}
                onLongPressMessage={setActionsFor}
                onLongPressReaction={(messageId, emoji, userIds) => {
                  setReactionInfoFor({ messageId, emoji, userIds });
                }}
                onOpenThread={(message) => {
                  router.push({
                    pathname: '/thread/[messageId]',
                    params: { messageId: message.messageId, channelId },
                  });
                }}
                {...(canPost
                  ? {
                      onSwipeToReply: (message: Message) => {
                        router.push({
                          pathname: '/thread/[messageId]',
                          params: { messageId: message.messageId, channelId },
                        });
                      },
                    }
                  : {})}
              />
            </>
          )
        }
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

      {(uploadStage !== null || uploadNotice !== null) && (
        <Text
          style={[
            styles.uploadStatus,
            uploadNotice?.kind === 'failure' ? styles.uploadStatusError : null,
          ]}
        >
          {uploadStage ?? uploadNotice?.text}
        </Text>
      )}

      {canPost && (
        <>
          {/* Shown only while the draft is a bare command word — one word in,
              the list would just cover the composer — mirroring `chat-page
              .tsx`'s own `SlashCommandMenu`. Purely an affordance: typing
              the command by hand works identically, since `submitDraft`
              parses the text rather than reading a selection made here. */}
          {draft.startsWith('/') && !draft.includes(' ') && matchingCommands(draft).length > 0 && (
            <View style={styles.slashMenu}>
              {matchingCommands(draft).map((command) => (
                <View key={command.name} style={styles.slashMenuRow}>
                  <Text style={styles.slashMenuHint}>{command.hint}</Text>
                  <Text style={styles.slashMenuDescription}>{command.description}</Text>
                </View>
              ))}
            </View>
          )}

          {commandNotice !== null && <Text style={styles.error}>{commandNotice}</Text>}

          <MessageComposer
            draft={draft}
            onDraftChange={(text) => {
              setDraft(text);
              setCommandNotice(null);
              chatSocket.startTyping(channelId);
            }}
            people={people}
            viewerId={userId}
            onMentionRecorded={(mention) => {
              setPendingMentions((current) => [...current, mention]);
            }}
            onSubmit={submitDraft}
            sending={send.isPending || runCommand.isPending}
            error={send.isError ? send.error : null}
            placeholder="Message… (or /topic, /leave, /shrug, /me)"
            fallbackError="The message was not sent."
            attachAction={{
              pending: attach.isPending,
              onPress: () => {
                void pickAttachment()
                  .then((file) => {
                    if (file !== null) attach.mutate(file);
                  })
                  .catch(() => {
                    setUploadNotice({ kind: 'failure', text: 'File picker unavailable on this device.' });
                  });
              },
            }}
          />
        </>
      )}

      {/* The composer is hidden, not merely disabled, when the server says
          this person cannot post — a `viewer` tuple on this channel, or an
          archived one (`capabilities.post`, never a role re-derived here).
          Web's identical guard (`chat-page.tsx`) explains WHY nothing is
          there instead of leaving blank space; this had none at all until
          the 2026-08-22 chat-parity pass, which read as the composer
          having silently vanished rather than a permission the viewer
          could understand. */}
      {!canPost && channel.data !== undefined && (
        <Text style={styles.readOnlyNotice}>
          {channel.data.archivedAt !== null
            ? 'This channel is archived. No new messages can be posted.'
            : 'You have read-only access to this conversation.'}
        </Text>
      )}

      <Modal
        visible={actionsFor !== null}
        transparent
        animationType="slide"
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
            <View style={styles.sheetHandle} />

            {/* Quick-react row */}
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={styles.reactionSheet}
              contentContainerStyle={styles.reactionSheetContent}
            >
              {MOBILE_QUICK_REACTIONS.map((emoji) => (
                <Pressable
                  key={emoji}
                  style={styles.reactionOption}
                  onPress={() => {
                    if (actionsFor) react.mutate({ messageId: actionsFor.messageId, emoji });
                    setActionsFor(null);
                  }}
                >
                  <Text style={styles.reactionOptionText}>{emoji}</Text>
                </Pressable>
              ))}
            </ScrollView>

            <View style={styles.actionDivider} />

            {/* Action items — left-aligned icon + label */}
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
                <Ionicons
                  name="chatbubble-outline"
                  size={20}
                  color={colors.ink.hex}
                  style={styles.actionIcon}
                />
                <Text style={styles.actionOptionText}>Reply in thread</Text>
              </Pressable>
            )}
            <Pressable
              style={styles.actionOption}
              disabled={pin.isPending}
              onPress={() => {
                if (actionsFor) pin.mutate(actionsFor.messageId);
              }}
            >
              <Ionicons
                name="pin-outline"
                size={20}
                color={colors.ink.hex}
                style={styles.actionIcon}
              />
              <Text style={styles.actionOptionText}>Pin this message</Text>
            </Pressable>
            <Pressable
              style={styles.actionOption}
              disabled={saveMessage.isPending}
              onPress={() => {
                if (actionsFor) saveMessage.mutate(actionsFor.messageId);
              }}
            >
              <Ionicons
                name="bookmark-outline"
                size={20}
                color={colors.ink.hex}
                style={styles.actionIcon}
              />
              <Text style={styles.actionOptionText}>Save this message</Text>
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
                <Ionicons
                  name="pencil-outline"
                  size={20}
                  color={colors.ink.hex}
                  style={styles.actionIcon}
                />
                <Text style={styles.actionOptionText}>Edit message</Text>
              </Pressable>
            )}
            <Pressable
              style={styles.actionOption}
              disabled={hide.isPending}
              onPress={() => {
                if (actionsFor) hide.mutate(actionsFor.messageId);
              }}
            >
              <Ionicons
                name="eye-off-outline"
                size={20}
                color={colors.inkMuted.hex}
                style={styles.actionIcon}
              />
              <Text style={[styles.actionOptionText, { color: colors.inkMuted.hex }]}>
                Remove for me
              </Text>
            </Pressable>
            {(actionsFor?.authorId === userId || canModerate) && (
              <Pressable
                style={styles.actionOption}
                disabled={remove.isPending}
                onPress={() => {
                  if (actionsFor) remove.mutate(actionsFor.messageId);
                }}
              >
                <Ionicons
                  name="trash-outline"
                  size={20}
                  color={colors.danger.hex}
                  style={styles.actionIcon}
                />
                <Text style={styles.actionOptionTextDanger}>Delete for everyone</Text>
              </Pressable>
            )}

            <View style={[styles.actionDivider, { marginBottom: 4 }]} />
            <Pressable
              style={[styles.actionOption, { paddingBottom: Math.max(insets.bottom, 16) }]}
              onPress={() => {
                setActionsFor(null);
              }}
            >
              <Text style={[styles.actionOptionText, styles.actionCancelText]}>Cancel</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      <ReactionInfoModal
        info={reactionInfoFor}
        viewerId={userId}
        personOf={personOf}
        onClose={() => {
          setReactionInfoFor(null);
        }}
        onToggle={() => {
          if (reactionInfoFor === null) return;
          react.mutate({ messageId: reactionInfoFor.messageId, emoji: reactionInfoFor.emoji });
          setReactionInfoFor(null);
        }}
      />
    </KeyboardAvoidingView>
  );
}

/**
 * "Who reacted" — web's `ReactionBar` is a popover trigger on every pill,
 * opened by the same tap that (for the viewer's own reaction) can be
 * repeated to remove it. A single tap is this app's fast un-react gesture
 * already (`MessageGroupRow`'s pill `onPress`, unchanged, and the "mine"
 * fill/check styling already answers "did I react?" without opening
 * anything) — replacing it with a tap-to-see-names step would be a real
 * regression on a touchscreen, where the toggle is the thing people reach
 * for constantly. LONG-press is this screen's own established second
 * gesture instead, the same split the message body already draws between
 * a normal tap (nothing, on the body itself) and a long-press (the
 * reactions/pin/edit/delete sheet) — "who reacted" is exactly that kind
 * of secondary, informational action.
 */
function ReactionInfoModal({
  info,
  viewerId,
  personOf,
  onClose,
  onToggle,
}: {
  readonly info: {
    readonly messageId: string;
    readonly emoji: string;
    readonly userIds: readonly string[];
  } | null;
  readonly viewerId: string | null;
  readonly personOf: (userId: string) => { readonly label: string };
  readonly onClose: () => void;
  readonly onToggle: () => void;
}) {
  const mine = info !== null && viewerId !== null && info.userIds.includes(viewerId);

  return (
    <Modal visible={info !== null} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.modalBackdrop} onPress={onClose}>
        <Pressable style={styles.reactionSheetCard} onPress={() => undefined}>
          {info !== null && (
            <>
              <Text style={styles.reactionInfoTitle}>
                {info.emoji} · {info.userIds.length}{' '}
                {info.userIds.length === 1 ? 'reaction' : 'reactions'}
              </Text>
              {info.userIds.map((userId) => (
                <Text key={userId} style={styles.reactionInfoName}>
                  {userId === viewerId ? 'You' : personOf(userId).label}
                </Text>
              ))}
              <Pressable style={styles.actionOption} onPress={onToggle}>
                {mine ? (
                  <Text style={styles.actionOptionTextDanger}>Remove your {info.emoji}</Text>
                ) : (
                  <Text style={styles.actionOptionText}>React with {info.emoji}</Text>
                )}
              </Pressable>
            </>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/**
 * The same fact `channel-details/[channelId].tsx`'s `callOutcomeLabel`
 * states, restated PER VIEWER — mirrors `apps/web/src/features/chat/
 * channel-media.tsx`'s `callTimelineLabel` exactly. "Missed" is not a
 * property of the call, it is a property of who is reading about it: the
 * person who placed it sees "No answer", the person it rang for and who
 * never picked up sees "Missed call".
 */
function callTimelineLabel(
  entry: CallHistoryEntry,
  viewerId: string | null,
): { readonly text: string; readonly missed: boolean } {
  if (entry.status === 'ringing') return { text: 'Ringing…', missed: false };
  if (entry.status === 'active') return { text: 'In progress', missed: false };

  const own = entry.participants.find((participant) => participant.userId === viewerId);
  if (own?.state === 'missed') {
    return { text: `Missed ${entry.kind === 'video' ? 'video' : 'voice'} call`, missed: true };
  }
  if (own?.state === 'declined') {
    return { text: 'You declined this call', missed: false };
  }

  if (entry.startedAt !== null && entry.endedAt !== null) {
    const seconds = Math.max(
      0,
      Math.round((new Date(entry.endedAt).getTime() - new Date(entry.startedAt).getTime()) / 1000),
    );
    return { text: formatCallDuration(seconds), missed: false };
  }
  switch (entry.endReason) {
    case 'declined':
      return { text: 'Declined', missed: false };
    case 'no_answer':
      return { text: 'No answer', missed: false };
    case 'cancelled':
      return { text: 'Cancelled', missed: false };
    case null:
      return { text: 'Ended', missed: false };
    default:
      return { text: entry.endReason, missed: false };
  }
}

/**
 * "📞 You called · 3m 12s" / "📞 Missed voice call" — a call event inline in
 * the message list, the same place WhatsApp puts one and
 * `apps/web/src/features/chat/channel-media.tsx`'s `CallTimelineCard`
 * already does. A parallel resource merged into `timeline` by timestamp,
 * never a `chat.messages` row — see `timeline`'s own comment above.
 */
function CallTimelineCard({
  entry,
  viewerId,
  personOf,
}: {
  readonly entry: CallHistoryEntry;
  readonly viewerId: string | null;
  readonly personOf: (userId: string) => { readonly label: string };
}) {
  const { text, missed } = callTimelineLabel(entry, viewerId);
  const byViewer = entry.initiatedBy === viewerId;

  return (
    <View style={styles.callCardRow}>
      <View style={[styles.callCardPill, missed && styles.callCardPillMissed]}>
        <Text style={styles.callCardGlyph}>{entry.kind === 'video' ? '🎥' : '📞'}</Text>
        <Text style={[styles.callCardText, missed && styles.callCardTextMissed]}>
          {byViewer ? 'You called' : `${personOf(entry.initiatedBy).label} called`} · {text}
        </Text>
      </View>
    </View>
  );
}

function MessageGroupRow({
  group,
  viewerId,
  personOf,
  reactionsByMessage,
  previewsByMessage,
  replyCounts,
  pinnedIds,
  savedIds,
  editingId,
  editDraft,
  onEditDraftChange,
  editPending,
  onSaveEdit,
  onCancelEdit,
  onTogglePill,
  onLongPressMessage,
  onLongPressReaction,
  onOpenThread,
  onSwipeToReply,
}: {
  readonly group: MessageGroup;
  readonly viewerId: string | null;
  readonly personOf: (userId: string) => { readonly label: string };
  readonly reactionsByMessage: Map<string, Map<string, string[]>>;
  readonly previewsByMessage: Map<string, readonly UnfurlPreview[]>;
  readonly replyCounts: Map<string, number>;
  readonly pinnedIds: ReadonlySet<string>;
  readonly savedIds: ReadonlySet<string>;
  readonly editingId: string | null;
  readonly editDraft: string;
  readonly onEditDraftChange: (text: string) => void;
  readonly editPending: boolean;
  readonly onSaveEdit: (messageId: string) => void;
  readonly onCancelEdit: () => void;
  readonly onTogglePill: (messageId: string, emoji: string) => void;
  readonly onLongPressMessage: (message: Message) => void;
  readonly onLongPressReaction: (
    messageId: string,
    emoji: string,
    userIds: readonly string[],
  ) => void;
  readonly onOpenThread: (message: Message) => void;
  readonly onSwipeToReply?: (message: Message) => void;
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
            <MessageRow
              key={message.messageId}
              message={message}
              viewerId={viewerId}
              reactions={reactions}
              previews={previews}
              replyCount={replyCount}
              isPinned={pinnedIds.has(message.messageId)}
              isSaved={savedIds.has(message.messageId)}
              onLongPress={onLongPressMessage}
              onTogglePill={onTogglePill}
              onLongPressReaction={onLongPressReaction}
              onOpenThread={onOpenThread}
              {...(onSwipeToReply !== undefined ? { onSwipeToReply } : {})}
            />
          );
        })}
      </View>
    </View>
  );
}

/** One message bubble inside a group — extracted so hooks (`useRef`) work per-message. */
function MessageRow({
  message,
  viewerId,
  reactions,
  previews,
  replyCount,
  isPinned,
  isSaved,
  onLongPress,
  onTogglePill,
  onLongPressReaction,
  onOpenThread,
  onSwipeToReply,
}: {
  readonly message: Message;
  readonly viewerId: string | null;
  readonly reactions: Map<string, string[]> | undefined;
  readonly previews: readonly UnfurlPreview[];
  readonly replyCount: number;
  readonly isPinned: boolean;
  readonly isSaved: boolean;
  readonly onLongPress: (message: Message) => void;
  readonly onTogglePill: (messageId: string, emoji: string) => void;
  readonly onLongPressReaction: (
    messageId: string,
    emoji: string,
    userIds: readonly string[],
  ) => void;
  readonly onOpenThread: (message: Message) => void;
  readonly onSwipeToReply?: (message: Message) => void;
}) {
  const scale = useRef(new Animated.Value(1)).current;

  const onPressIn = () => {
    Animated.spring(scale, {
      toValue: 0.97,
      useNativeDriver: true,
      speed: 40,
      bounciness: 0,
    }).start();
  };
  const onPressOut = () => {
    Animated.spring(scale, { toValue: 1, useNativeDriver: true, speed: 30, bounciness: 6 }).start();
  };

  const inner = (
    <Pressable
      onLongPress={() => {
        onLongPress(message);
      }}
      onPressIn={onPressIn}
      onPressOut={onPressOut}
      style={styles.messageBody}
    >
      <Animated.View style={{ transform: [{ scale }] }}>
        {message.deletedAt !== null ? (
          <Text style={styles.messageDeleted}>Message deleted</Text>
        ) : (
          <>
            <RichTextView document={message.body} />
            {message.editedAt !== null && <Text style={styles.editedTag}>edited</Text>}
            {(isPinned || isSaved) && (
              <View style={styles.msgBadgeRow}>
                {isPinned && (
                  <View style={styles.msgBadge}>
                    <Text style={styles.msgBadgeText}>📌 Pinned</Text>
                  </View>
                )}
                {isSaved && (
                  <View style={[styles.msgBadge, styles.msgBadgeSaved]}>
                    <Text style={[styles.msgBadgeText, styles.msgBadgeTextSaved]}>🔖 Saved</Text>
                  </View>
                )}
              </View>
            )}
          </>
        )}
        {previews.length > 0 && <LinkPreviewList previews={previews} />}
      </Animated.View>
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
                onLongPress={() => {
                  onLongPressReaction(message.messageId, emoji, userIds);
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

  if (onSwipeToReply !== undefined && message.parentMessageId === null) {
    return (
      <SwipeableMessage
        onSwipeReply={() => {
          onSwipeToReply(message);
        }}
      >
        {inner}
      </SwipeableMessage>
    );
  }

  return inner;
}

/**
 * Horizontal swipe-to-reply wrapper using PanResponder + Animated.
 * Swipe right ≥60px → trigger reply, spring back.
 * Shows a reply glyph that fades in as the user drags.
 */
function SwipeableMessage({
  onSwipeReply,
  children,
}: {
  readonly onSwipeReply: () => void;
  readonly children: ReactNode;
}) {
  const translateX = useRef(new Animated.Value(0)).current;
  const replyOpacity = useRef(new Animated.Value(0)).current;
  const triggered = useRef(false);

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_evt, gestureState) =>
        gestureState.dx > 8 && Math.abs(gestureState.dx) > Math.abs(gestureState.dy) * 1.5,
      onPanResponderMove: (_evt, gestureState) => {
        if (gestureState.dx > 0) {
          const clamped = Math.min(gestureState.dx, 80);
          translateX.setValue(clamped);
          replyOpacity.setValue(Math.min(clamped / 60, 1));
          if (gestureState.dx >= 60 && !triggered.current) {
            triggered.current = true;
            onSwipeReply();
          }
        }
      },
      onPanResponderRelease: () => {
        triggered.current = false;
        Animated.parallel([
          Animated.spring(translateX, { toValue: 0, useNativeDriver: true, bounciness: 8 }),
          Animated.timing(replyOpacity, { toValue: 0, duration: 150, useNativeDriver: true }),
        ]).start();
      },
      onPanResponderTerminate: () => {
        triggered.current = false;
        translateX.setValue(0);
        replyOpacity.setValue(0);
      },
    }),
  ).current;

  return (
    <View style={styles.swipeRow}>
      <Animated.View style={[styles.replyHint, { opacity: replyOpacity }]}>
        <Text style={styles.replyHintText}>↩</Text>
      </Animated.View>
      <Animated.View style={{ transform: [{ translateX }] }} {...panResponder.panHandlers}>
        {children}
      </Animated.View>
    </View>
  );
}

/**
 * A message's resolved link previews — `apps/web`'s `MessagePreviews`,
 * ported. Every row is already ready to render (see `UnfurlPreview`'s own
 * comment — `pending`/`failed`/`refused` never reach the client), so this
 * does no status branching, just a card per preview: thumbnail, site name,
 * title, description, tap to open. `Linking.openURL`, not a re-validated
 * scheme check — the same trust boundary `rich-text-view.tsx`'s own `link`
 * mark draws, except the URL here came from the SERVER's own unfurl record
 * rather than a sanitized document, so there is no client-side whitelist
 * to re-run in the first place.
 *
 * `imageUrl` was captured server-side from the start (`unfurl.service.ts`)
 * but never rendered here, or on web — a real gap, not a deliberate scope
 * boundary, found reviewing this exact screen. `Image`'s own network
 * loading fails independently of the text above it (a broken/expired
 * thumbnail cannot take the card's title or description down with it),
 * and `resizeMode="cover"` in a fixed-size box is what keeps a wide
 * screenshot or a tall og:image from distorting the row.
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
          {preview.imageUrl !== null && (
            <Image
              source={{ uri: preview.imageUrl }}
              style={styles.previewImage}
              resizeMode="cover"
            />
          )}
          <View style={styles.previewText}>
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
          </View>
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
  headerTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  headerTitles: {
    flex: 1,
    gap: 1,
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.ink.hex,
    letterSpacing: -0.2,
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
    borderColor: colors.line.hex + '80',
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
    backgroundColor: colors.surfaceRaised.hex,
  },
  reactionPillMine: {
    borderColor: colors.accent.hex + '60',
    backgroundColor: colors.accent.hex + '15',
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
    borderRadius: radiusCard + 2,
    paddingHorizontal: 12,
    paddingVertical: 10,
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
  msgBadgeRow: {
    flexDirection: 'row',
    gap: 6,
    marginTop: 4,
    flexWrap: 'wrap',
  },
  msgBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.accent.hex + '18',
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderWidth: 1,
    borderColor: colors.accent.hex + '30',
  },
  msgBadgeSaved: {
    backgroundColor: colors.inkMuted.hex + '12',
    borderColor: colors.inkMuted.hex + '25',
  },
  msgBadgeText: {
    fontSize: 10,
    fontWeight: '600',
    color: colors.accent.hex,
  },
  msgBadgeTextSaved: {
    color: colors.inkMuted.hex,
  },
  previewList: {
    gap: 4,
  },
  previewCard: {
    flexDirection: 'row',
    alignItems: 'center',
    borderLeftWidth: 2,
    borderLeftColor: colors.accent.hex,
    borderRadius: 4,
    backgroundColor: colors.surfaceRaised.hex,
    padding: 6,
    gap: 8,
    maxWidth: 320,
  },
  previewImage: {
    width: 48,
    height: 48,
    borderRadius: 4,
    backgroundColor: colors.surface.hex,
  },
  previewText: {
    flex: 1,
    gap: 1,
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
  uploadStatus: {
    fontSize: 12,
    color: colors.inkFaint.hex,
    paddingBottom: 2,
  },
  uploadStatusError: {
    color: colors.danger.hex,
  },
  readOnlyNotice: {
    fontSize: 12,
    color: colors.inkFaint.hex,
    paddingVertical: 12,
  },
  error: {
    fontSize: 12,
    color: colors.danger.hex,
    paddingBottom: 2,
  },
  slashMenu: {
    marginBottom: 4,
    borderWidth: 1,
    borderColor: colors.line.hex + '80',
    borderRadius: radiusCard,
    backgroundColor: colors.surfaceRaised.hex,
    overflow: 'hidden',
  },
  slashMenuRow: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  slashMenuHint: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.ink.hex,
  },
  slashMenuDescription: {
    flex: 1,
    fontSize: 12,
    color: colors.inkFaint.hex,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: '#00000099',
    justifyContent: 'flex-end',
  },
  reactionSheetCard: {
    backgroundColor: colors.surfaceRaised.hex,
    borderTopLeftRadius: radiusCard + 10,
    borderTopRightRadius: radiusCard + 10,
    paddingTop: 8,
    /* Shadow lifts the sheet off the backdrop on iOS. */
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.12,
    shadowRadius: 12,
    elevation: 16,
  },
  sheetHandle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.line.hex,
    marginBottom: 12,
  },
  reactionSheet: {
    paddingBottom: 4,
  },
  reactionSheetContent: {
    flexDirection: 'row',
    paddingHorizontal: 12,
    gap: 4,
  },
  reactionOption: {
    padding: 8,
    borderRadius: radiusCard,
  },
  reactionOptionText: {
    fontSize: 22,
  },
  actionDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.line.hex,
    marginHorizontal: 16,
    marginVertical: 4,
  },
  actionOption: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 20,
    gap: 14,
  },
  actionIcon: {
    width: 22,
    textAlign: 'center',
  },
  actionOptionText: {
    fontSize: 16,
    fontWeight: '500',
    color: colors.ink.hex,
  },
  actionCancelText: {
    fontWeight: '600',
    color: colors.accent.hex,
    flex: 1,
    textAlign: 'center',
  },
  actionOptionTextDanger: {
    fontSize: 16,
    fontWeight: '500',
    color: colors.danger.hex,
  },
  unreadDivider: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginVertical: 8,
  },
  unreadDividerLine: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.danger.hex + '66',
  },
  unreadDividerText: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.danger.hex,
  },
  callCardRow: {
    alignItems: 'center',
    paddingVertical: 2,
  },
  callCardPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 5,
    backgroundColor: colors.surfaceSunken.hex,
  },
  callCardPillMissed: {
    backgroundColor: colors.danger.hex + '1a',
  },
  callCardGlyph: {
    fontSize: 12,
  },
  callCardText: {
    fontSize: 12,
    color: colors.inkMuted.hex,
  },
  callCardTextMissed: {
    color: colors.danger.hex,
  },
  reactionInfoTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.ink.hex,
    paddingHorizontal: 20,
    paddingBottom: 10,
  },
  reactionInfoName: {
    fontSize: 14,
    color: colors.inkMuted.hex,
    paddingHorizontal: 20,
    paddingVertical: 6,
  },
  swipeRow: {
    position: 'relative',
  },
  replyHint: {
    position: 'absolute',
    left: -28,
    top: 0,
    bottom: 0,
    width: 24,
    justifyContent: 'center',
    alignItems: 'center',
  },
  replyHintText: {
    fontSize: 16,
    color: colors.accent.hex,
  },
});
