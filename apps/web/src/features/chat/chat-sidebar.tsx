import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock, Pin } from 'lucide-react';
import { PopoverContent, PopoverRoot, PopoverTrigger } from '@taskflow/ui';
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
import {
  allPinsQuery,
  channelsQuery,
  createChannel,
  invalidateAllPins,
  invalidateChannels,
  invalidatePins,
  invalidateSaved,
  openDirectMessage,
  savedQuery,
  unpinMessage,
  unreadCountsQuery,
  unsaveMessage,
  type ChannelSummary,
  type PinnedMessageSummary,
  type SavedMessage,
} from './api.js';
import { directLabel } from './chat-helpers.js';

/* -------------------------------------------------------------------------- *
 * Channel list
 * -------------------------------------------------------------------------- */

export function ChannelListPanel({
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
        'shrink-0 flex-col overflow-y-auto border-r border-line/50 bg-surface-raised md:flex md:w-64',
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
      <div className="flex flex-col gap-0.5 border-b border-line/50 px-1.5 py-1.5">
        <PinnedMessagesButton orgId={orgId} onOpenChannel={onSelect} />
        <SavedMessagesButton orgId={orgId} onOpenChannel={onSelect} />
      </div>

      <div className="flex items-center justify-between px-3 pt-3 pb-1.5">
        <h2 className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
          Channels
        </h2>
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

      <div className="flex items-center justify-between px-3 pt-3 pb-1.5">
        <h2 className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
          Direct messages
        </h2>
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
          'flex w-full items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors duration-[var(--motion-fast)]',
          active
            ? 'bg-accent/15 text-accent'
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
