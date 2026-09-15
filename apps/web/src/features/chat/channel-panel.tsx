import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, Hash, Lock, Search, Users } from 'lucide-react';
import type { ChannelId, MessageId, UserId } from '@taskflow/contracts';
import { useSession } from '../../lib/session.js';
import { useToast } from '../../lib/toast-context.js';
import { AvatarStack, Button, Empty, IconButton, Skeleton } from '../../components/primitives.js';
import { useMembers } from '../org/use-members.js';
import { CallButton } from '../rtc/call-button.js';
import { callHistoryQuery, type CallHistoryEntry } from '../rtc/api.js';
import { RichTextEditor } from '../work/detail/rich-text-editor.js';
import { EMPTY_DOCUMENT, isEmptyDocument, type DocumentNode } from '../work/detail/rich-text.js';
import { startTyping, stopTyping } from '../../lib/chat-socket.js';
import {
  channelQuery,
  deleteMessage,
  hideMessage,
  editMessage,
  invalidateAllPins,
  invalidateChannel,
  invalidateChannels,
  invalidateMessages,
  invalidatePins,
  invalidateReactions,
  invalidateSaved,
  invalidateUnreadCounts,
  markChannelRead,
  messagesQuery,
  pinMessage,
  pinsQuery,
  reactionsQuery,
  removeChannelMember,
  sendMessage,
  saveMessage,
  savedQuery,
  toggleReaction,
  unpinMessage,
  unsaveMessage,
  updateChannel,
  entryCursorQuery,
  messageAttachmentsQuery,
  messagePreviewsQuery,
  uploadMessageFile,
} from './api.js';
import { ChannelDetailsPanel } from './channel-details.js';
import { CallTimelineCard } from './channel-media.js';
import { messageTextFor, parseCommand } from './slash-commands.js';
import { useChannelRoom } from './use-channel-room.js';
import { groupMessages, type MessageGroup } from './grouping.js';
import { ThreadPanel } from './thread-panel.js';
import {
  AttachFileButton,
  EmojiPickerButton,
  MessageGroupView,
  SlashCommandMenu,
} from './message-list.js';
import {
  appendText,
  channelSubtitle,
  channelTitle,
  dayKeyOf,
  describeTyping,
  firstUnreadAfter,
  flattenDocument,
  formatDayLabel,
  groupByMessage,
  groupReactions,
  textDocument,
  useTypingUsers,
} from './chat-helpers.js';

/* -------------------------------------------------------------------------- *
 * A single channel — messages and the composer
 * -------------------------------------------------------------------------- */

/** One row in the merged timeline — a group of messages or a call event,
    ordered by `at` (an ISO instant) rather than by which query it came from. */
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

/**
 * Three staggered bouncing dots — the animated typing indicator cue.
 */
function TypingDots() {
  return (
    <span aria-hidden="true" className="inline-flex items-center gap-0.5">
      <span className="size-1 animate-bounce rounded-full bg-ink-faint [animation-delay:-300ms]" />
      <span className="size-1 animate-bounce rounded-full bg-ink-faint [animation-delay:-150ms]" />
      <span className="size-1 animate-bounce rounded-full bg-ink-faint" />
    </span>
  );
}

export function ChannelPanel({
  orgId,
  channelId,
  onBack,
}: {
  readonly orgId: string;
  readonly channelId: ChannelId;
  /** Below `md`, returns to the channel list — see `ChatPage`'s own comment. */
  readonly onBack: () => void;
}) {
  const navigate = useNavigate();
  /* `useChannelRoom` still runs — its broadcast invalidation is what makes
     live messages appear — but presence is deliberately not rendered in the
     header anymore: the member/presence readout moved out of the header to
     keep it about the conversation, and the details panel is where who's
     here belongs. */
  const { presence } = useChannelRoom(orgId, channelId);

  const channel = useQuery(channelQuery(orgId, channelId));
  const messages = useQuery(messagesQuery(orgId, channelId));
  const viewerId = useSession((state) => state.userId);
  const { personOf, peopleOf } = useMembers();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<DocumentNode>(EMPTY_DOCUMENT);
  const [detailsOpen, setDetailsOpen] = useState(false);
  /** What the upload is doing right now — presign, PUT, or scan. */
  const [uploadStage, setUploadStage] = useState<string | null>(null);
  const [openThreadId, setOpenThreadId] = useState<string | null>(null);

  const allMessageIds = (messages.data ?? []).map((message) => message.messageId);
  const reactions = useQuery(reactionsQuery(orgId, channelId, allMessageIds));
  const reactionsByMessage = groupReactions(reactions.data ?? []);

  /* Files and link previews for the loaded page, bounded by the same id list
     reactions use. A message with neither costs nothing: both queries are
     disabled while the page is empty and return [] for messages that have
     no rows. */
  const attachments = useQuery(messageAttachmentsQuery(orgId, channelId, allMessageIds));
  const attachmentsByMessage = groupByMessage(attachments.data ?? []);
  const previews = useQuery(messagePreviewsQuery(orgId, channelId, allMessageIds));
  const previewsByMessage = groupByMessage(previews.data ?? []);

  const pins = useQuery(pinsQuery(orgId, channelId));

  /* Every call this conversation has had, merged into the timeline below by
     timestamp — WhatsApp's own "Voice call · 3m 12s" / "Missed voice call"
     placement, not a details-panel-only fact. */
  const calls = useQuery(callHistoryQuery(orgId, channelId));

  /* Saved messages are ORG-wide, not per channel, so this is one query for the
     whole sidebar rather than one per conversation. The set is small by nature
     — a bookmark list nobody prunes is still tens of rows, not thousands. */
  const savedList = useQuery({ ...savedQuery(orgId), enabled: orgId !== '' });
  const savedIds = new Set((savedList.data ?? []).map((row) => row.messageId));
  const pinnedIds = new Set((pins.data ?? []).map((row) => row.messageId));

  /**
   * The first message this person had not read when they opened the channel —
   * where the "new messages" divider goes.
   *
   * ## The cursor has to be frozen, and this is why
   *
   * This panel marks the channel read on every message that arrives while it is
   * mounted. So a divider computed from the LIVE cursor would chase itself: it
   * would appear for one render and vanish, and while someone was reading, it
   * would walk down the list as each new message advanced the cursor past it.
   *
   * `ChannelPanel` is keyed by channel in `ChatPage`, so it remounts whenever
   * the conversation changes — which makes a ref captured on first resolve
   * exactly "the cursor as it was when this channel was opened", with no
   * per-channel bookkeeping of its own.
   *
   * `staleTime: Infinity` stops the shared 15-second poll from refetching under
   * this component; the sidebar's copy of the same query keeps updating for the
   * badges, which is the one place a live count is wanted.
   */
  const entryCursor = useQuery(entryCursorQuery(orgId, channelId));

  const send = useMutation({
    mutationFn: (body: DocumentNode) => sendMessage({ channelId, body }),
    onSuccess: () => {
      invalidateMessages(queryClient, orgId, channelId);
      /* Scroll NOW, before the refetch lands — this is the sender's own
         message, and it must be visible without the reader doing anything.
         Doing it here rather than in the scroll effect removes the race
         where the effect measures the DOM before the refetch adds the
         message and declines to move. (The effect still covers live inbound
         messages; the near-bottom check there is what keeps a reader who has
         scrolled up reading history in place.) */
      const node = scrollRef.current;
      if (node !== null) node.scrollTop = node.scrollHeight;
    },
    onError: (error, body) => {
      toast.failure('The message was not sent', error);
      // Put the draft back, and only if nothing new has been typed since —
      // the same rule `comment-section.tsx` uses. Having shown someone their
      // text in the composer, losing it on a failure is worse than the
      // failure itself.
      setDraft((current) => (isEmptyDocument(current) ? body : current));
    },
  });

  const edit = useMutation({
    mutationFn: (input: { messageId: MessageId; body: DocumentNode }) =>
      editMessage(input.messageId, input.body),
    onSuccess: () => {
      setEditing(null);
      invalidateMessages(queryClient, orgId, channelId);
    },
    onError: (error) => {
      toast.failure('The message was not saved', error);
    },
  });

  const remove = useMutation({
    mutationFn: (messageId: MessageId) => deleteMessage(messageId),
    onSuccess: () => {
      invalidateMessages(queryClient, orgId, channelId);
    },
    onError: (error) => {
      toast.failure('The message was not deleted', error);
    },
  });

  /* "Remove for me" — the per-viewer hide. No tombstone, no event: the message
     stays live for everyone else and this viewer's next refetch simply stops
     returning it. */
  const hide = useMutation({
    mutationFn: (messageId: MessageId) => hideMessage(messageId),
    onSuccess: () => {
      invalidateMessages(queryClient, orgId, channelId);
    },
    onError: (error) => {
      toast.failure('The message could not be hidden', error);
    },
  });

  const toggleSave = useMutation({
    /* Annotated, because the two branches return `{ saved: true }` and
       `{ saved: false }` and TypeScript unifies them to the first one it saw. */
    mutationFn: async (input: {
      messageId: MessageId;
      saved: boolean;
    }): Promise<{ saved: boolean }> =>
      input.saved ? unsaveMessage(input.messageId) : saveMessage(input.messageId),
    onSuccess: () => {
      invalidateSaved(queryClient, orgId);
    },
    onError: (error) => {
      toast.failure('That was not saved', error);
    },
  });

  const react = useMutation({
    mutationFn: (input: { messageId: MessageId; emoji: string }) =>
      toggleReaction({ channelId, ...input }),
    onSuccess: () => {
      invalidateReactions(queryClient, orgId, channelId);
    },
    onError: (error) => {
      toast.failure('The reaction was not saved', error);
    },
  });

  const togglePin = useMutation({
    mutationFn: async (input: { messageId: MessageId; pinned: boolean }) => {
      if (input.pinned) {
        await unpinMessage({ channelId, messageId: input.messageId });
      } else {
        await pinMessage({ channelId, messageId: input.messageId });
      }
    },
    onSuccess: () => {
      invalidatePins(queryClient, orgId, channelId);
      invalidateAllPins(queryClient, orgId);
    },
    onError: (error) => {
      toast.failure('The pin was not saved', error);
    },
  });

  const canPost = channel.data?.capabilities.post ?? false;

  /**
   * Uploads a file against the LAST message this person sent.
   *
   * An attachment hangs off a message, and until a message exists there is no
   * channel to authorize the upload against (`attachment.service.ts`). So the
   * flow is: if the composer has text, send it and attach to that; otherwise
   * post a short message naming the file and attach to it. Either way the
   * ordering is message-then-file, which is what makes the authorization
   * answerable rather than a UX preference.
   */
  const attach = useMutation({
    mutationFn: async (file: File) => {
      const carrier = isEmptyDocument(draft)
        ? await sendMessage({
            channelId,
            body: {
              type: 'doc',
              content: [
                {
                  type: 'paragraph',
                  content: [
                    { type: 'text', text: 'Shared ' },
                    {
                      type: 'text',
                      text: file.name,
                      marks: [{ type: 'bold' }],
                    },
                  ],
                },
              ],
            },
          })
        : await sendMessage({ channelId, body: draft });

      setDraft(EMPTY_DOCUMENT);
      stopTyping(channelId);

      return uploadMessageFile(carrier.messageId as MessageId, file, setUploadStage);
    },
    onSuccess: (result) => {
      if (result.status === 'clean') {
        toast.show('File uploaded');
      } else {
        /* `infected` and `rejected` are NOT errors — the pipeline worked and
           refused the file. Reporting them as failures would suggest retrying,
           which cannot help. */
        toast.failure(
          result.status === 'infected'
            ? 'That file was rejected: malware detected'
            : `That file was rejected: ${result.reason ?? 'it did not pass verification'}`,
          null,
        );
      }
    },
    onError: (error) => {
      toast.failure('The file was not uploaded', error);
    },
    onSettled: () => {
      setUploadStage(null);
      invalidateMessages(queryClient, orgId, channelId);
    },
  });

  const submit = (): void => {
    if (isEmptyDocument(draft)) return;

    /* Slash commands are interpreted HERE, in the client, and each one resolves
       to an ordinary tRPC call that enforces its own permission (see
       `slash-commands.ts` on why there is no `commands.run` endpoint). A
       message that merely starts with a slash — "/etc/passwd is broken" — is
       not a command and is sent unchanged. */
    const parsed = parseCommand(flattenDocument(draft));

    if (parsed.kind === 'unknown') {
      toast.failure(`There is no /${parsed.name} command`, null);
      return;
    }

    if (parsed.kind === 'command') {
      const replacement = messageTextFor(parsed);

      if (replacement !== null) {
        setDraft(EMPTY_DOCUMENT);
        stopTyping(channelId);
        send.mutate(textDocument(replacement));
        return;
      }

      setDraft(EMPTY_DOCUMENT);
      stopTyping(channelId);
      runCommand.mutate(parsed);
      return;
    }

    const body = draft;
    setDraft(EMPTY_DOCUMENT);
    stopTyping(channelId);
    send.mutate(body);
  };

  /** The commands that ACT rather than say something. */
  const runCommand = useMutation({
    mutationFn: async (parsed: ReturnType<typeof parseCommand>) => {
      if (parsed.kind !== 'command') return;

      if (parsed.command.name === 'topic') {
        await updateChannel({
          channelId,
          name: channel.data?.name ?? '',
          topic: parsed.argument === '' ? null : parsed.argument,
        });
        return;
      }

      if (parsed.command.name === 'leave' && viewerId !== null) {
        await removeChannelMember(channelId, viewerId as UserId);
      }
    },
    onSuccess: () => {
      invalidateChannel(queryClient, orgId, channelId);
      invalidateChannels(queryClient, orgId);
    },
    onError: (error) => {
      toast.failure('That command did not run', error);
    },
  });

  /* `messages.list` orders newest-first (`message.service.ts`'s own
     `before`-cursor pagination needs the most recent page, not the oldest),
     but a chat pane reads top-to-bottom chronologically like every other
     chat product — oldest at the top, newest just above the composer. The
     API's order is right for "give me the latest page and let me page
     backwards from it"; this reverses it for the one thing that reads it
     as a transcript. */
  const topLevel = (messages.data ?? [])
    .filter((message) => message.parentMessageId === null)
    .toReversed();
  const groups = groupMessages(topLevel);

  /**
   * Messages and calls, interleaved by timestamp — the WhatsApp placement
   * §7's own "no listing UI" note left as a gap: a call happened AT A POINT
   * in the conversation, between two messages, not off to one side. String
   * comparison is safe here because both timestamps are the same server's
   * `Date.prototype.toISOString()` output — fixed-width, UTC, `Z`-suffixed —
   * so lexicographic order already agrees with chronological order.
   */
  const timeline: readonly TimelineItem[] = [
    ...groups.map((group): TimelineItem => ({
      kind: 'messages',
      key: group.messages[0]?.messageId ?? '',
      at: group.messages[0]?.createdAt ?? '',
      group,
    })),
    ...(calls.data ?? []).map((entry): TimelineItem => ({
      kind: 'call',
      key: entry.sessionId,
      at: entry.createdAt,
      entry,
    })),
  ].sort((a, b) => a.at.localeCompare(b.at));

  /**
   * Where the "new messages" divider goes.
   *
   * Derived from `topLevel` — the list that is actually RENDERED — and not from
   * `messages.data`, which is the same rows in the opposite order with thread
   * replies still in it. Using the raw query result here was wrong twice over,
   * and the two mistakes hid each other:
   *
   *   * `messages.list` returns NEWEST FIRST, so "the message after the cursor"
   *     resolved to the next OLDER one — the line was computed for a message
   *     above where it belonged.
   *   * The raw list includes replies, which are filtered out of `topLevel` and
   *     rendered inside a thread panel instead. When the cursor landed next to
   *     one, the divider named a message that appears in no group, and nothing
   *     drew it at all.
   *
   * Neither failed loudly: the first put the line in the wrong place and the
   * second removed it entirely, which is indistinguishable from "you have no
   * unread messages". The rule that prevents both is that the divider is
   * computed from the same array, in the same order, that the map below walks.
   */
  const firstUnreadId = firstUnreadAfter(
    entryCursor.data,
    topLevel.map((message) => message.messageId),
  );
  /* The author of that first unread message — the divider render gates on
     `!== viewerId` (see the render site's comment on why a viewer's own
     message is not "new"). */
  const firstUnreadAuthorId =
    topLevel.find((message) => message.messageId === firstUnreadId)?.authorId ?? null;

  /* Computed from the same page rather than a separate count query — a
     channel's first 100 messages are already loaded whole, replies included,
     so "how many replies does this message have" is a filter over data
     already in memory. */
  const replyCounts = new Map<string, number>();
  for (const message of messages.data ?? []) {
    if (message.parentMessageId === null) continue;
    replyCounts.set(message.parentMessageId, (replyCounts.get(message.parentMessageId) ?? 0) + 1);
  }

  const scrollRef = useRef<HTMLDivElement>(null);
  /* The last message id we SCROLLED to. Opening a conversation must land at
     the newest line no matter what — that is the "open a chat, see the
     latest" contract — and a message sent from this tab must be visible
     without scrolling. After the first anchor, a new message only auto-scrolls
     when the reader is already near the bottom; someone scrolled up reading
     history must not be yanked down. */
  const lastAnchoredIdRef = useRef<string | null>(null);

  /* Bottom-anchored, like every chat product trains people to expect: a
     conversation is read newest-first from the bottom, not discovered by
     scrolling down from wherever the list happened to mount.

     `useLayoutEffect` — the scroll runs after the DOM mutation and before
     paint, so `scrollHeight` already counts the message that just rendered;
     an ordinary effect can fire against the pre-update layout. The panel is
     keyed by channel, so a new `lastMessageId` is exactly "a new last
     message rendered" — send, live arrival, or the first page landing after
     the skeleton.

     Keyed on the LAST MESSAGE ID: it changes exactly when a genuinely new
     last message renders. */
  const lastMessageId = topLevel.at(-1)?.messageId;
  useLayoutEffect(() => {
    if (lastMessageId === undefined) return;
    const node = scrollRef.current;
    if (node === null) return;
    const firstAnchor = lastAnchoredIdRef.current === null;
    /* 160, not 80: the message list's own bottom padding (the composer gap
       and the last bubble's margin) keeps a reader who IS at the bottom
       ~90-100px from `scrollHeight` — an 80px threshold measured them as
       scrolled up and refused to follow the new message. Measured live: a
       bottom-anchored reader sat at sh-st-ch = 99. */
    const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 160;
    if (!firstAnchor && !atBottom) return;
    node.scrollTop = node.scrollHeight;
    lastAnchoredIdRef.current = lastMessageId;
  }, [lastMessageId, channelId]);

  /* Marks the channel read up to the newest message every time one arrives
     while this panel is mounted — "open" is the closest signal this build has
     to "read" (§3.6's own scope: no per-message read receipts, no scroll-
     position tracking). `markRead` itself is the one that refuses to move
     backward, so calling it on every render of a new last message is safe to
     repeat. */
  useEffect(() => {
    if (lastMessageId === undefined) return;

    /* ORDERED AFTER the entry cursor has been read, and that ordering is the
       whole correctness of the "new messages" divider.

       Both of these touch the same cursor: this advances it, and
       `entryCursorQuery` reads it to decide where the line goes. Started
       together they race — if this wins, the line never appears; if the read
       wins, it appears. Which one happened was down to network timing, so the
       divider showed up on some channel opens and not others, with nothing to
       distinguish the two cases. Waiting for the read makes the line a function
       of what the person had actually seen. */
    if (!entryCursor.isSuccess) return;

    markChannelRead({ channelId, messageId: lastMessageId as MessageId })
      .then(() => {
        invalidateUnreadCounts(queryClient, orgId);
        /* `entryCursorQuery` is a FROZEN snapshot (`staleTime: Infinity`)
           captured when the channel opened — so without this, the "new
           messages" divider would be computed against the PRE-SEND cursor
           and stay above the sender's own just-sent message, which is the
           "it shows new-msg to me" report. The cursor just advanced on the
           server (that is what this `.then` is waiting for), so invalidating
           the channel key (which `entry-cursor` extends) re-freezes it at
           the new position. */
        invalidateChannel(queryClient, orgId, channelId);
      })
      .catch(() => {
        // Best-effort — an unread badge staying one message stale is not
        // worth surfacing to the person reading the channel right now.
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- queryClient/orgId are stable
  }, [channelId, lastMessageId, entryCursor.isSuccess]);

  const typingUsers = useTypingUsers(channelId, viewerId);
  const typingLabel = describeTyping(typingUsers, personOf);

  /**
   * A channel that does not exist and a channel this caller cannot read
   * answer identically: NOT_FOUND (`packages/policy/src/enforce.ts` — 403
   * would confirm the channel exists across a boundary that is supposed to
   * be invisible). This is that answer's ONE consumer with a screen to
   * render, so it has to make the same non-disclosure choice the server
   * already made: never say "you don't have access" specifically, because
   * that is exactly the confirmation NOT_FOUND was chosen to avoid handing
   * back. Same reasoning as a pasted board/card link answering NOT_A_MEMBER
   * with a redirect rather than an explanation (CLAUDE.md, Phase 3 web notes).
   *
   * Every hook above still runs unconditionally on every render — this is
   * the trailing branch of the function body, not a conditional hook call.
   */
  if (channel.isError) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-8">
        <Empty
          title="This conversation isn't available"
          description="It may not exist, or you may not have access to it."
          action={
            <Button
              variant="secondary"
              onClick={() => {
                void navigate({ to: '/chat', search: { channel: undefined } });
              }}
            >
              Back to your conversations
            </Button>
          }
        />
      </div>
    );
  }

  return (
    /* `relative`: the positioning context for the details and thread panels'
       mobile overlays below. On a phone those panels sit ON TOP of the
       conversation (their own `absolute inset-y-0 w-full`), because a fixed
       `w-72`/`w-80` child next to the message column would crush it into a
       sliver — 288px of the ~360px a phone has, spent on a roster. At `md`
       they are ordinary flex children again and this class changes nothing. */
    <div className="relative flex min-h-0 flex-1">
      {/* `min-w-0` is what makes the comment on the details panel below true.
          A flex item's `min-width` defaults to `auto`, which is its content's
          min-content width — so without this the message column cannot shrink
          past its widest unbreakable content and pushes the row wider than the
          viewport instead, which is the opposite of "the message column
          shrinks rather than either panel overflowing the page". `min-h-0`
          already carries the identical argument for the other axis. */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex h-13 shrink-0 items-center gap-2.5 border-b border-line/50 px-3 sm:px-4">
          {/* Mobile back button — below `md` only. */}
          <button
            type="button"
            onClick={onBack}
            aria-label="Back to conversations"
            className="flex size-8 shrink-0 items-center justify-center rounded-lg text-ink-muted hover:bg-surface-hover hover:text-ink md:hidden"
          >
            <ChevronLeft aria-hidden="true" className="size-4" />
          </button>
          {/* Channel name — toggles the details panel on all screen sizes.
              On mobile the separate ChevronLeft back button above handles
              navigation back to the channel list, so tapping the name
              opens details rather than duplicating the back affordance. */}
          <button
            type="button"
            onClick={() => { setDetailsOpen((o) => !o); }}
            aria-label="Toggle channel details"
            className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-1 py-1.5 text-left hover:bg-surface-hover md:cursor-pointer"
          >
            {channel.data?.type === 'public' && (
              <Hash
                aria-hidden="true"
                className="size-4 shrink-0 text-ink-faint"
                strokeWidth={2.5}
              />
            )}
            {channel.data?.type === 'private' && (
              <Lock
                aria-hidden="true"
                className="size-4 shrink-0 text-ink-faint"
                strokeWidth={2.5}
              />
            )}
            <span className="min-w-0 flex-1">
              <span className="block min-w-0 truncate font-display text-[15px] font-semibold leading-tight text-ink">
                {channel.data === undefined ? '…' : channelTitle(channel.data, viewerId, personOf)}
              </span>
              {channel.data !== undefined && channelSubtitle(channel.data) !== null && (
                <span className="block min-w-0 truncate text-xs leading-tight text-ink-faint">
                  {channelSubtitle(channel.data)}
                </span>
              )}
              {channel.data !== undefined && channel.data.type !== 'dm' && (
                <span className="block text-xs leading-tight text-ink-faint">
                  {channel.data.memberIds.length}{' '}
                  {channel.data.memberIds.length === 1 ? 'member' : 'members'}
                </span>
              )}
            </span>
          </button>
          {/* Overlapping-avatar preview for non-DM channels. */}
          {channel.data !== undefined && channel.data.type !== 'dm' && (
            <div className="hidden shrink-0 sm:flex">
              <AvatarStack
                people={peopleOf(channel.data.memberIds)}
                max={3}
              />
            </div>
          )}
          {/* Search — navigates to the app's real search. */}
          <IconButton
            onClick={() => {
              void navigate({ to: '/search', search: { q: 'type = message' } });
            }}
            aria-label="Search messages"
          >
            <Search aria-hidden="true" className="size-4" strokeWidth={2.25} />
          </IconButton>
          {/* In-app voice (Phase 13). Public channels cannot start a call in
              Wave 1 — the ring list comes from the channel's member tuples and
              a public channel has none, so the control is not offered rather
              than offered and refused (ai/phase-13-webrtc.md §6). Everything
              else about permission is the server's answer, not this file's. */}
          {channel.data !== undefined && channel.data.type !== 'public' && (
            <CallButton orgId={orgId} channelId={channelId} />
          )}
          {/* Channel details (members, media, retention). */}
          <IconButton
            onClick={() => {
              setDetailsOpen((open) => !open);
            }}
            aria-label="Channel details"
            active={detailsOpen}
          >
            <Users aria-hidden="true" className="size-4" strokeWidth={2.25} />
          </IconButton>
        </header>

        {/* `px-3 sm:px-4`, matched by the header, the typing line and the
            composer below so their left edges stay on one line. 1rem of gutter
            on each side of a phone is 8.5% of the viewport spent on nothing,
            and it comes straight out of the message column — see the bubble's
            own comment on where a phone's width actually goes. */}
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-3 sm:px-4">
          {messages.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-10 w-3/4" />
              <Skeleton className="h-10 w-1/2" />
            </div>
          ) : timeline.length === 0 ? (
            <Empty
              title="No messages yet"
              description="Say something to get the conversation going."
            />
          ) : (
            <div className="space-y-4">
              {timeline.map((item, index) => {
                const previous = index > 0 ? timeline[index - 1] : undefined;
                const showDayDivider =
                  previous === undefined || dayKeyOf(item.at) !== dayKeyOf(previous.at);

                const dayDivider = showDayDivider && (
                  <div className="flex items-center gap-2" role="separator">
                    <span className="h-px flex-1 bg-line/60" />
                    <span className="text-xs font-medium text-ink-faint">
                      {formatDayLabel(item.at)}
                    </span>
                    <span className="h-px flex-1 bg-line/60" />
                  </div>
                );

                return item.kind === 'call' ? (
                  <Fragment key={item.key}>
                    {dayDivider}
                    <CallTimelineCard
                      entry={item.entry}
                      viewerId={viewerId}
                      personOf={personOf}
                    />
                  </Fragment>
                ) : (
                  <Fragment key={item.key}>
                    {dayDivider}
                    {/* The "new messages" line, placed by the read CURSOR rather
                        than by counting back from the end. A count-based position
                        lands somewhere plausible and wrong the moment a message
                        is deleted or the page is partially loaded — and it does so
                        silently, which is the worst property a divider can have.

                        Suppressed when the first unread message is the viewer's
                        OWN — the cursor advances in the same beat as the send,
                        so the line would otherwise flash above your own just-sent
                        message for a render or two. "New" means "arrived while
                        you were away", and your own message is not that.

                        Recolored from `danger` to `accent` during the warm-dark
                        rebuild's own Chat-module pass
                        (ai/design-rebuild-warm-dark.md §5): this line is purely
                        informational — "you left off here" — never an error or a
                        warning, and `danger` (red) is this app's own reserved
                        vocabulary for exactly those, used nowhere else for a
                        neutral marker. The label is now a real pill, using
                        `--shadow-glow-accent` (`styles.css`) — a token that had
                        been correctly kept branding-aware across two separate
                        accent-hue rebuilds and had NO consumer anywhere in
                        apps/web until this — for the same "inner glow for
                        focused/active elements" role its own header already
                        names. A cursor position genuinely is that: the one
                        thing on screen this render is drawing the eye to. */}
                    {firstUnreadId !== null &&
                      firstUnreadAuthorId !== viewerId &&
                      item.group.messages.some(
                        (message) => message.messageId === firstUnreadId,
                      ) && (
                        <div className="flex items-center gap-2" role="separator">
                          <span className="h-px flex-1 bg-accent/40" />
                          <span className="shadow-glow-accent rounded-full bg-accent/10 px-2.5 py-0.5 text-[11px] font-medium text-accent">
                            New messages
                          </span>
                          <span className="h-px flex-1 bg-accent/40" />
                        </div>
                      )}
                    <MessageGroupView
                      group={item.group}
                      canModerate={channel.data?.capabilities.moderate ?? false}
                      viewerId={viewerId}
                      authorLabel={
                        item.group.authorId === null ? null : personOf(item.group.authorId).label
                      }
                      editingId={editing}
                      onStartEdit={setEditing}
                      onCancelEdit={() => {
                        setEditing(null);
                      }}
                      onSaveEdit={(messageId, body) => {
                        edit.mutate({ messageId: messageId as MessageId, body });
                      }}
                      editPending={edit.isPending}
                      onDelete={(messageId) => {
                        remove.mutate(messageId as MessageId);
                      }}
                      onHide={(messageId) => {
                        hide.mutate(messageId as MessageId);
                      }}
                      reactionsByMessage={reactionsByMessage}
                      attachmentsByMessage={attachmentsByMessage}
                      savedIds={savedIds}
                      onToggleSave={(messageId, saved) => {
                        toggleSave.mutate({ messageId: messageId as MessageId, saved });
                      }}
                      previewsByMessage={previewsByMessage}
                      personOf={personOf}
                      onToggleReaction={(messageId, emoji) => {
                        react.mutate({ messageId: messageId as MessageId, emoji });
                      }}
                      pinnedIds={pinnedIds}
                      onTogglePin={(messageId, pinned) => {
                        togglePin.mutate({ messageId: messageId as MessageId, pinned });
                      }}
                      replyCounts={replyCounts}
                      onOpenThread={setOpenThreadId}
                    />
                  </Fragment>
                );
              })}
            </div>
          )}
        </div>

        {typingLabel !== null && (
          <div className="flex h-5 shrink-0 items-center gap-1.5 px-3 text-xs text-ink-faint sm:px-4">
            <TypingDots />
            <span className="italic">{typingLabel}</span>
          </div>
        )}

        {/* The composer is hidden when the server says this person cannot post
            — a `viewer` tuple on a channel, or an archived channel. Both are
            the server's answer (`capabilitiesFor`), not a rule re-derived here.
            While the channel is still loading `post` is false, which shows the
            notice for a moment rather than a composer that might be refused. */}
        {channel.data !== undefined && !channel.data.capabilities.post ? (
          <div className="shrink-0 border-t border-line px-3 py-3 text-xs text-ink-faint sm:px-4">
            {channel.data.archivedAt !== null
              ? 'This channel is archived. No new messages can be posted.'
              : 'You have read-only access to this conversation.'}
          </div>
        ) : (
          <div className="shrink-0 border-t border-line px-3 py-3 sm:px-4">
            {/* Named stages rather than a spinner: "Scanning…" is the one that
              takes a noticeable moment, and saying so is the difference between
              a slow upload and a stuck one. */}
            {uploadStage !== null && <p className="mb-1 text-xs text-ink-faint">{uploadStage}</p>}
            <SlashCommandMenu draft={draft} />
            <RichTextEditor
              value={draft}
              /* The composer matches the bubbles: 14px, so the message you are
                 writing reads at the same size it will be sent at. */
              className="text-sm"
              placeholder="Message… (Enter to send, Shift+Enter for a new line)"
              onChange={(next) => {
                setDraft(next);
                startTyping(channelId);
              }}
              onSubmit={submit}
              footer={
                <div className="flex items-center gap-1">
                  <EmojiPickerButton
                    onPick={(emoji) => {
                      setDraft((current) => appendText(current, emoji));
                    }}
                  />
                  <AttachFileButton
                    disabled={!canPost || attach.isPending}
                    onPick={(file) => {
                      attach.mutate(file);
                    }}
                  />
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={isEmptyDocument(draft) || send.isPending}
                    onClick={submit}
                  >
                    Send
                  </Button>
                </div>
              }
            />
          </div>
        )}
      </div>

      {openThreadId !== null &&
        (() => {
          const rootMessage = (messages.data ?? []).find(
            (message) => message.messageId === openThreadId,
          );
          if (rootMessage === undefined) return null;
          return (
            <ThreadPanel
              orgId={orgId}
              channelId={channelId}
              rootMessage={rootMessage}
              personOf={personOf}
              onClose={() => {
                setOpenThreadId(null);
              }}
            />
          );
        })()}

      {/* Details and a thread are both right-hand panels. Rendering the thread
          first and this second means opening a thread while details are open
          shows both, which at 72rem+ is fine and below it is not — but the
          layout is `flex`, so the message column shrinks rather than either
          panel overflowing the page. */}
      {detailsOpen && (
        <ChannelDetailsPanel
          orgId={orgId}
          channelId={channelId}
          presence={presence}
          onClose={() => {
            setDetailsOpen(false);
          }}
        />
      )}
    </div>
  );
}
