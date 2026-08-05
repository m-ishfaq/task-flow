import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Popover from '@radix-ui/react-popover';
import type { ChannelId, MessageId, UserId } from '@taskflow/contracts';
import { useSession } from '../../lib/session.js';
import { cn } from '../../lib/cn.js';
import { useToast } from '../../lib/toast-context.js';
import {
  Avatar,
  Button,
  Empty,
  Field,
  FocusOnMountInput,
  Input,
  Skeleton,
} from '../../components/primitives.js';
import { useMembers } from '../org/use-members.js';
import { RichTextEditor, RichTextView } from '../work/detail/rich-text-editor.js';
import { EMPTY_DOCUMENT, isEmptyDocument, type DocumentNode } from '../work/detail/rich-text.js';
import { onTyping, startTyping, stopTyping } from '../../lib/chat-socket.js';
import {
  channelQuery,
  channelsQuery,
  createChannel,
  deleteMessage,
  editMessage,
  invalidateChannels,
  invalidateMessages,
  invalidatePins,
  invalidateReactions,
  invalidateUnreadCounts,
  markChannelRead,
  messagesQuery,
  openDirectMessage,
  pinMessage,
  pinsQuery,
  reactionsQuery,
  sendMessage,
  threadQuery,
  toggleReaction,
  unpinMessage,
  unreadCountsQuery,
  type ChannelSummary,
  type Message,
  type PinnedMessageRow,
  type ReactionRow,
} from './api.js';
import { useChannelRoom } from './use-channel-room.js';
import { groupMessages, type MessageGroup } from './grouping.js';

/** The fixed emoji palette the reaction picker offers — see `reaction.service.ts`
 * on why the server does not restrict the set: curating taste is a client job. */
const QUICK_REACTIONS = ['👍', '❤️', '😂', '🎉', '👀', '✅'] as const;

/** How long after the last keystroke a typing indicator auto-clears. */
const TYPING_TIMEOUT_MS = 4000;

/**
 * Channels and direct messages (ai/phase-5-chat.md §5 Wave 1).
 *
 * Two panels, neither of which re-derives authorization (CLAUDE.md, §8.2):
 * `channels.list` already omits everything the caller cannot open, so the list
 * on the left needs no visibility logic of its own, and every mutation here
 * — send, edit, delete, create — is offered to whoever can reach the button
 * and answered honestly by the server if they cannot.
 *
 * The selected channel lives in the URL (`?channel=`), the same reasoning
 * `board-page.tsx` gives for keeping `card` there: it is what makes a
 * conversation a shareable link and what survives a reload.
 */
export function ChatPage() {
  const orgId = useSession((state) => state.orgId) ?? '';
  const navigate = useNavigate();
  const search = useSearch({ from: '/chat', select: (value) => value.channel });

  const selectChannel = (channelId: ChannelId | undefined) => {
    void navigate({ to: '/chat', search: { channel: channelId } });
  };

  return (
    <div className="flex h-full min-h-0">
      <ChannelListPanel orgId={orgId} selected={search ?? null} onSelect={selectChannel} />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {search === undefined ? (
          <Empty
            title="No conversation open"
            description="Pick a channel or direct message on the left, or start a new one."
          />
        ) : (
          <ChannelPanel key={search} orgId={orgId} channelId={search} />
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 * Channel list
 * -------------------------------------------------------------------------- */

function ChannelListPanel({
  orgId,
  selected,
  onSelect,
}: {
  readonly orgId: string;
  readonly selected: ChannelId | null;
  readonly onSelect: (channelId: ChannelId | undefined) => void;
}) {
  const channels = useQuery({ ...channelsQuery(orgId), enabled: orgId !== '' });
  const list = channels.data ?? [];

  const unread = useQuery({
    ...unreadCountsQuery(
      orgId,
      list.map((channel) => channel.channelId),
    ),
    enabled: orgId !== '' && list.length > 0,
  });
  const unreadByChannel = new Map((unread.data ?? []).map((row) => [row.channelId, row.unreadCount]));

  const rooms = list.filter((channel) => channel.type === 'public' || channel.type === 'private');
  const directs = list.filter((channel) => channel.type === 'dm' || channel.type === 'group_dm');

  return (
    <aside
      aria-label="Conversations"
      className="flex w-64 shrink-0 flex-col overflow-y-auto border-r border-line bg-surface-raised"
    >
      <div className="flex items-center justify-between px-3 pt-3 pb-1">
        <h2 className="text-xs font-semibold tracking-wide text-ink-muted uppercase">Channels</h2>
        <NewChannelPopover orgId={orgId} onCreated={onSelect} />
      </div>

      {channels.isLoading ? (
        <div className="space-y-1 px-3">
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-full" />
        </div>
      ) : (
        <ul className="px-1.5 pb-2">
          {rooms.map((channel) => (
            <ChannelRow
              key={channel.channelId}
              channel={channel}
              label={channel.name ?? '(unnamed)'}
              active={selected === channel.channelId}
              unreadCount={unreadByChannel.get(channel.channelId) ?? 0}
              onSelect={onSelect}
            />
          ))}
          {rooms.length === 0 && (
            <li className="px-2 py-1 text-xs text-ink-faint">No channels yet.</li>
          )}
        </ul>
      )}

      <div className="flex items-center justify-between px-3 pt-3 pb-1">
        <h2 className="text-xs font-semibold tracking-wide text-ink-muted uppercase">
          Direct messages
        </h2>
        <NewDirectMessagePopover orgId={orgId} onOpened={onSelect} />
      </div>

      <ul className="px-1.5 pb-3">
        {directs.map((channel) => (
          <ChannelRow
            key={channel.channelId}
            channel={channel}
            label={channel.name ?? 'Direct message'}
            active={selected === channel.channelId}
            unreadCount={unreadByChannel.get(channel.channelId) ?? 0}
            onSelect={onSelect}
          />
        ))}
        {directs.length === 0 && (
          <li className="px-2 py-1 text-xs text-ink-faint">No conversations yet.</li>
        )}
      </ul>
    </aside>
  );
}

function ChannelRow({
  channel,
  label,
  active,
  unreadCount,
  onSelect,
}: {
  readonly channel: ChannelSummary;
  readonly label: string;
  readonly active: boolean;
  readonly unreadCount: number;
  readonly onSelect: (channelId: ChannelId) => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={() => {
          onSelect(channel.channelId as ChannelId);
        }}
        className={cn(
          'flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-sm',
          active
            ? 'bg-accent text-accent-ink'
            : 'text-ink-muted hover:bg-surface-hover hover:text-ink',
        )}
      >
        <span className="min-w-0 flex-1 truncate">
          {channel.type === 'public' ? '# ' : channel.type === 'private' ? '🔒 ' : ''}
          {label}
        </span>
        {unreadCount > 0 && (
          <span
            className={cn(
              'flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full px-1 text-[10px] font-semibold',
              active ? 'bg-accent-ink/20 text-accent-ink' : 'bg-accent text-accent-ink',
            )}
          >
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>
    </li>
  );
}

function NewChannelPopover({
  orgId,
  onCreated,
}: {
  readonly orgId: string;
  readonly onCreated: (channelId: ChannelId) => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [type, setType] = useState<'public' | 'private'>('public');

  const create = useMutation({
    mutationFn: () => createChannel({ type, name }),
    onSuccess: (result) => {
      invalidateChannels(queryClient, orgId);
      setOpen(false);
      setName('');
      onCreated(result.channelId as ChannelId);
    },
    onError: (error) => {
      toast.failure('The channel was not created', error);
    },
  });

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setName('');
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label="New channel"
          className="flex h-5 w-5 items-center justify-center rounded text-xs text-ink-faint hover:bg-surface-hover hover:text-ink"
        >
          +
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          className="w-64 space-y-2 rounded border border-line bg-surface-raised p-3 shadow-xl"
        >
          <Field label="Name" htmlFor="new-channel-name">
            <FocusOnMountInput
              id="new-channel-name"
              value={name}
              placeholder="e.g. general"
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
          </Field>

          <div className="flex gap-1">
            <button
              type="button"
              onClick={() => {
                setType('public');
              }}
              className={cn(
                'flex-1 rounded px-2 py-1 text-xs',
                type === 'public'
                  ? 'bg-accent text-accent-ink'
                  : 'text-ink-muted ring-1 ring-line hover:bg-surface-hover',
              )}
            >
              Public
            </button>
            <button
              type="button"
              onClick={() => {
                setType('private');
              }}
              className={cn(
                'flex-1 rounded px-2 py-1 text-xs',
                type === 'private'
                  ? 'bg-accent text-accent-ink'
                  : 'text-ink-muted ring-1 ring-line hover:bg-surface-hover',
              )}
            >
              Private
            </button>
          </div>

          <Button
            size="sm"
            variant="primary"
            className="w-full"
            disabled={name.trim() === '' || create.isPending}
            onClick={() => {
              create.mutate();
            }}
          >
            Create channel
          </Button>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function NewDirectMessagePopover({
  orgId,
  onOpened,
}: {
  readonly orgId: string;
  readonly onOpened: (channelId: ChannelId) => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const { people } = useMembers();
  const viewerId = useSession((state) => state.userId);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const start = useMutation({
    mutationFn: (userId: UserId) => openDirectMessage([userId]),
    onSuccess: (result) => {
      invalidateChannels(queryClient, orgId);
      setOpen(false);
      onOpened(result.channelId as ChannelId);
    },
    onError: (error) => {
      toast.failure('The conversation could not be opened', error);
    },
  });

  const needle = query.trim().toLowerCase();
  const candidates = people.filter((member) => member.userId !== viewerId);
  const filtered =
    needle === ''
      ? candidates
      : candidates.filter((member) => member.email.toLowerCase().includes(needle));

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery('');
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label="New direct message"
          className="flex h-5 w-5 items-center justify-center rounded text-xs text-ink-faint hover:bg-surface-hover hover:text-ink"
        >
          +
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          className="w-64 space-y-1.5 rounded border border-line bg-surface-raised p-2 shadow-xl"
        >
          <Input
            aria-label="Search people"
            placeholder="Search people…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
            className="h-7 text-xs"
          />

          {filtered.length === 0 ? (
            <p className="p-1 text-xs text-ink-faint">No matches.</p>
          ) : (
            <ul className="max-h-56 space-y-0.5 overflow-y-auto">
              {filtered.map((member) => (
                <li key={member.userId}>
                  <button
                    type="button"
                    disabled={start.isPending}
                    onClick={() => {
                      start.mutate(member.userId as UserId);
                    }}
                    className="flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs text-ink-muted hover:bg-surface-hover hover:text-ink"
                  >
                    <Avatar userId={member.userId} label={member.email} size="xs" />
                    <span className="truncate">{member.email}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/* -------------------------------------------------------------------------- *
 * A single channel — messages and the composer
 * -------------------------------------------------------------------------- */

function ChannelPanel({
  orgId,
  channelId,
}: {
  readonly orgId: string;
  readonly channelId: ChannelId;
}) {
  useChannelRoom(orgId, channelId);

  const channel = useQuery(channelQuery(orgId, channelId));
  const messages = useQuery(messagesQuery(orgId, channelId));
  const viewerId = useSession((state) => state.userId);
  const { personOf } = useMembers();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<DocumentNode>(EMPTY_DOCUMENT);
  const [pinsOpen, setPinsOpen] = useState(false);
  const [openThreadId, setOpenThreadId] = useState<string | null>(null);

  const allMessageIds = (messages.data ?? []).map((message) => message.messageId);
  const reactions = useQuery(reactionsQuery(orgId, channelId, allMessageIds));
  const reactionsByMessage = groupReactions(reactions.data ?? []);

  const pins = useQuery(pinsQuery(orgId, channelId));
  const pinnedIds = new Set((pins.data ?? []).map((row) => row.messageId));

  const send = useMutation({
    mutationFn: (body: DocumentNode) => sendMessage({ channelId, body }),
    onSuccess: () => {
      invalidateMessages(queryClient, orgId, channelId);
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
    },
    onError: (error) => {
      toast.failure('The pin was not saved', error);
    },
  });

  const submit = (): void => {
    if (isEmptyDocument(draft)) return;
    const body = draft;
    setDraft(EMPTY_DOCUMENT);
    stopTyping(channelId);
    send.mutate(body);
  };

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

  /* Bottom-anchored, like every chat product trains people to expect: a
     conversation is read newest-first from the bottom, not discovered by
     scrolling down from wherever the list happened to mount. Re-runs on
     every length change — a message arriving live (`use-channel-room.ts`
     invalidating this same query) re-triggers it exactly like one this tab
     just sent. */
  useEffect(() => {
    const node = scrollRef.current;
    if (node === null) return;
    node.scrollTop = node.scrollHeight;
  }, [topLevel.length, channelId]);

  /* Marks the channel read up to the newest message every time one arrives
     while this panel is mounted — "open" is the closest signal this build has
     to "read" (§3.6's own scope: no per-message read receipts, no scroll-
     position tracking). `markRead` itself is the one that refuses to move
     backward, so calling it on every render of a new last message is safe to
     repeat. */
  const lastMessageId = topLevel.at(-1)?.messageId;
  useEffect(() => {
    if (lastMessageId === undefined) return;
    markChannelRead({ channelId, messageId: lastMessageId as MessageId })
      .then(() => {
        invalidateUnreadCounts(queryClient, orgId);
      })
      .catch(() => {
        // Best-effort — an unread badge staying one message stale is not
        // worth surfacing to the person reading the channel right now.
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- queryClient/orgId are stable
  }, [channelId, lastMessageId]);

  const typingUsers = useTypingUsers(channelId, viewerId);
  const typingLabel = describeTyping(typingUsers, personOf);

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-h-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
          <h2 className="min-w-0 flex-1 truncate text-sm font-medium text-ink">
            {channel.data === undefined
              ? '…'
              : channel.data.type === 'public'
                ? `# ${channel.data.name ?? ''}`
                : channel.data.type === 'private'
                  ? `🔒 ${channel.data.name ?? ''}`
                  : (channel.data.name ?? 'Direct message')}
          </h2>
          <button
            type="button"
            onClick={() => {
              setPinsOpen((open) => !open);
            }}
            className={cn(
              'flex shrink-0 items-center gap-1 rounded px-2 py-1 text-xs',
              pinsOpen
                ? 'bg-accent text-accent-ink'
                : 'text-ink-muted hover:bg-surface-hover hover:text-ink',
            )}
          >
            📌 {pins.data?.length ?? 0}
          </button>
        </header>

        {pinsOpen && (
          <PinnedPanel
            pins={pins.data ?? []}
            messagesById={new Map((messages.data ?? []).map((message) => [message.messageId, message]))}
            personOf={personOf}
            onUnpin={(messageId) => {
              togglePin.mutate({ messageId: messageId as MessageId, pinned: true });
            }}
          />
        )}

        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {messages.isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-10 w-3/4" />
              <Skeleton className="h-10 w-1/2" />
            </div>
          ) : groups.length === 0 ? (
            <Empty
              title="No messages yet"
              description="Say something to get the conversation going."
            />
          ) : (
            <div className="space-y-4">
              {groups.map((group) => (
                <MessageGroupView
                  key={group.messages[0]?.messageId}
                  group={group}
                  viewerId={viewerId}
                  authorLabel={group.authorId === null ? null : personOf(group.authorId).label}
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
                  reactionsByMessage={reactionsByMessage}
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
              ))}
            </div>
          )}
        </div>

        {typingLabel !== null && (
          <div className="h-5 shrink-0 px-4 text-xs text-ink-faint italic">{typingLabel}</div>
        )}

        <div className="shrink-0 border-t border-line px-4 py-3">
          <RichTextEditor
            value={draft}
            placeholder="Message… (Enter to send, Shift+Enter for a new line)"
            onChange={(next) => {
              setDraft(next);
              startTyping(channelId);
            }}
            onSubmit={submit}
            footer={
              <Button
                size="sm"
                variant="primary"
                disabled={isEmptyDocument(draft) || send.isPending}
                onClick={submit}
              >
                Send
              </Button>
            }
          />
        </div>
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
              viewerId={viewerId}
              personOf={personOf}
              onClose={() => {
                setOpenThreadId(null);
              }}
            />
          );
        })()}
    </div>
  );
}

/** Every reaction row, grouped by message then emoji, with who reacted. */
function groupReactions(rows: readonly ReactionRow[]): Map<string, Map<string, string[]>> {
  const byMessage = new Map<string, Map<string, string[]>>();
  for (const row of rows) {
    const byEmoji = byMessage.get(row.messageId) ?? new Map<string, string[]>();
    byEmoji.set(row.emoji, [...(byEmoji.get(row.emoji) ?? []), row.userId]);
    byMessage.set(row.messageId, byEmoji);
  }
  return byMessage;
}

/**
 * Typing indicators (ai/phase-5-chat.md §5) — in-process only, no query, no
 * outbox. A `Set` of user ids currently typing in THIS channel, cleared per
 * user after `TYPING_TIMEOUT_MS` in case a `typing:stop` never arrives (a
 * closed tab, a dropped connection) — the same "the absence of a signal must
 * still resolve to a safe state" reasoning presence uses elsewhere.
 */
function useTypingUsers(channelId: ChannelId, viewerId: string | null): readonly string[] {
  const [typing, setTyping] = useState<readonly string[]>([]);

  useEffect(() => {
    /* No reset here: `ChannelPanel` is keyed by channel in `ChatPage`
       (`key={search}`), so this hook fully remounts — with fresh initial
       state — on every channel switch rather than receiving a new
       `channelId` prop on a live instance. */
    const timers = new Map<string, ReturnType<typeof setTimeout>>();

    const off = onTyping((message) => {
      if (message.channelId !== channelId || message.userId === viewerId) return;

      const existing = timers.get(message.userId);
      if (existing !== undefined) clearTimeout(existing);

      if (!message.typing) {
        timers.delete(message.userId);
        setTyping((current) => current.filter((userId) => userId !== message.userId));
        return;
      }

      setTyping((current) => (current.includes(message.userId) ? current : [...current, message.userId]));
      timers.set(
        message.userId,
        setTimeout(() => {
          timers.delete(message.userId);
          setTyping((current) => current.filter((userId) => userId !== message.userId));
        }, TYPING_TIMEOUT_MS),
      );
    });

    return () => {
      off();
      for (const timer of timers.values()) clearTimeout(timer);
    };
  }, [channelId, viewerId]);

  return typing;
}

function describeTyping(
  userIds: readonly string[],
  personOf: (userId: string) => { readonly label: string },
): string | null {
  if (userIds.length === 0) return null;
  const names = userIds.map((userId) => personOf(userId).label);
  const [first, second] = names;
  if (first === undefined) return null;
  if (second === undefined) return `${first} is typing…`;
  if (names.length === 2) return `${first} and ${second} are typing…`;
  return `${String(names.length)} people are typing…`;
}

function PinnedPanel({
  pins,
  messagesById,
  personOf,
  onUnpin,
}: {
  readonly pins: readonly PinnedMessageRow[];
  readonly messagesById: Map<string, Message>;
  readonly personOf: (userId: string) => { readonly label: string };
  readonly onUnpin: (messageId: string) => void;
}) {
  return (
    <div className="max-h-40 shrink-0 overflow-y-auto border-b border-line bg-surface-raised px-4 py-2">
      {pins.length === 0 ? (
        <p className="text-xs text-ink-faint">No pinned messages yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {pins.map((pin) => {
            const message = messagesById.get(pin.messageId);
            return (
              <li key={pin.messageId} className="flex items-start justify-between gap-2 text-xs">
                <div className="min-w-0">
                  <p className="truncate text-ink">{message?.bodyText ?? '(message not loaded)'}</p>
                  <p className="text-ink-faint">
                    {pin.pinnedBy === null ? 'Pinned' : `Pinned by ${personOf(pin.pinnedBy).label}`}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    onUnpin(pin.messageId);
                  }}
                  className="shrink-0 text-ink-faint hover:text-ink"
                >
                  Unpin
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * A message's thread — the root plus its replies, one level deep
 * (`message.service.ts`'s own limit: a reply cannot itself be replied to, so
 * this panel never needs to open a thread from within a thread).
 *
 * `rootMessage` comes from the already-loaded channel page rather than a
 * second fetch — `messages.list` already returned it, and re-requesting a
 * message the caller is already looking at would be the one round trip in
 * this feature with nothing to show for it.
 */
function ThreadPanel({
  orgId,
  channelId,
  rootMessage,
  viewerId,
  personOf,
  onClose,
}: {
  readonly orgId: string;
  readonly channelId: ChannelId;
  readonly rootMessage: Message;
  readonly viewerId: string | null;
  readonly personOf: (userId: string) => { readonly label: string };
  readonly onClose: () => void;
}) {
  const toast = useToast();
  const queryClient = useQueryClient();
  const replies = useQuery(threadQuery(orgId, channelId, rootMessage.messageId as MessageId));
  const [draft, setDraft] = useState<DocumentNode>(EMPTY_DOCUMENT);

  const reply = useMutation({
    mutationFn: (body: DocumentNode) =>
      sendMessage({
        channelId,
        body,
        parentMessageId: rootMessage.messageId as MessageId,
      }),
    onSuccess: () => {
      invalidateMessages(queryClient, orgId, channelId);
    },
    onError: (error, body) => {
      toast.failure('The reply was not sent', error);
      setDraft((current) => (isEmptyDocument(current) ? body : current));
    },
  });

  const submit = (): void => {
    if (isEmptyDocument(draft)) return;
    const body = draft;
    setDraft(EMPTY_DOCUMENT);
    reply.mutate(body);
  };

  const renderPlain = (message: Message) => {
    const isOwn = message.authorId !== null && message.authorId === viewerId;
    const label = message.authorId === null ? 'Unknown' : personOf(message.authorId).label;

    if (message.deletedAt !== null) {
      return <p className="px-1 text-xs text-ink-faint italic">This message was deleted.</p>;
    }

    return (
      <div className={cn('flex flex-col gap-0.5', isOwn && 'items-end')}>
        <span className="px-1 text-xs font-medium text-ink-muted">{label}</span>
        <div
          className={cn(
            'max-w-full rounded-2xl px-3 py-1.5',
            isOwn ? 'bg-accent text-accent-ink' : 'bg-surface-raised text-ink',
          )}
        >
          <RichTextView value={message.body} bare />
          <div
            className={cn(
              'text-[10px]',
              isOwn ? 'text-accent-ink/70' : 'text-ink-faint',
            )}
          >
            {formatTime(message.createdAt)}
            {message.editedAt !== null && ' · edited'}
          </div>
        </div>
      </div>
    );
  };

  return (
    <aside className="flex w-80 shrink-0 flex-col border-l border-line bg-surface-raised">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-line px-3">
        <h3 className="text-sm font-medium text-ink">Thread</h3>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close thread"
          className="rounded px-1.5 py-0.5 text-ink-faint hover:bg-surface-hover hover:text-ink"
        >
          ✕
        </button>
      </header>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {renderPlain(rootMessage)}

        <div className="border-t border-line pt-3">
          {replies.isLoading ? (
            <Skeleton className="h-8 w-3/4" />
          ) : (
            <div className="space-y-3">
              {(replies.data ?? []).map((message) => (
                <div key={message.messageId}>{renderPlain(message)}</div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="shrink-0 border-t border-line px-3 py-2">
        <RichTextEditor
          value={draft}
          placeholder="Reply in thread…"
          onChange={setDraft}
          onSubmit={submit}
          footer={
            <Button
              size="sm"
              variant="primary"
              disabled={isEmptyDocument(draft) || reply.isPending}
              onClick={submit}
            >
              Reply
            </Button>
          }
        />
      </div>
    </aside>
  );
}

/**
 * A group, WhatsApp/Telegram-style: the viewer's OWN messages align right in
 * an accent bubble with no avatar (the side is already the identity signal —
 * repeating your own name and picture next to it is the thing this layout
 * exists to avoid); everyone else's align left, with an avatar next to the
 * FIRST bubble in the group and a matching space held next to the rest, so
 * the second and third bubbles in a run still line up under the first
 * instead of drifting to the edge once the avatar is gone.
 */
function MessageGroupView({
  group,
  viewerId,
  authorLabel,
  editingId,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  editPending,
  onDelete,
  reactionsByMessage,
  personOf,
  onToggleReaction,
  pinnedIds,
  onTogglePin,
  replyCounts,
  onOpenThread,
}: {
  readonly group: MessageGroup;
  readonly viewerId: string | null;
  readonly authorLabel: string | null;
  readonly editingId: string | null;
  readonly onStartEdit: (messageId: string) => void;
  readonly onCancelEdit: () => void;
  readonly onSaveEdit: (messageId: string, body: DocumentNode) => void;
  readonly editPending: boolean;
  readonly onDelete: (messageId: string) => void;
  readonly reactionsByMessage: Map<string, Map<string, string[]>>;
  readonly personOf: (userId: string) => { readonly label: string };
  readonly onToggleReaction: (messageId: string, emoji: string) => void;
  readonly pinnedIds: Set<string>;
  readonly onTogglePin: (messageId: string, pinned: boolean) => void;
  readonly replyCounts: Map<string, number>;
  readonly onOpenThread: (messageId: string) => void;
}) {
  const isOwn = group.authorId !== null && group.authorId === viewerId;
  const first = group.messages[0];
  if (first === undefined) return null;

  return (
    <div className={cn('flex gap-2', isOwn ? 'flex-row-reverse' : 'flex-row')}>
      <div className="w-6 shrink-0 self-end">
        {!isOwn && group.authorId !== null && (
          <Avatar userId={group.authorId} label={authorLabel ?? group.authorId} size="sm" />
        )}
      </div>

      <div className={cn('flex min-w-0 max-w-[75%] flex-col gap-0.5', isOwn && 'items-end')}>
        {/* Own bubbles skip the name — the side they're on already says who
            sent them — but every group still gets ONE relative timestamp,
            because "who and when" is what a message header is for and only
            half of that is redundant here. */}
        {!isOwn && (
          <span className="px-1 text-xs font-medium text-ink-muted">
            {authorLabel ?? 'Unknown'}
          </span>
        )}

        {group.messages.map((message, index) => (
          <MessageBubble
            key={message.messageId}
            message={message}
            isOwn={isOwn}
            isFirstInGroup={index === 0}
            isLastInGroup={index === group.messages.length - 1}
            isEditing={editingId === message.messageId}
            onStartEdit={() => {
              onStartEdit(message.messageId);
            }}
            onCancelEdit={onCancelEdit}
            onSaveEdit={(body) => {
              onSaveEdit(message.messageId, body);
            }}
            editPending={editPending}
            onDelete={() => {
              onDelete(message.messageId);
            }}
            reactions={reactionsByMessage.get(message.messageId) ?? new Map()}
            viewerId={viewerId}
            personOf={personOf}
            onToggleReaction={(emoji) => {
              onToggleReaction(message.messageId, emoji);
            }}
            pinned={pinnedIds.has(message.messageId)}
            onTogglePin={(pinned) => {
              onTogglePin(message.messageId, pinned);
            }}
            replyCount={replyCounts.get(message.messageId) ?? 0}
            onOpenThread={() => {
              onOpenThread(message.messageId);
            }}
          />
        ))}
      </div>
    </div>
  );
}

function MessageBubble({
  message,
  isOwn,
  isFirstInGroup,
  isLastInGroup,
  isEditing,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  editPending,
  onDelete,
  reactions,
  viewerId,
  personOf,
  onToggleReaction,
  pinned,
  onTogglePin,
  replyCount,
  onOpenThread,
}: {
  readonly message: Message;
  readonly isOwn: boolean;
  readonly isFirstInGroup: boolean;
  readonly isLastInGroup: boolean;
  readonly isEditing: boolean;
  readonly onStartEdit: () => void;
  readonly onCancelEdit: () => void;
  readonly onSaveEdit: (body: DocumentNode) => void;
  readonly editPending: boolean;
  readonly onDelete: () => void;
  readonly reactions: Map<string, string[]>;
  readonly viewerId: string | null;
  readonly personOf: (userId: string) => { readonly label: string };
  readonly onToggleReaction: (emoji: string) => void;
  readonly pinned: boolean;
  readonly onTogglePin: (pinned: boolean) => void;
  readonly replyCount: number;
  readonly onOpenThread: () => void;
}) {
  if (message.deletedAt !== null) {
    return (
      <p
        className={cn(
          'rounded-2xl px-3 py-1.5 text-xs text-ink-faint italic',
          isOwn ? 'bg-accent/10' : 'bg-surface-raised',
        )}
      >
        This message was deleted.
      </p>
    );
  }

  if (isEditing) {
    return (
      <div className="w-full min-w-56">
        <EditMessage
          initial={message.body}
          pending={editPending}
          onCancel={onCancelEdit}
          onSave={onSaveEdit}
        />
      </div>
    );
  }

  /* A run of same-author bubbles gets one rounded corner shaved flat where
     it touches its neighbour — the "tail only on the outermost bubble" shape
     every chat product uses so a run of three reads as one utterance
     instead of three separate boxes stacked with identical corners. */
  const cornerClass = isOwn
    ? cn(!isFirstInGroup && 'rounded-tr-md', !isLastInGroup && 'rounded-br-md')
    : cn(!isFirstInGroup && 'rounded-tl-md', !isLastInGroup && 'rounded-bl-md');

  return (
    <div className={cn('group/message relative flex flex-col gap-0.5', isOwn && 'items-end')}>
      <div className={cn('flex items-end gap-1', isOwn && 'flex-row-reverse')}>
        <div
          className={cn(
            'rounded-2xl px-3 py-1.5',
            isOwn ? 'bg-accent text-accent-ink' : 'bg-surface-raised text-ink',
            cornerClass,
          )}
        >
          <RichTextView value={message.body} bare />
          <div
            className={cn(
              'flex items-center gap-1 text-[10px]',
              isOwn ? 'text-accent-ink/70' : 'text-ink-faint',
            )}
          >
            <span>{formatTime(message.createdAt)}</span>
            {message.editedAt !== null && <span>edited</span>}
            {pinned && <span>· 📌</span>}
          </div>
        </div>

        {/* Hover actions sit OUTSIDE the bubble, on its outer edge, rather than
            overlapping the text — the same `opacity-0 group-hover:opacity-100`
            shape `card-tile.tsx`'s quick actions already use, visible on hover
            or keyboard focus rather than as permanent clutter on every bubble.

            Edit is author-only with no override, same reasoning as Work's
            comments (CLAUDE.md, §8.2) — nobody else's edit control would ever
            succeed, so it never renders for someone else's bubble regardless
            of side. Delete stays visible wherever a moderator override is
            possible; the server is the one that turns an unearned click into
            an honest FORBIDDEN rather than a silent no-op. React and pin are
            offered to everyone who can post — see `reaction.service.ts` and
            `pin.service.ts` on why neither needs a stronger permission. */}
        <div
          className={cn(
            'mb-1 flex items-center gap-0.5 rounded border border-line bg-surface-raised px-0.5 opacity-0 shadow-sm transition-opacity',
            'group-hover/message:opacity-100 group-focus-within/message:opacity-100',
          )}
        >
          <EmojiPickerButton onPick={onToggleReaction} />
          <Button size="sm" variant="ghost" className="h-5 px-1 text-[11px]" onClick={onOpenThread}>
            Reply
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-5 px-1 text-[11px]"
            onClick={() => {
              onTogglePin(pinned);
            }}
          >
            {pinned ? 'Unpin' : 'Pin'}
          </Button>
          {isOwn && (
            <Button size="sm" variant="ghost" className="h-5 px-1 text-[11px]" onClick={onStartEdit}>
              Edit
            </Button>
          )}
          <Button size="sm" variant="ghost" className="h-5 px-1 text-[11px]" onClick={onDelete}>
            Delete
          </Button>
        </div>
      </div>

      {reactions.size > 0 && (
        <ReactionBar
          reactions={reactions}
          viewerId={viewerId}
          personOf={personOf}
          onToggle={onToggleReaction}
        />
      )}

      {replyCount > 0 && (
        <button
          type="button"
          onClick={onOpenThread}
          className="px-1 text-xs font-medium text-accent hover:underline"
        >
          {replyCount} {replyCount === 1 ? 'reply' : 'replies'}
        </button>
      )}
    </div>
  );
}

/** The reaction bar under a bubble — one pill per emoji, with its count. */
function ReactionBar({
  reactions,
  viewerId,
  personOf,
  onToggle,
}: {
  readonly reactions: Map<string, string[]>;
  readonly viewerId: string | null;
  readonly personOf: (userId: string) => { readonly label: string };
  readonly onToggle: (emoji: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1 px-1">
      {[...reactions.entries()].map(([emoji, userIds]) => (
        <button
          key={emoji}
          type="button"
          onClick={() => {
            onToggle(emoji);
          }}
          title={userIds.map((userId) => personOf(userId).label).join(', ')}
          className={cn(
            'flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs',
            viewerId !== null && userIds.includes(viewerId)
              ? 'border-accent bg-accent/10 text-accent'
              : 'border-line bg-surface-raised text-ink-muted hover:bg-surface-hover',
          )}
        >
          <span>{emoji}</span>
          <span>{userIds.length}</span>
        </button>
      ))}
    </div>
  );
}

function EmojiPickerButton({ onPick }: { readonly onPick: (emoji: string) => void }) {
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <Button size="sm" variant="ghost" className="h-5 px-1 text-[11px]">
          React
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="top"
          sideOffset={4}
          className="flex gap-1 rounded border border-line bg-surface-raised p-1.5 text-base shadow-xl"
        >
          {QUICK_REACTIONS.map((emoji) => (
            <Popover.Close asChild key={emoji}>
              <button
                type="button"
                onClick={() => {
                  onPick(emoji);
                }}
                className="rounded p-1 hover:bg-surface-hover"
              >
                {emoji}
              </button>
            </Popover.Close>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function formatTime(value: string): string {
  return new Date(value).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function EditMessage({
  initial,
  pending,
  onSave,
  onCancel,
}: {
  readonly initial: unknown;
  readonly pending: boolean;
  readonly onSave: (body: DocumentNode) => void;
  readonly onCancel: () => void;
}) {
  const [body, setBody] = useState<DocumentNode | null>(null);

  return (
    <RichTextEditor
      value={initial}
      onChange={setBody}
      footer={
        <>
          <Button
            size="sm"
            variant="primary"
            disabled={pending || body === null || isEmptyDocument(body)}
            onClick={() => {
              if (body !== null) onSave(body);
            }}
          >
            Save
          </Button>
          <Button size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </>
      }
    />
  );
}
