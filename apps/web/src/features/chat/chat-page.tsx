import { Fragment, useLayoutEffect, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronLeft, Hash, Lock, Pin, Users, X } from 'lucide-react';
import { PopoverClose, PopoverContent, PopoverRoot, PopoverTrigger } from '@taskflow/ui';
import type { ChannelId, MessageId, UserId } from '@taskflow/contracts';
import { useSession } from '../../lib/session.js';
import { cn } from '../../lib/cn.js';
import { useToast } from '../../lib/toast-context.js';
import { ACCEPTED_FILE_TYPES } from '../../lib/accepted-file-types.js';
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
import { CallButton } from '../rtc/call-button.js';
import { callHistoryQuery, type CallHistoryEntry } from '../rtc/api.js';
import { RichTextEditor, RichTextView } from '../work/detail/rich-text-editor.js';
import { EMPTY_DOCUMENT, isEmptyDocument, type DocumentNode } from '../work/detail/rich-text.js';
import { onTyping, startTyping, stopTyping } from '../../lib/chat-socket.js';
import {
  allPinsQuery,
  channelQuery,
  channelsQuery,
  createChannel,
  deleteMessage,
  hideMessage,
  editMessage,
  invalidateAllPins,
  invalidateChannels,
  invalidateMessages,
  invalidatePins,
  invalidateReactions,
  invalidateUnreadCounts,
  invalidateChannel,
  markChannelRead,
  messagesQuery,
  openDirectMessage,
  pinMessage,
  pinsQuery,
  reactionsQuery,
  sendMessage,
  threadQuery,
  toggleReaction,
  removeChannelMember,
  unpinMessage,
  savedQuery,
  saveMessage,
  unsaveMessage,
  invalidateSaved,
  unreadCountsQuery,
  updateChannel,
  entryCursorQuery,
  messageAttachmentsQuery,
  messagePreviewsQuery,
  uploadMessageFile,
  type ChannelDetail,
  type MessageAttachment,
  type MessagePreview,
  type ChannelSummary,
  type Message,
  type PinnedMessageSummary,
  type ReactionRow,
  type SavedMessage,
} from './api.js';
import { ChannelDetailsPanel } from './channel-details.js';
import { CallTimelineCard } from './channel-media.js';
import { MessageAttachments, MessagePreviews } from './message-extras.js';
import { matchingCommands, messageTextFor, parseCommand } from './slash-commands.js';
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

  /* Below `md`, a list and its detail can't share a phone-width screen —
     this is the same list/detail split Mail apps use, driven entirely by
     `search.channel` (the URL) rather than a separate "which pane is active"
     piece of state, so there is only ever one source of truth for what's on
     screen. At `md` and above both panes are always visible side by side,
     unchanged from before this wave. */
  return (
    <div className="flex h-full min-h-0">
      <ChannelListPanel
        orgId={orgId}
        selected={search ?? null}
        onSelect={selectChannel}
        hideWhenChannelOpen={search !== undefined}
      />

      <div
        className={cn(
          'min-h-0 min-w-0 flex-1 flex-col md:flex',
          search === undefined ? 'hidden md:flex' : 'flex',
        )}
      >
        {search === undefined ? (
          <Empty
            title="No conversation open"
            description="Pick a channel or direct message on the left, or start a new one."
          />
        ) : (
          <ChannelPanel
            key={search}
            orgId={orgId}
            channelId={search}
            onBack={() => {
              selectChannel(undefined);
            }}
          />
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
  hideWhenChannelOpen,
}: {
  readonly orgId: string;
  readonly selected: ChannelId | null;
  readonly onSelect: (channelId: ChannelId | undefined) => void;
  /** Below `md`, hidden once a channel is open — see `ChatPage`'s own comment
      on why this is a list/detail split rather than two permanent panes. */
  readonly hideWhenChannelOpen: boolean;
}) {
  const channels = useQuery({ ...channelsQuery(orgId), enabled: orgId !== '' });
  /* The server's verdict on whether THIS caller may create a channel — the
     "new channel" control renders only when it is true, so a member with no
     `channel:create` is not offered a CTA whose only outcome is FORBIDDEN
     (CLAUDE.md §8.2: the server decides, the client never re-derives). */
  const canCreateChannel = channels.data?.canCreateChannel ?? false;
  const list = channels.data?.channels ?? [];
  const { personOf } = useMembers();

  const unread = useQuery({
    ...unreadCountsQuery(
      orgId,
      list.map((channel) => channel.channelId),
    ),
    enabled: orgId !== '' && list.length > 0,
  });
  const unreadByChannel = new Map(
    (unread.data ?? []).map((row) => [row.channelId, row.unreadCount]),
  );

  const rooms = list.filter((channel) => channel.type === 'public' || channel.type === 'private');
  const directs = list.filter((channel) => channel.type === 'dm' || channel.type === 'group_dm');

  return (
    <aside
      aria-label="Conversations"
      className={cn(
        'shrink-0 flex-col overflow-y-auto border-r border-line bg-surface-raised md:flex md:w-64',
        /* Below `md` this pane and the message pane can't both fit — `w-64`
           alone is already most of a phone's viewport. `hidden`/`flex`
           rather than `w-0`/`w-64`: a zero-width flex child with overflow
           content still lays out (and can still be tabbed into) its
           children, `hidden` actually removes it from the accessibility
           tree and the tab order. `md:flex md:w-64` above always wins at
           `md`+ regardless of which of these two applies below it. */
        hideWhenChannelOpen ? 'hidden' : 'flex w-full',
      )}
    >
      <div className="flex flex-col gap-0.5 border-b border-line px-1.5 py-1.5">
        <PinnedMessagesButton orgId={orgId} onOpenChannel={onSelect} />
        <SavedMessagesButton orgId={orgId} onOpenChannel={onSelect} />
      </div>

      <div className="flex items-center justify-between px-3 pt-3 pb-1">
        <h2 className="text-[13px] font-semibold text-ink">Channels</h2>
        {canCreateChannel && <NewChannelPopover orgId={orgId} onCreated={onSelect} />}
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
        <h2 className="text-[13px] font-semibold text-ink">Direct messages</h2>
        <NewDirectMessagePopover orgId={orgId} onOpened={onSelect} />
      </div>

      <ul className="px-1.5 pb-3">
        {directs.map((channel) => (
          <ChannelRow
            key={channel.channelId}
            channel={channel}
            /* A DM has no name — the database refuses one — so it is labelled by
               WHO is in it, from `participantIds` (the viewer already excluded
               server-side) resolved through the same member lookup every avatar
               uses. "Direct message" only survives as a fallback for the case
               where `member:read` is denied and the lookup returns nothing;
               rendering a raw uuid there would be worse than saying nothing. */
            label={directLabel(channel.participantIds, personOf)}
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

/**
 * The public "#" / private lock glyph shown before a channel name, wherever
 * one appears (`ChannelRow`, `PinnedMessageSidebarRow`, `SavedMessageRow`) —
 * one place rather than three copies of the same ternary drifting apart.
 * `#` stays literal text (Slack's own convention, and every font already has
 * it); the lock was an emoji, inconsistent with this app's monochrome icon
 * set everywhere else, so it becomes one. Both sit inside the caller's own
 * `truncate` span, same as the string they replace.
 */
function ChannelTypePrefix({ type }: { readonly type: string }) {
  if (type === 'public') return <>{'# '}</>;
  if (type === 'private') {
    return (
      <Lock
        aria-hidden="true"
        className="mr-1 inline size-3 -translate-y-px shrink-0"
        strokeWidth={2.25}
      />
    );
  }
  return null;
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
          <ChannelTypePrefix type={channel.type} />
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

/**
 * Pinned messages — ORG-wide, next to Saved (§5).
 *
 * Used to be a per-channel panel behind a "📌 count" button in the channel
 * header, which meant it could only ever show the ONE conversation already
 * open — not useful for finding a pin you remembered was in some OTHER
 * channel. Moved here for the same reason Saved lives here: `chat.messages
 * .allPins` is one query across every channel the caller can still read
 * (`pin.service.ts`'s `listAllPinned`, same re-check-on-read as saved
 * messages), so this is the other place in the sidebar that is not a
 * channel or a DM.
 *
 * The per-message Pin/Unpin toggle on a message itself is unaffected — it
 * still reads the current channel's own `chat.messages.pins`, which this
 * panel's Unpin action also invalidates so the two never disagree.
 */
function PinnedMessagesButton({
  orgId,
  onOpenChannel,
}: {
  readonly orgId: string;
  readonly onOpenChannel: (channelId: ChannelId) => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const pins = useQuery({ ...allPinsQuery(orgId), enabled: orgId !== '' });
  const list = pins.data ?? [];

  const unpin = useMutation({
    mutationFn: (input: { channelId: ChannelId; messageId: MessageId }) => unpinMessage(input),
    onSuccess: (_result, input) => {
      invalidateAllPins(queryClient, orgId);
      invalidatePins(queryClient, orgId, input.channelId);
    },
    onError: (error) => {
      toast.failure('That could not be unpinned', error);
    },
  });

  return (
    <PopoverRoot>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={
            list.length > 0 ? `Pinned messages, ${String(list.length)}` : 'Pinned messages'
          }
          className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm text-ink-muted hover:bg-surface-hover hover:text-ink"
        >
          <span className="flex items-center gap-1.5">
            <Pin aria-hidden="true" className="size-3.5" strokeWidth={2} />
            Pinned messages
          </span>
          {list.length > 0 && (
            <span className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-surface-hover px-1 text-[10px] font-semibold text-ink-muted">
              {list.length > 99 ? '99+' : list.length}
            </span>
          )}
        </button>
      </PopoverTrigger>

      <PopoverContent align="start" sideOffset={6} className="w-80 overflow-hidden">
        <header className="border-b border-line px-3 py-2">
          <h2 className="text-sm font-medium text-ink">Pinned messages</h2>
        </header>

        <div className="max-h-96 overflow-y-auto">
          {list.length === 0 ? (
            <div className="p-3">
              <Empty
                title="Nothing pinned yet"
                description="Pin a message to find it here later."
              />
            </div>
          ) : (
            <ul>
              {list.map((row) => (
                <PinnedMessageSidebarRow
                  key={row.messageId}
                  row={row}
                  pending={unpin.isPending}
                  onOpen={() => {
                    onOpenChannel(row.channelId as ChannelId);
                  }}
                  onUnpin={() => {
                    unpin.mutate({
                      channelId: row.channelId as ChannelId,
                      messageId: row.messageId as MessageId,
                    });
                  }}
                />
              ))}
            </ul>
          )}
        </div>
      </PopoverContent>
    </PopoverRoot>
  );
}

function PinnedMessageSidebarRow({
  row,
  pending,
  onOpen,
  onUnpin,
}: {
  readonly row: PinnedMessageSummary;
  readonly pending: boolean;
  readonly onOpen: () => void;
  readonly onUnpin: () => void;
}) {
  return (
    <li className="border-b border-line px-3 py-2 last:border-b-0">
      <button type="button" onClick={onOpen} className="flex w-full flex-col gap-0.5 text-left">
        <span className="truncate text-xs font-medium text-ink">
          <ChannelTypePrefix type={row.channelType} />
          {row.channelName ?? 'Direct message'}
        </span>
        <span className="line-clamp-2 text-xs text-ink-muted">
          {row.excerpt ?? '(message deleted)'}
        </span>
        <span className="text-[11px] text-ink-faint">
          Pinned {new Date(row.pinnedAt).toLocaleString()}
        </span>
      </button>
      <button
        type="button"
        disabled={pending}
        onClick={onUnpin}
        className="mt-1 text-[11px] text-ink-faint hover:text-ink"
      >
        Unpin
      </button>
    </li>
  );
}

/**
 * Saved messages — the personal bookmark list, ORG-wide (§2, Wave 2).
 *
 * Lives above the channel list rather than inside one, because a save is not
 * scoped to the channel it was made in: `chat.saved.list` is one query across
 * every channel the caller can still read (`saved.service.ts`'s re-check on
 * read), so this is the one place in the sidebar that is not a channel or a
 * DM.
 *
 * Shares the `['org', orgId, 'chat', 'saved']` query key with the per-message
 * Save/Unsave toggle in `MessageBubble` — toggling one updates the other
 * without a second fetch.
 */
function SavedMessagesButton({
  orgId,
  onOpenChannel,
}: {
  readonly orgId: string;
  readonly onOpenChannel: (channelId: ChannelId) => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const saved = useQuery({ ...savedQuery(orgId), enabled: orgId !== '' });
  const list = saved.data ?? [];

  const unsave = useMutation({
    mutationFn: (messageId: MessageId) => unsaveMessage(messageId),
    onSuccess: () => {
      invalidateSaved(queryClient, orgId);
    },
    onError: (error) => {
      toast.failure('That could not be removed', error);
    },
  });

  return (
    <PopoverRoot>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={list.length > 0 ? `Saved messages, ${String(list.length)}` : 'Saved messages'}
          className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm text-ink-muted hover:bg-surface-hover hover:text-ink"
        >
          <span className="flex items-center gap-1.5">
            <span aria-hidden>🔖</span>
            Saved messages
          </span>
          {list.length > 0 && (
            <span className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-surface-hover px-1 text-[10px] font-semibold text-ink-muted">
              {list.length > 99 ? '99+' : list.length}
            </span>
          )}
        </button>
      </PopoverTrigger>

      <PopoverContent align="start" sideOffset={6} className="w-80 overflow-hidden">
        <header className="border-b border-line px-3 py-2">
          <h2 className="text-sm font-medium text-ink">Saved messages</h2>
        </header>

        <div className="max-h-96 overflow-y-auto">
          {list.length === 0 ? (
            <div className="p-3">
              <Empty
                title="Nothing saved yet"
                description="Save a message from its menu to find it here later."
              />
            </div>
          ) : (
            <ul>
              {list.map((row) => (
                <SavedMessageRow
                  key={row.messageId}
                  row={row}
                  pending={unsave.isPending}
                  onOpen={() => {
                    onOpenChannel(row.channelId as ChannelId);
                  }}
                  onUnsave={() => {
                    unsave.mutate(row.messageId as MessageId);
                  }}
                />
              ))}
            </ul>
          )}
        </div>
      </PopoverContent>
    </PopoverRoot>
  );
}

function SavedMessageRow({
  row,
  pending,
  onOpen,
  onUnsave,
}: {
  readonly row: SavedMessage;
  readonly pending: boolean;
  readonly onOpen: () => void;
  readonly onUnsave: () => void;
}) {
  return (
    <li className="border-b border-line px-3 py-2 last:border-b-0">
      <button type="button" onClick={onOpen} className="flex w-full flex-col gap-0.5 text-left">
        <span className="truncate text-xs font-medium text-ink">
          <ChannelTypePrefix type={row.channelType} />
          {row.channelName ?? 'Direct message'}
        </span>
        <span className="line-clamp-2 text-xs text-ink-muted">
          {row.excerpt ?? '(message deleted)'}
        </span>
        <span className="text-[11px] text-ink-faint">
          Saved {new Date(row.savedAt).toLocaleString()}
        </span>
      </button>
      <button
        type="button"
        disabled={pending}
        onClick={onUnsave}
        className="mt-1 text-[11px] text-ink-faint hover:text-ink"
      >
        Unsave
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
    <PopoverRoot
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setName('');
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="New channel"
          className="flex h-5 w-5 items-center justify-center rounded text-xs text-ink-faint hover:bg-surface-hover hover:text-ink"
        >
          +
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 space-y-2 p-3">
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
      </PopoverContent>
    </PopoverRoot>
  );
}

/** Matches `openDirect`'s own `z.array(UserIdSchema).min(1).max(20)` in
 * `apps/api/src/chat/router.ts` — the caller is added server-side and is never
 * one of these, so the cap here is on the OTHER participants, same as there. */
const MAX_OTHER_PARTICIPANTS = 20;

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
  const [selected, setSelected] = useState<readonly UserId[]>([]);

  const start = useMutation({
    mutationFn: (userIds: readonly UserId[]) => openDirectMessage(userIds),
    onSuccess: (result) => {
      invalidateChannels(queryClient, orgId);
      setOpen(false);
      setSelected([]);
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

  const toggle = (userId: UserId) => {
    setSelected((current) =>
      current.includes(userId)
        ? current.filter((id) => id !== userId)
        : current.length >= MAX_OTHER_PARTICIPANTS
          ? current
          : [...current, userId],
    );
  };

  return (
    <PopoverRoot
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setQuery('');
          setSelected([]);
        }
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="New direct message"
          className="flex h-5 w-5 items-center justify-center rounded text-xs text-ink-faint hover:bg-surface-hover hover:text-ink"
        >
          +
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 space-y-1.5 p-2">
        <Input
          aria-label="Search people"
          placeholder="Search people…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
          className="h-7 text-xs"
        />

        {selected.length > 0 && (
          <ul className="flex flex-wrap gap-1">
            {selected.map((userId) => {
              const member = people.find((person) => person.userId === userId);
              return (
                <li key={userId}>
                  <button
                    type="button"
                    onClick={() => {
                      toggle(userId);
                    }}
                    className="flex items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-[11px] text-accent hover:bg-accent/20"
                  >
                    <span className="truncate">{member?.email ?? userId}</span>
                    <span aria-hidden="true">×</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {filtered.length === 0 ? (
          <p className="p-1 text-xs text-ink-faint">No matches.</p>
        ) : (
          <ul className="max-h-56 space-y-0.5 overflow-y-auto">
            {filtered.map((member) => {
              const isSelected = selected.includes(member.userId as UserId);
              return (
                <li key={member.userId}>
                  <button
                    type="button"
                    disabled={start.isPending}
                    aria-pressed={isSelected}
                    onClick={() => {
                      toggle(member.userId as UserId);
                    }}
                    className={cn(
                      'flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left text-xs',
                      isSelected
                        ? 'bg-accent/10 text-accent'
                        : 'text-ink-muted hover:bg-surface-hover hover:text-ink',
                    )}
                  >
                    <Avatar userId={member.userId} label={member.email} size="xs" />
                    <span className="truncate">{member.email}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        <Button
          size="sm"
          variant="primary"
          className="w-full"
          disabled={selected.length === 0 || start.isPending}
          onClick={() => {
            start.mutate(selected);
          }}
        >
          {selected.length > 1
            ? `Start group with ${String(selected.length)} people`
            : 'Start conversation'}
        </Button>
      </PopoverContent>
    </PopoverRoot>
  );
}

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

function ChannelPanel({
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
  useChannelRoom(orgId, channelId);

  const channel = useQuery(channelQuery(orgId, channelId));
  const messages = useQuery(messagesQuery(orgId, channelId));
  const viewerId = useSession((state) => state.userId);
  const { personOf } = useMembers();
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
        ? await sendMessage({ channelId, body: textDocument(`Shared **${file.name}**`) })
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
        <header className="flex h-13 shrink-0 items-center gap-2.5 border-b border-line px-3 sm:px-4">
          {/* The whole header is the way back to the channel list below `md`
              (tap the name, not a tiny arrow) — see `ChatPage`'s comment on
              the list/detail split this belongs to. */}
          <button
            type="button"
            onClick={onBack}
            aria-label="Back to conversations"
            className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-1 py-1.5 text-left hover:bg-surface-hover md:cursor-default md:hover:bg-transparent"
          >
            <ChevronLeft aria-hidden="true" className="size-4 shrink-0 text-ink-faint md:hidden" />
            {/* The channel glyph — `#` for a public channel, a lock for a
                private one, nothing for a DM (the person's name IS the
                identity). */}
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
              {/* The second line carries whichever of the two things the
                  channel actually has: a topic for a named channel, the other
                  person for a DM. Rendered only when there is something to say
                  — an empty sub-line makes every header taller for no
                  information. */}
              {channel.data !== undefined && channelSubtitle(channel.data) !== null && (
                <span className="block min-w-0 truncate text-xs leading-tight text-ink-faint">
                  {channelSubtitle(channel.data)}
                </span>
              )}
            </span>
          </button>
          {/* In-app voice (Phase 13). Public channels cannot start a call in
              Wave 1 — the ring list comes from the channel's member tuples and
              a public channel has none, so the control is not offered rather
              than offered and refused (ai/phase-13-webrtc.md §6). Everything
              else about permission is the server's answer, not this file's. */}
          {channel.data !== undefined && channel.data.type !== 'public' && (
            <CallButton orgId={orgId} channelId={channelId} />
          )}
          {/* Channel details (members, media, retention). Icon-only — the
              member COUNT is intentionally not shown here: it is one tap
              away in the panel, and a number in the header is noise next to
              the conversation's identity. */}
          <button
            type="button"
            onClick={() => {
              setDetailsOpen((open) => !open);
            }}
            aria-label="Channel details"
            className={cn(
              'flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors',
              detailsOpen
                ? 'bg-accent/10 text-accent'
                : 'text-ink-muted hover:bg-surface-hover hover:text-ink',
            )}
          >
            <Users aria-hidden="true" className="size-4" strokeWidth={2.25} />
          </button>
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
              {timeline.map((item) =>
                item.kind === 'call' ? (
                  <CallTimelineCard
                    key={item.key}
                    entry={item.entry}
                    viewerId={viewerId}
                    personOf={personOf}
                  />
                ) : (
                  <Fragment key={item.key}>
                    {/* The "new messages" line, placed by the read CURSOR rather
                        than by counting back from the end. A count-based position
                        lands somewhere plausible and wrong the moment a message
                        is deleted or the page is partially loaded — and it does so
                        silently, which is the worst property a divider can have.

                        Suppressed when the first unread message is the viewer's
                        OWN — the cursor advances in the same beat as the send,
                        so the line would otherwise flash above your own just-sent
                        message for a render or two. "New" means "arrived while
                        you were away", and your own message is not that. */}
                    {firstUnreadId !== null &&
                      firstUnreadAuthorId !== viewerId &&
                      item.group.messages.some(
                        (message) => message.messageId === firstUnreadId,
                      ) && (
                        <div className="flex items-center gap-2" role="separator">
                          <span className="h-px flex-1 bg-danger/40" />
                          <span className="text-[11px] font-medium text-danger">New messages</span>
                          <span className="h-px flex-1 bg-danger/40" />
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
                ),
              )}
            </div>
          )}
        </div>

        {typingLabel !== null && (
          <div className="h-5 shrink-0 px-3 text-xs text-ink-faint italic sm:px-4">
            {typingLabel}
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
              viewerId={viewerId}
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
          onClose={() => {
            setDetailsOpen(false);
          }}
        />
      )}
    </div>
  );
}

/**
 * The message the "new messages" divider belongs above, or null for no divider.
 *
 * Exported-shaped as a pure function so the placement rules are testable
 * without mounting a panel — every branch below is a case where drawing the
 * line would be wrong, and each is silent if it regresses.
 *
 * `undefined` for the cursor means "not resolved yet"; `null` means "resolved,
 * and this person has never read this channel". They are deliberately different:
 * the first must not draw a line prematurely, the second must not draw one at
 * all — a divider above the very first message labels the entire conversation
 * "new", which is true and useless.
 */
export function firstUnreadAfter(
  cursor: string | null | undefined,
  messageIds: readonly string[],
): string | null {
  if (cursor === undefined || cursor === null) return null;

  const index = messageIds.indexOf(cursor);

  /* The cursor names a message outside the loaded page — older than it, or
     since deleted. Neither is a place to put a line: guessing would land it
     somewhere plausible and wrong. */
  if (index === -1) return null;

  /* Read right up to the end. Everything is read, so there is nothing new to
     separate — this is the ordinary case for a channel someone left open. */
  if (index === messageIds.length - 1) return null;

  return messageIds[index + 1] ?? null;
}

/**
 * How a direct message is named in the sidebar.
 *
 * Two people get one name; three or more get "A, B and 2 others" rather than a
 * list that truncates mid-address, because an ellipsis in the middle of an
 * email is indistinguishable from a different person's.
 */
function directLabel(
  participantIds: readonly string[],
  personOf: (userId: string) => { readonly label: string },
): string {
  if (participantIds.length === 0) return 'Direct message';

  const labels = participantIds.map((userId) => personOf(userId).label);
  const [first, second, ...rest] = labels;

  if (rest.length > 0) return `${first ?? ''}, ${second ?? ''} and ${String(rest.length)} others`;
  if (second !== undefined) return `${first ?? ''}, ${second}`;
  return first ?? 'Direct message';
}

/**
 * Appends text to the end of a document, for the composer's emoji picker.
 *
 * Writes into the LAST paragraph rather than adding a new one — picking three
 * emoji should produce one line, not three. If the document somehow has no
 * block to append to, one is created, because the server's `doc` schema
 * requires content and an empty `doc` is refused.
 *
 * The result stays inside the node/mark whitelist `RichTextDocument` enforces:
 * an emoji is ordinary text, so this adds a `text` node and nothing else. That
 * is the reason this is a document edit and not a string concatenation on
 * `bodyText` — there is no HTML path here, and this must not open one.
 */
function appendText(document: DocumentNode, text: string): DocumentNode {
  const blocks = document.content ?? [];
  const last = blocks.at(-1);

  if (last?.type !== 'paragraph') {
    return {
      ...document,
      content: [...blocks, { type: 'paragraph', content: [{ type: 'text', text }] }],
    };
  }

  const inline = last.content ?? [];
  const tail = inline.at(-1);

  /* Merged into the trailing text node when there is one, so the document does
     not accumulate a node per keystroke-equivalent. Two adjacent `text` nodes
     render identically, but they compare and diff differently, and the server
     stores what it is given. */
  const nextInline =
    tail?.type === 'text' && tail.marks === undefined
      ? [...inline.slice(0, -1), { ...tail, text: `${tail.text ?? ''}${text}` }]
      : [...inline, { type: 'text', text }];

  return {
    ...document,
    content: [...blocks.slice(0, -1), { ...last, content: nextInline }],
  };
}

/**
 * The header title for a channel.
 *
 * A DM has no name — the database refuses one, because a named DM would be
 * listable — so it is titled by WHO is in it, resolved through the same member
 * lookup every avatar uses. Falling back to "Direct message" covers the case
 * where `member:read` is denied and the lookup returns nothing: a header
 * reading "Direct message" is honest, where one reading a raw uuid is not.
 */
function channelTitle(
  channel: ChannelDetail,
  viewerId: string | null,
  personOf: (userId: string) => { readonly label: string },
): string {
  /* No emoji/`#` prefix here — the header renders a Hash or Lock glyph next
     to the name (see the ChannelPanel header), so the title itself carries
     just the name. */
  if (channel.type === 'public') return channel.name ?? '';
  if (channel.type === 'private') return channel.name ?? '';

  const others = channel.memberIds.filter((userId) => userId !== viewerId);
  if (others.length === 0) return 'Direct message';

  const labels = others.map((userId) => personOf(userId).label);
  return labels.length <= 2
    ? labels.join(', ')
    : `${labels[0] ?? ''} and ${String(labels.length - 1)} others`;
}

/**
 * The line under the title, or null when there is nothing to put there.
 *
 * Only a topic today. There is deliberately no "3 members" here — the roster is
 * a click away in the details panel, and a count in the header is the kind of
 * thing that has to be kept in sync with a live membership change for no
 * benefit.
 */
function channelSubtitle(channel: ChannelDetail): string | null {
  if (channel.archivedAt !== null) return 'Archived — no new messages can be posted.';
  return channel.topic;
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

      setTyping((current) =>
        current.includes(message.userId) ? current : [...current, message.userId],
      );
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

  const scrollRef = useRef<HTMLDivElement>(null);

  /* Bottom-anchored, the same contract as the main channel's scrollRef: a
     thread is read newest-last, so a reply landing (sent here, or arriving
     live through the socket invalidation) must be visible without scrolling.
     Deps are the reply COUNT rather than the array identity — the query's
     data reference can change on refetch without a new reply, and scrolling
     then would yank a reader mid-thread for no message. */
  const replyCount = (replies.data ?? []).length;
  useEffect(() => {
    const node = scrollRef.current;
    if (node === null) return;
    node.scrollTop = node.scrollHeight;
  }, [rootMessage.messageId, replyCount]);

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
      <div className={cn('flex flex-col gap-1', isOwn && 'items-end')}>
        <span className="px-1 text-xs font-medium text-ink-muted">{label}</span>
        <div
          className={cn(
            /* text-sm: same 14px floor as the main channel's bubbles — a
               thread is a chat surface, not a document surface. */
            'max-w-full rounded-2xl px-3 py-1.5 text-sm shadow-sm',
            isOwn ? 'bg-accent text-accent-ink' : 'bg-surface-raised text-ink',
            /* Same as the main channel's bubble — see the comment there. */
            isOwn && 'rich-text-on-accent',
          )}
        >
          <RichTextView value={message.body} bare />
          {/* Same bottom-right timestamp as the main channel's bubbles — the
              thread is the same WhatsApp-style surface, so the metadata sits
              in the same corner rather than drifting to the left edge. */}
          <div
            className={cn(
              'mt-0.5 flex items-center justify-end gap-1 text-[10px] leading-none',
              isOwn ? 'text-accent-ink/70' : 'text-ink-faint',
            )}
          >
            <span>{formatTime(message.createdAt)}</span>
            {message.editedAt !== null && <span>edited</span>}
          </div>
        </div>
      </div>
    );
  };

  /* Below `md` this panel is a full-width overlay on top of the message
     column (the channel pane is the `relative` parent, see `ChannelPanel`)
     rather than a fixed-width sibling squeezing it — the phone has no room
     for a 320px sidebar next to a conversation. `md:static md:w-80` restores
     the side-by-side layout above the breakpoint. */
  return (
    <aside className="absolute inset-y-0 right-0 z-30 flex w-full flex-col border-l border-line bg-surface-raised md:static md:w-80">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-line px-3">
        <h3 className="text-sm font-medium text-ink">Thread</h3>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close thread"
          className="rounded p-1 text-ink-faint hover:bg-surface-hover hover:text-ink"
        >
          <X aria-hidden="true" className="size-4" strokeWidth={2} />
        </button>
      </header>

      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-3">
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
          className="text-sm"
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
  canModerate,
  viewerId,
  authorLabel,
  editingId,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  editPending,
  onDelete,
  onHide,
  reactionsByMessage,
  attachmentsByMessage,
  previewsByMessage,
  savedIds,
  onToggleSave,
  personOf,
  onToggleReaction,
  pinnedIds,
  onTogglePin,
  replyCounts,
  onOpenThread,
}: {
  readonly group: MessageGroup;
  /** From the server (`capabilitiesFor`) — never computed in the client. */
  readonly canModerate: boolean;
  readonly viewerId: string | null;
  readonly authorLabel: string | null;
  readonly editingId: string | null;
  readonly onStartEdit: (messageId: string) => void;
  readonly onCancelEdit: () => void;
  readonly onSaveEdit: (messageId: string, body: DocumentNode) => void;
  readonly editPending: boolean;
  readonly onDelete: (messageId: string) => void;
  /** "Remove for me" — hides the message from this viewer's own list. */
  readonly onHide: (messageId: string) => void;
  readonly reactionsByMessage: Map<string, Map<string, string[]>>;
  readonly attachmentsByMessage: ReadonlyMap<string, readonly MessageAttachment[]>;
  readonly savedIds: ReadonlySet<string>;
  readonly onToggleSave: (messageId: string, saved: boolean) => void;
  readonly previewsByMessage: ReadonlyMap<string, readonly MessagePreview[]>;
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

      {/* 85% on a phone, 75% from `sm` up.
          A single 75% cap reads as a comfortable margin on a desktop and as a
          cramped column on a phone, because the fixed costs around it do not
          scale: the avatar gutter (`w-6`) and its gap take 2rem, and the list's
          own horizontal padding takes another, before the percentage applies to
          what's left. On a 375px viewport that is 75% of ~19rem rather than 75%
          of the screen — bubbles a third of the width of the device, wrapping
          every few words. Widening the cap below `sm` is what every chat
          product does for the same arithmetic; the point of the cap at all is
          to keep the opposite edge visible so left and right bubbles stay
          distinguishable, and 85% still does that. */}
      <div
        className={cn(
          'flex min-w-0 max-w-[85%] flex-col gap-0.5 sm:max-w-[75%]',
          isOwn && 'items-end',
        )}
      >
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
            canModerate={canModerate}
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
            onHide={() => {
              onHide(message.messageId);
            }}
            reactions={reactionsByMessage.get(message.messageId) ?? new Map()}
            attachments={attachmentsByMessage.get(message.messageId) ?? []}
            isSaved={savedIds.has(message.messageId)}
            onToggleSave={(saved) => {
              onToggleSave(message.messageId, saved);
            }}
            previews={previewsByMessage.get(message.messageId) ?? []}
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
  canModerate,
  isOwn,
  isFirstInGroup,
  isLastInGroup,
  isEditing,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  editPending,
  onDelete,
  onHide,
  reactions,
  attachments,
  previews,
  isSaved,
  onToggleSave,
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
  readonly canModerate: boolean;
  readonly isFirstInGroup: boolean;
  readonly isLastInGroup: boolean;
  readonly isEditing: boolean;
  readonly onStartEdit: () => void;
  readonly onCancelEdit: () => void;
  readonly onSaveEdit: (body: DocumentNode) => void;
  readonly editPending: boolean;
  readonly onDelete: () => void;
  /** "Remove for me" — hides this message from the viewer's own list only. */
  readonly onHide: () => void;
  readonly reactions: Map<string, string[]>;
  readonly attachments: readonly MessageAttachment[];
  readonly isSaved: boolean;
  readonly onToggleSave: (saved: boolean) => void;
  readonly previews: readonly MessagePreview[];
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
    <div className={cn('group/message relative flex flex-col gap-1', isOwn && 'items-end')}>
      {/* The bubble's wrapper: a row with exactly one in-flow child (the
          bubble) whose only other job is to be the positioning context for
          the hover toolbar's `absolute top-full` — the toolbar floats BELOW
          the bubble, so it is out of flow and never widens this row. `flex`
          (not a plain block) is what keeps the bubble's `min-w-0` a real
          bound against its widest child (see the bubble's own comment). */}
      <div className="relative flex items-end">
        <div
          className={cn(
            /* `min-w-0` because the bubble is a flex item whose automatic
               minimum size would otherwise be its widest child, and two of
               its children are wider than a phone: a link preview card is
               `max-w-md` (28rem — a cap, but one no small viewport can
               honour), and an attachment row's filename is `truncate`, which
               is `white-space: nowrap` and therefore contributes the WHOLE
               filename to min-content even though it renders as an ellipsis.
               Both are clipped or capped for their own layout and neither can
               shrink the box that contains them. Bounding the bubble here
               instead means every child resolves against the 75% the message
               column actually has, rather than the bubble growing to fit them
               and taking the message list's horizontal scrollbar with it. */
            /* `text-sm` — 14px, the size every chat product (Slack, WhatsApp,
               Discord) sets its message body to. The base 16px is a reading
               size for document surfaces; a message column at 16px reads as
               shouting, and the bubble is the container that owns the size. */
            'min-w-0 rounded-2xl px-3 py-1.5 text-sm shadow-sm',
            isOwn ? 'bg-accent text-accent-ink' : 'bg-surface-raised text-ink',
            /* Links inside the viewer's own bubble would otherwise be the
               accent hue on an accent fill — invisible (see styles.css's
               `.rich-text-on-accent` rule). Hanging it here scopes that
               override to the accent bubble only; the receiver's side keeps
               the normal accent link color on the light surface. */
            isOwn && 'rich-text-on-accent',
            cornerClass,
          )}
        >
          <RichTextView value={message.body} bare />
          {/* The timestamp sits bottom-RIGHT inside the bubble, under the last
              text line, in a muted tint of the bubble's own colour — metadata
              about the bubble, not a second row of chrome (WhatsApp's own
              placement; right-aligned in both the viewer's and others'). */}
          <div
            className={cn(
              'mt-0.5 flex items-center justify-end gap-1 text-[10px] leading-none',
              isOwn ? 'text-accent-ink/70' : 'text-ink-faint',
            )}
          >
            <span>{formatTime(message.createdAt)}</span>
            {message.editedAt !== null && <span>edited</span>}
            {pinned && <Pin aria-label="Pinned" className="size-2.5" strokeWidth={2.25} />}
          </div>
        </div>

        {/* Hover actions float over the bubble's TOP edge, aligned to its
            outer corner (`right-0` for the viewer's own bubble, `left-0` for
            everyone else's) — the Slack placement. Chosen over "below the
            bubble" for a concrete reason: reactions and the reply count live
            BELOW the bubble, so a toolbar parked there covers the exact
            things a hovering reader is about to click. At the top it
            transiently overlaps the first line of the message's own text,
            which is the trade Slack itself makes and nothing interactive is
            ever hidden. Floating, not in-flow: the row appears on hover
            only, and reserving space would push reactions and the next
            message down for every message nobody is hovering.

            `pointer-events-none` is not cosmetic — it is the other half of
            the fix. An invisible `opacity-0` element still intercepts
            clicks, so a toolbar parked below the bubble was blocking the
            reaction pills beneath it even when it could not be seen.
            Click-through while hidden, interactive only once actually
            shown. The same `opacity-0 group-hover:opacity-100` shape
            `card-tile.tsx`'s quick actions use, visible on hover or
            keyboard focus rather than as permanent clutter on every bubble.

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
            'pointer-events-none absolute top-0 z-20 flex items-center gap-0.5 rounded-lg border border-line bg-surface-raised px-1 py-0.5 opacity-0 shadow-md transition-opacity',
            isOwn ? 'right-0' : 'left-0',
            'group-hover/message:pointer-events-auto group-hover/message:opacity-100 group-focus-within/message:pointer-events-auto group-focus-within/message:opacity-100',
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
          <Button
            size="sm"
            variant="ghost"
            className="h-5 px-1 text-[11px]"
            onClick={() => {
              onToggleSave(isSaved);
            }}
          >
            {isSaved ? 'Unsave' : 'Save'}
          </Button>
          {/* Editing is AUTHORSHIP, which the client knows for certain — there
              is no permission that overrides it, so no server answer is needed. */}
          {isOwn && (
            <Button
              size="sm"
              variant="ghost"
              className="h-5 px-1 text-[11px]"
              onClick={onStartEdit}
            >
              Edit
            </Button>
          )}
          {/* Deleting is now TWO actions, Slack-style. "Remove for me" is
              offered to everyone — it only changes the viewer's own list, so
              it can never be refused. "Remove for everyone" is authorship OR
              moderation, and the moderation half is the server's decision
              (`capabilitiesFor`), not recomputed here — but the option is
              hidden rather than shown-and-refused because a button whose only
              outcome is an error toast is not a control. */}
          <DeleteMenu isOwn={isOwn} canModerate={canModerate} onHide={onHide} onDelete={onDelete} />
        </div>
      </div>

      {/* Files and link previews sit BELOW the bubble rather than inside it:
          a preview card is about something the message points at, not part of
          what was written, and putting it inside would make an edit look like
          it changed the card too. */}
      <MessageAttachments attachments={attachments} />
      <MessagePreviews previews={previews} />

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

/**
 * The bubble's delete control — Slack's two-way delete in one popover.
 *
 * "Remove for me" (hide) is always available: it writes a per-viewer hide
 * row and the message stays live for everyone else, so there is nothing to
 * moderate. "Remove for everyone" (tombstone) is authorship or moderation —
 * the moderation half is the server's `capabilitiesFor` answer, not
 * recomputed here.
 */
function DeleteMenu({
  isOwn,
  canModerate,
  onHide,
  onDelete,
}: {
  readonly isOwn: boolean;
  readonly canModerate: boolean;
  readonly onHide: () => void;
  readonly onDelete: () => void;
}) {
  const canRemoveForEveryone = isOwn || canModerate;
  return (
    <PopoverRoot>
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost" className="h-5 px-1 text-[11px]">
          Delete
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-64 p-1.5">
        <p className="px-1.5 pb-1 pt-0.5 text-xs font-medium text-ink-muted">Delete message</p>
        <div className="flex flex-col gap-0.5">
          <button
            type="button"
            onClick={onHide}
            className="flex flex-col items-start rounded px-1.5 py-1.5 text-left hover:bg-surface-hover"
          >
            <span className="text-sm font-medium text-ink">Remove for me</span>
            <span className="text-xs text-ink-faint">
              Only you won&apos;t see this message anymore.
            </span>
          </button>
          {canRemoveForEveryone && (
            <button
              type="button"
              onClick={onDelete}
              className="flex flex-col items-start rounded px-1.5 py-1.5 text-left hover:bg-surface-hover"
            >
              <span className="text-sm font-medium text-danger">Remove for everyone</span>
              <span className="text-xs text-ink-faint">
                {isOwn
                  ? 'Delete this message for everyone in the conversation.'
                  : 'Only available to moderators. Removes the message for everyone.'}
              </span>
            </button>
          )}
        </div>
      </PopoverContent>
    </PopoverRoot>
  );
}

/**
 * The reaction bar under a bubble — one pill per emoji, with its count.
 *
 * Each pill is a popover trigger: clicking it shows WHO reacted (the names the
 * bar itself deliberately does not show, so the row stays scannable) and — for
 * the viewer's own reaction — the same click that opened it can be repeated to
 * remove it. The viewer's own reaction is additionally marked on the pill
 * itself: filled accent + a check, so "did I react?" is answered by the bar
 * without opening anything, and "who else did?" is one click away.
 */
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
      {[...reactions.entries()].map(([emoji, userIds]) => {
        const mine = viewerId !== null && userIds.includes(viewerId);
        return (
          <PopoverRoot key={emoji}>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label={`${emoji} — ${String(userIds.length)} ${userIds.length === 1 ? 'reaction' : 'reactions'}`}
                className={cn(
                  'flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-xs transition-colors',
                  mine
                    ? 'border-accent bg-accent text-accent-ink'
                    : 'border-line bg-surface-raised text-ink-muted hover:bg-surface-hover',
                )}
              >
                <span>{emoji}</span>
                <span>{userIds.length}</span>
                {mine && <Check aria-hidden="true" className="size-3" strokeWidth={2.5} />}
              </button>
            </PopoverTrigger>
            <PopoverContent side="top" align="start" className="w-52 p-1.5">
              <p className="px-1.5 pb-1 pt-0.5 text-xs font-medium text-ink-muted">
                {emoji} — {userIds.length} {userIds.length === 1 ? 'reaction' : 'reactions'}
              </p>
              <ul className="flex flex-col">
                {userIds.map((userId) => (
                  <li
                    key={userId}
                    className={cn(
                      'flex items-center justify-between rounded px-1.5 py-1 text-sm text-ink',
                      userId === viewerId && 'font-medium text-accent',
                    )}
                  >
                    <span>{personOf(userId).label}</span>
                    {userId === viewerId && <span className="text-xs text-ink-faint">You</span>}
                  </li>
                ))}
              </ul>
              {mine && (
                <button
                  type="button"
                  onClick={() => {
                    onToggle(emoji);
                  }}
                  className="mt-1 w-full rounded border-t border-line px-1.5 pt-1.5 text-left text-xs font-medium text-danger"
                >
                  Remove your reaction
                </button>
              )}
            </PopoverContent>
          </PopoverRoot>
        );
      })}
    </div>
  );
}

function EmojiPickerButton({ onPick }: { readonly onPick: (emoji: string) => void }) {
  return (
    <PopoverRoot>
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost" className="h-5 px-1 text-[11px]">
          React
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" className="flex gap-1 p-1.5 text-base">
        {QUICK_REACTIONS.map((emoji) => (
          <PopoverClose asChild key={emoji}>
            <button
              type="button"
              onClick={() => {
                onPick(emoji);
              }}
              className="rounded p-1 hover:bg-surface-hover"
            >
              {emoji}
            </button>
          </PopoverClose>
        ))}
      </PopoverContent>
    </PopoverRoot>
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

/**
 * Groups rows that carry a `messageId` by that id.
 *
 * Shared by attachments and previews, which are the same shape of problem: a
 * flat list keyed to the page of messages being rendered, looked up per bubble.
 */
function groupByMessage<T extends { readonly messageId: string }>(
  rows: readonly T[],
): ReadonlyMap<string, readonly T[]> {
  const byMessage = new Map<string, T[]>();
  for (const row of rows) {
    byMessage.set(row.messageId, [...(byMessage.get(row.messageId) ?? []), row]);
  }
  return byMessage;
}

/** A one-paragraph document, for text this app composes rather than a person. */
function textDocument(text: string): DocumentNode {
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
}

/**
 * The plain text of a document, for slash-command parsing.
 *
 * Commands are decided on TEXT, never on the node tree: `/topic` typed into a
 * rich editor may arrive as several text nodes if the person paused, and a
 * parser reading only the first would see `/top`.
 */
function flattenDocument(node: DocumentNode): string {
  if (typeof node.text === 'string') return node.text;
  return (node.content ?? []).map(flattenDocument).join('');
}

/**
 * The paperclip.
 *
 * A hidden `<input type="file">` driven by a button, which is the standard way
 * to get a styled control — the native one cannot be styled and reads as a
 * foreign object in the composer. The input is reset after every pick so
 * choosing the SAME file twice fires `change` both times.
 */
function AttachFileButton({
  disabled,
  onPick,
}: {
  readonly disabled: boolean;
  readonly onPick: (file: File) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED_FILE_TYPES}
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file !== undefined) onPick(file);
          event.target.value = '';
        }}
      />
      <Button
        size="sm"
        variant="ghost"
        disabled={disabled}
        aria-label="Attach a file"
        onClick={() => {
          inputRef.current?.click();
        }}
      >
        📎
      </Button>
    </>
  );
}

/**
 * The slash-command menu.
 *
 * Shown only while the draft is a bare command word — the moment an argument is
 * typed the list stops being useful and starts covering the composer. Purely an
 * affordance: typing the command by hand works identically, because `submit`
 * parses the text rather than reading a selection made here.
 */
function SlashCommandMenu({ draft }: { readonly draft: DocumentNode }) {
  const text = flattenDocument(draft);
  if (!text.startsWith('/') || text.includes(' ')) return null;

  const matches = matchingCommands(text);
  if (matches.length === 0) return null;

  return (
    <ul className="mb-1 overflow-hidden rounded border border-line bg-surface-raised text-xs shadow-sm">
      {matches.map((command) => (
        <li key={command.name} className="flex gap-2 px-2 py-1">
          <span className="font-mono text-ink">{command.hint}</span>
          <span className="text-ink-faint">{command.description}</span>
        </li>
      ))}
    </ul>
  );
}
