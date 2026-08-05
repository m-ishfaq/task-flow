import { useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Popover from '@radix-ui/react-popover';
import type { ChannelId, MessageId, UserId } from '@taskflow/contracts';
import { useSession } from '../../lib/session.js';
import { cn } from '../../lib/cn.js';
import { useToast } from '../../lib/toast-context.js';
import { formatRelative } from '../../lib/format.js';
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
import {
  channelQuery,
  channelsQuery,
  createChannel,
  deleteMessage,
  editMessage,
  invalidateChannels,
  invalidateMessages,
  messagesQuery,
  openDirectMessage,
  sendMessage,
  type ChannelSummary,
  type Message,
} from './api.js';
import { useChannelRoom } from './use-channel-room.js';

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
  onSelect,
}: {
  readonly channel: ChannelSummary;
  readonly label: string;
  readonly active: boolean;
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
        <span className="truncate">
          {channel.type === 'public' ? '# ' : channel.type === 'private' ? '🔒 ' : ''}
          {label}
        </span>
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

  const submit = (): void => {
    if (isEmptyDocument(draft)) return;
    const body = draft;
    setDraft(EMPTY_DOCUMENT);
    send.mutate(body);
  };

  const topLevel = (messages.data ?? []).filter((message) => message.parentMessageId === null);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
        <h2 className="truncate text-sm font-medium text-ink">
          {channel.data === undefined
            ? '…'
            : channel.data.type === 'public'
              ? `# ${channel.data.name ?? ''}`
              : channel.data.type === 'private'
                ? `🔒 ${channel.data.name ?? ''}`
                : (channel.data.name ?? 'Direct message')}
        </h2>
      </header>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {messages.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-10 w-3/4" />
            <Skeleton className="h-10 w-1/2" />
          </div>
        ) : topLevel.length === 0 ? (
          <Empty
            title="No messages yet"
            description="Say something to get the conversation going."
          />
        ) : (
          topLevel.map((message) => (
            <MessageRow
              key={message.messageId}
              message={message}
              viewerId={viewerId}
              authorLabel={message.authorId === null ? null : personOf(message.authorId).label}
              isEditing={editing === message.messageId}
              onStartEdit={() => {
                setEditing(message.messageId);
              }}
              onCancelEdit={() => {
                setEditing(null);
              }}
              onSaveEdit={(body) => {
                edit.mutate({ messageId: message.messageId as MessageId, body });
              }}
              editPending={edit.isPending}
              onDelete={() => {
                remove.mutate(message.messageId as MessageId);
              }}
            />
          ))
        )}
      </div>

      <div className="shrink-0 border-t border-line px-4 py-3">
        <RichTextEditor
          value={draft}
          placeholder="Write a message…"
          onChange={setDraft}
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
  );
}

function MessageRow({
  message,
  viewerId,
  authorLabel,
  isEditing,
  onStartEdit,
  onCancelEdit,
  onSaveEdit,
  editPending,
  onDelete,
}: {
  readonly message: Message;
  readonly viewerId: string | null;
  readonly authorLabel: string | null;
  readonly isEditing: boolean;
  readonly onStartEdit: () => void;
  readonly onCancelEdit: () => void;
  readonly onSaveEdit: (body: DocumentNode) => void;
  readonly editPending: boolean;
  readonly onDelete: () => void;
}) {
  const isAuthor = message.authorId !== null && message.authorId === viewerId;

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5 text-[11px] text-ink-faint">
        {message.authorId !== null && (
          <Avatar userId={message.authorId} label={authorLabel ?? message.authorId} size="xs" />
        )}
        <span className="font-medium text-ink-muted">{authorLabel ?? 'Unknown'}</span>
        <span>{formatRelative(message.createdAt)}</span>
        {message.editedAt !== null && <span>(edited)</span>}
      </div>

      {message.deletedAt !== null ? (
        <p className="text-xs text-ink-faint italic">This message was deleted.</p>
      ) : isEditing ? (
        <EditMessage
          initial={message.body}
          pending={editPending}
          onCancel={onCancelEdit}
          onSave={onSaveEdit}
        />
      ) : (
        <>
          <RichTextView value={message.body} />
          <div className="flex gap-1">
            {/* Edit is author-only with no override, same reasoning as
                Work's comments (CLAUDE.md, §8.2) — nobody else's edit control
                would ever succeed. Delete stays visible to everyone; a
                moderator without the permission gets an honest FORBIDDEN. */}
            {isAuthor && (
              <Button
                size="sm"
                variant="ghost"
                className="h-5 px-1 text-[11px]"
                onClick={onStartEdit}
              >
                Edit
              </Button>
            )}
            <Button size="sm" variant="ghost" className="h-5 px-1 text-[11px]" onClick={onDelete}>
              Delete
            </Button>
          </div>
        </>
      )}
    </div>
  );
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
